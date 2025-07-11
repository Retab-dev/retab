import { z } from 'zod';
import { ChatCompletionRetabMessageSchema } from '../chat.js';
import { generateSchemaDataId, generateSchemaId, loadJsonSchema } from '../../utils/json_schema_utils.js';
import { zodToJsonSchema } from '../../utils/zod_to_json_schema.js';

export const PartialSchemaSchema = z.object({
  object: z.literal('schema'),
  created_at: z.string().datetime(),
  json_schema: z.record(z.any()).default({}),
  strict: z.boolean().default(true),
});
export type PartialSchema = z.infer<typeof PartialSchemaSchema>;

export const PartialSchemaChunkSchema = z.object({
  object: z.literal('schema.chunk'),
  created_at: z.string().datetime(),
  delta_json_schema_flat: z.record(z.any()).default({}),
  streaming_error: z.custom<import('../standards.js').ErrorDetail>().nullable().optional(),
});
export type PartialSchemaChunk = z.infer<typeof PartialSchemaChunkSchema>;

export const SchemaSchema = PartialSchemaSchema.extend({}).transform((data) => new Schema(data));

export class Schema implements PartialSchema {
  object: 'schema' = 'schema';
  created_at: string;
  json_schema: Record<string, any> = {};
  strict: boolean = true;
  private _zodModel?: z.ZodType<any>;

  constructor(data: { 
    json_schema?: Record<string, any> | string; 
    pydanticModel?: any; 
    zod_model?: z.ZodType<any>; 
    system_prompt?: string; 
    reasoning_prompts?: Record<string, string> 
  }) {
    this.created_at = new Date().toISOString();
    
    // Validate input like Python version
    if (data.json_schema && data.pydanticModel) {
      throw new Error('Cannot provide both json_schema and pydanticModel');
    }
    
    if (!data.json_schema && !data.pydanticModel && !data.zod_model) {
      throw new Error('Must provide either json_schema, pydanticModel, or zod_model');
    }
    
    if (data.json_schema) {
      this.json_schema = loadJsonSchema(data.json_schema);
    } else if (data.pydanticModel) {
      // For pydantic models, we expect the model to have a model_json_schema() method
      // In Node.js context, this would be a pre-serialized schema from Python
      if (typeof data.pydanticModel === 'object' && data.pydanticModel.model_json_schema) {
        this.json_schema = data.pydanticModel.model_json_schema();
      } else if (typeof data.pydanticModel === 'object' && data.pydanticModel.schema) {
        this.json_schema = data.pydanticModel.schema;
      } else {
        throw new Error('pydanticModel must have a model_json_schema() method or schema property');
      }
    } else if (data.zod_model) {
      this._zodModel = data.zod_model;
      // Convert Zod to JSON Schema using proper converter
      this.json_schema = zodToJsonSchema(data.zod_model);
      
      // Add system prompt if provided
      if (data.system_prompt) {
        this.json_schema['X-SystemPrompt'] = data.system_prompt;
      }
      
      // Add reasoning prompts if provided
      if (data.reasoning_prompts) {
        for (const [field, prompt] of Object.entries(data.reasoning_prompts)) {
          if (this.json_schema.properties && this.json_schema.properties[field]) {
            this.json_schema.properties[field]['X-ReasoningPrompt'] = prompt;
          }
        }
      }
    }
  }

  get dataId(): string {
    return generateSchemaDataId(this.json_schema);
  }

  get id(): string {
    return generateSchemaId(this.json_schema);
  }

  get inference_json_schema(): Record<string, any> {
    // Returns the schema formatted for structured output with OpenAI requirements
    if (this.strict) {
      // For strict schemas, convert to OpenAI-compatible format
      const inferenceSchema = this.jsonSchemaToStrictOpenaiSchema(JSON.parse(JSON.stringify(this._reasoningObjectSchema)));
      if (typeof inferenceSchema !== 'object' || inferenceSchema === null) {
        throw new Error('Validation Error: The inference_json_schema is not a dict');
      }
      return inferenceSchema;
    } else {
      // For non-strict schemas, return a deep copy of the reasoning schema without strict modifications
      return JSON.parse(JSON.stringify(this._reasoningObjectSchema));
    }
  }

  get inferenceJsonSchema(): Record<string, any> {
    // Alias for backwards compatibility
    return this.inference_json_schema;
  }

  get openaiMessages(): any[] {
    // Returns messages formatted for OpenAI's API
    return this.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  get anthropicSystemPrompt(): string {
    return 'Return your response as a JSON object following the provided schema.' + this.systemPrompt;
  }

  get anthropicMessages(): any[] {
    // Returns messages in Anthropic's Claude format
    return this.messages.slice(1); // Skip system message
  }

  get geminiSystemPrompt(): string {
    return this.systemPrompt;
  }

  get geminiMessages(): any[] {
    // Returns messages formatted for Google's Gemini API
    return this.messages.slice(1);
  }

  get inferenceGeminiJsonSchema(): Record<string, any> {
    // Convert schema for Gemini compatibility (no anyOf, etc.)
    const schema = { ...this._reasoningObjectSchema };
    
    // Remove unsupported Gemini fields recursively
    const removeUnsupportedFields = (obj: any): any => {
      if (typeof obj !== 'object' || obj === null) return obj;
      
      if (Array.isArray(obj)) {
        return obj.map(removeUnsupportedFields);
      }
      
      const result = { ...obj };
      
      // Remove Gemini-unsupported fields
      delete result.anyOf;
      delete result.oneOf;
      delete result.allOf;
      delete result.not;
      delete result.if;
      delete result.then;
      delete result.else;
      
      // Recursively process nested objects
      Object.keys(result).forEach(key => {
        if (typeof result[key] === 'object' && result[key] !== null) {
          result[key] = removeUnsupportedFields(result[key]);
        }
      });
      
      return result;
    };
    
    return removeUnsupportedFields(schema);
  }

  get inferenceTypescriptInterface(): string {
    // Returns TypeScript interface representation of the inference schema
    return this.jsonSchemaToTypescriptInterface(this._reasoningObjectSchema);
  }

  get inferenceNlpDataStructure(): string {
    // Returns NLP data structure representation of the inference schema
    return this.jsonSchemaToNlpDataStructure(this._reasoningObjectSchema);
  }

  get developerSystemPrompt(): string {
    return `
# General Instructions

You are an expert in data extraction and structured data outputs.

When provided with a **JSON schema** and a **document**, you must:

1. Carefully extract all relevant data from the provided document according to the given schema.
2. Return extracted data strictly formatted according to the provided schema.
3. Make sure that the extracted values are **UTF-8** encodable strings.
4. Avoid generating bytes, binary data, base64 encoded data, or other non-UTF-8 encodable data.

---

## Date and Time Formatting

When extracting date, time, or datetime values:

- **Always use ISO format** for dates and times (e.g., "2023-12-25", "14:30:00", "2023-12-25T14:30:00Z")
- **Include timezone information** when available (e.g., "2023-12-25T14:30:00+02:00")
- **Use UTC timezone** when timezone is not specified or unclear (e.g., "2023-12-25T14:30:00Z")
- **Maintain precision** as found in the source document (seconds, milliseconds if present)

---

## Handling Missing and Nullable Fields

### Nullable Leaf Attributes

- If valid data is missing or not explicitly present, set leaf attributes explicitly to \`null\`.
- **Do NOT** use empty strings (\`""\`), placeholder values, or fabricated data.

### Nullable Nested Objects

- If an entire nested object's data is missing or incomplete, **do NOT** set the object itself to \`null\`.
- Keep the object structure fully intact, explicitly setting each leaf attribute within to \`null\`.
- This preserves overall structure and explicitly communicates exactly which fields lack data.

---

## Reasoning Fields

Your schema includes special reasoning fields (\`reasoning___*\`) used exclusively to document your extraction logic. These fields are for detailed explanations and will not appear in final outputs.

You MUST include these details explicitly in your reasoning fields:

- **Explicit Evidence**: Quote specific lines or phrases from the document confirming your extraction.
- **Decision Justification**: Clearly justify why specific data was chosen or rejected.
- **Calculations/Transformations**: Document explicitly any computations, unit conversions, or normalizations.
- **Alternative Interpretations**: Explicitly describe any alternative data interpretations considered and why you rejected them.
- **Confidence and Assumptions**: Clearly state your confidence level and explicitly articulate any assumptions.

---

## Source Fields

Some leaf fields require you to explicitly provide the source of the data (verbatim from the document).
The idea is to simply provide a verbatim quote from the document, without any additional formatting or commentary, keeping it as close as possible to the original text.
Make sure to reasonably include some surrounding text to provide context about the quote.

You can easily identify the fields that require a source by the \`quote___[attributename]\` naming pattern.

---

# User Defined System Prompt

`;
  }

  get userSystemPrompt(): string {
    return this.json_schema['X-SystemPrompt'] || '';
  }

  get schemaSystemPrompt(): string {
    return (
      this.inferenceNlpDataStructure + 
      '\n---\n' + 
      '## Expected output schema as a TypeScript interface for better readability:\n\n' + 
      this.inferenceTypescriptInterface
    );
  }

  get systemPrompt(): string {
    return this.developerSystemPrompt + '\n\n' + this.userSystemPrompt + '\n\n' + this.schemaSystemPrompt;
  }

  get title(): string {
    return this.json_schema.title || 'NoTitle';
  }

  private get _expandedObjectSchema(): Record<string, any> {
    // Returns schema with all references expanded inline
    return this.expandRefs(JSON.parse(JSON.stringify(this.json_schema)));
  }

  private get _reasoningObjectSchema(): Record<string, any> {
    // Returns schema with inference-specific modifications (reasoning fields added)
    return this.createReasoningSchema(JSON.parse(JSON.stringify(this._expandedObjectSchema)));
  }


  get messages(): z.infer<typeof ChatCompletionRetabMessageSchema>[] {
    return [{ role: 'developer', content: this.systemPrompt }];
  }

  get openai_messages(): Array<{ role: string; content: string }> {
    return [{ role: 'developer', content: this.systemPrompt }];
  }

  get zod_model(): z.ZodType<any> {
    if (this._zodModel) {
      return this._zodModel;
    }
    // Convert JSON schema to basic Zod schema for validation
    return z.object({}).passthrough();
  }

  getPatternAttribute(pattern: string, attribute: 'X-FieldPrompt' | 'X-ReasoningPrompt' | 'type'): string | null {
    return this._getPatternAttribute(pattern, attribute);
  }

  setPatternAttribute(
    pattern: string, 
    attribute: 'X-FieldPrompt' | 'X-ReasoningPrompt' | 'X-SystemPrompt' | 'description', 
    value: string
  ): void {
    this._setPatternAttribute(pattern, attribute, value);
  }

  save(path: string): void {
    // Save JSON schema to file
    try {
      const fs = require('fs');
      fs.writeFileSync(path, JSON.stringify(this.json_schema, null, 2), 'utf8');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        throw new Error('save() method not available in browser environment');
      }
      throw error;
    }
  }

  static validate(data: any): Schema {
    return new Schema(data);
  }

  private createReasoningSchema(schema: Record<string, any>): Record<string, any> {
    // Add reasoning fields to the schema structure, matching Python implementation
    const processedSchema = this.insertReasoningFieldsInner(JSON.parse(JSON.stringify(schema)));
    
    // Add root reasoning if schema has X-ReasoningPrompt
    const rootReasoning = processedSchema.rootReasoning;
    if (rootReasoning && processedSchema.updatedSchema.type === 'object') {
      if (!processedSchema.updatedSchema.properties) {
        processedSchema.updatedSchema.properties = {};
      }
      
      // Add reasoning___root field
      processedSchema.updatedSchema.properties.reasoning___root = {
        type: 'string',
        description: rootReasoning
      };
      
      // Add to required fields if needed
      if (processedSchema.updatedSchema.required) {
        processedSchema.updatedSchema.required.push('reasoning___root');
      }
    }

    // Clean custom fields like Python implementation
    return this.cleanSchema(processedSchema.updatedSchema, { removeCustomFields: true });
  }

  private insertReasoningFieldsInner(schema: Record<string, any>): { updatedSchema: Record<string, any>, rootReasoning: string | null } {
    // Extract X-ReasoningPrompt from this node
    const reasoningDesc = schema['X-ReasoningPrompt'] || null;
    delete schema['X-ReasoningPrompt'];

    const nodeType = schema.type;

    // Process children recursively
    if (nodeType === 'object' && schema.properties) {
      const newProps: Record<string, any> = {};
      
      for (const [propertyKey, propertyValue] of Object.entries(schema.properties)) {
        const { updatedSchema: updatedProp, rootReasoning: childReasoning } = this.insertReasoningFieldsInner(propertyValue as Record<string, any>);
        newProps[propertyKey] = updatedProp;
        
        // ALWAYS add reasoning field for every property (Python behavior)
        const reasoningDescription = childReasoning || `Reasoning for ${propertyKey}`;
        newProps[`reasoning___${propertyKey}`] = {
          type: 'string',
          description: reasoningDescription
        };
        
        // Add to required if property is required
        if (schema.required && schema.required.includes(propertyKey)) {
          if (!schema.required.includes(`reasoning___${propertyKey}`)) {
            schema.required.push(`reasoning___${propertyKey}`);
          }
        }
      }
      
      schema.properties = newProps;
    } else if (nodeType === 'array' && schema.items) {
      // Process array items
      const { updatedSchema: updatedItems, rootReasoning: itemReasoning } = this.insertReasoningFieldsInner(schema.items);
      schema.items = updatedItems;
      
      // Always add reasoning___item if items are objects (Python behavior)
      if (updatedItems.type === 'object') {
        if (!updatedItems.properties) {
          updatedItems.properties = {};
        }
        
        // Add reasoning___item as first property
        const reasoningKey = 'reasoning___item';
        const reasoningDescription = itemReasoning || 'Reasoning for this item';
        const newProperties: Record<string, any> = {
          [reasoningKey]: {
            type: 'string',
            description: reasoningDescription
          }
        };
        
        // Add existing properties
        Object.assign(newProperties, updatedItems.properties);
        updatedItems.properties = newProperties;
      }
    }

    return {
      updatedSchema: schema,
      rootReasoning: reasoningDesc
    };
  }

  private cleanSchema(schema: Record<string, any>, options: { removeCustomFields?: boolean } = {}): Record<string, any> {
    const { removeCustomFields = false } = options;
    
    function cleanObject(obj: any): any {
      if (typeof obj !== 'object' || obj === null) return obj;
      if (Array.isArray(obj)) return obj.map(cleanObject);
      
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        // Remove custom fields if requested
        if (removeCustomFields && key.startsWith('X-')) {
          continue;
        }
        
        result[key] = cleanObject(value);
      }
      return result;
    }
    
    return cleanObject(schema);
  }

  private jsonSchemaToStrictOpenaiSchema(schema: Record<string, any>): Record<string, any> {
    // Convert schema to OpenAI strict format, matching Python implementation exactly
    function makeStrict(obj: any): any {
      if (typeof obj !== 'object' || obj === null) return obj;
      if (Array.isArray(obj)) return obj.map(makeStrict);
      
      const result = { ...obj };
      
      // Remove unsupported fields (matching Python implementation)
      for (const key of ['default', 'format', 'X-FieldTranslation', 'X-EnumTranslation']) {
        delete result[key];
      }
      
      // Convert integer to number (Python requirement)
      if (result.type === 'integer') {
        result.type = 'number';
      } else if (Array.isArray(result.type)) {
        result.type = result.type.map((t: string) => t === 'integer' ? 'number' : t);
      }
      
      // Handle allOf (merge all schemas)
      if (result.allOf) {
        const subschemas = result.allOf;
        delete result.allOf;
        const merged: Record<string, any> = {};
        
        for (const subschema of subschemas) {
          if (subschema.$ref) {
            merged.$ref = subschema.$ref;
          } else {
            Object.assign(merged, makeStrict(subschema));
          }
        }
        Object.assign(result, merged);
      }
      
      // Handle anyOf
      if (result.anyOf) {
        result.anyOf = result.anyOf.map(makeStrict);
      }
      
      // Handle enum (force to string)
      if (result.enum) {
        result.enum = result.enum.map((e: any) => String(e));
        result.type = 'string';
      }
      
      // Handle object type - make all properties required and set additionalProperties: false
      if (result.type === 'object' && result.properties) {
        result.required = Object.keys(result.properties); // All properties required in strict mode
        result.additionalProperties = false;
        
        const newProperties: Record<string, any> = {};
        for (const [key, prop] of Object.entries(result.properties)) {
          newProperties[key] = makeStrict(prop);
        }
        result.properties = newProperties;
      }
      
      // Handle array items
      if (result.type === 'array' && result.items) {
        result.items = makeStrict(result.items);
      }
      
      // Handle $defs
      if (result.$defs) {
        const newDefs: Record<string, any> = {};
        for (const [key, def] of Object.entries(result.$defs)) {
          newDefs[key] = makeStrict(def);
        }
        result.$defs = newDefs;
      }
      
      return result;
    }
    
    return makeStrict(schema);
  }

  private expandRefs(schema: Record<string, any>): Record<string, any> {
    // Check for cyclic references first
    if (this.hasCyclicRefs(schema)) {
      // Cyclic references detected, keeping schema unchanged
      return schema;
    }
    
    const definitions = schema.$defs ? { ...schema.$defs } : {};
    delete schema.$defs; // Remove $defs from the schema copy
    
    // Handle allOf at root level - merge all schemas
    if (schema.allOf) {
      const merged = this.mergeAllOfSchemas(schema.allOf);
      // Merge the allOf result into the current schema
      Object.assign(schema, merged);
      delete schema.allOf;
    }
    
    return this.expandRefsRecursive(schema, definitions);
  }

  private hasCyclicRefs(schema: Record<string, any>): boolean {
    const definitions = schema.$defs || {};
    if (!definitions || Object.keys(definitions).length === 0) {
      return false;
    }

    const memo: Record<string, boolean> = {};

    const dfs = (defName: string, stack: Set<string>): boolean => {
      if (stack.has(defName)) {
        return true; // Cycle detected
      }
      if (defName in memo) {
        return memo[defName];
      }

      stack.add(defName);
      const node = definitions[defName];
      if (!node) {
        stack.delete(defName);
        memo[defName] = false;
        return false;
      }

      const result = this.traverseForCycles(node, stack, definitions);
      stack.delete(defName);
      memo[defName] = result;
      return result;
    };

    // Check each definition for cycles
    for (const defName of Object.keys(definitions)) {
      if (dfs(defName, new Set())) {
        return true;
      }
    }

    return false;
  }

  private traverseForCycles(node: any, stack: Set<string>, definitions: Record<string, any>): boolean {
    if (typeof node !== 'object' || node === null) {
      return false;
    }

    if (Array.isArray(node)) {
      return node.some(item => this.traverseForCycles(item, stack, definitions));
    }

    // Check for $ref
    if (node.$ref) {
      const refPath = node.$ref;
      if (refPath.startsWith('#/$defs/')) {
        const targetDef = refPath.substring('#/$defs/'.length);
        if (stack.has(targetDef)) {
          return true; // Cycle detected
        }
        if (definitions[targetDef]) {
          const newStack = new Set(stack);
          newStack.add(targetDef);
          return this.traverseForCycles(definitions[targetDef], newStack, definitions);
        }
      }
    }

    // Traverse all properties except $ref
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') continue;
      if (this.traverseForCycles(value, stack, definitions)) {
        return true;
      }
    }

    return false;
  }

  private expandRefsRecursive(obj: any, definitions: Record<string, any>): any {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.expandRefsRecursive(item, definitions));
    }
    
    if (obj.$ref) {
      const refPath = obj.$ref;
      if (refPath.startsWith('#/$defs/')) {
        const defName = refPath.substring('#/$defs/'.length);
        if (definitions[defName]) {
          const target = definitions[defName];
          // Merge descriptions if present
          const merged = this.mergeDescriptions(obj, target);
          delete merged.$ref;
          return this.expandRefsRecursive(merged, definitions);
        }
      }
      return obj;
    }
    
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        const newProps: Record<string, any> = {};
        for (const [propKey, propValue] of Object.entries(value)) {
          newProps[propKey] = this.expandRefsRecursive(propValue, definitions);
        }
        result[key] = newProps;
      } else if (key === 'items') {
        result[key] = this.expandRefsRecursive(value, definitions);
      } else if (key === '$defs' && typeof value === 'object' && value !== null) {
        const newDefs: Record<string, any> = {};
        for (const [defKey, defValue] of Object.entries(value)) {
          newDefs[defKey] = this.expandRefsRecursive(defValue, definitions);
        }
        result[key] = newDefs;
      } else {
        result[key] = this.expandRefsRecursive(value, definitions);
      }
    }
    
    return result;
  }

  private mergeDescriptions(source: Record<string, any>, target: Record<string, any>): Record<string, any> {
    const merged = { ...target };
    
    // If source has description and target doesn't, use source's description
    if (source.description && !target.description) {
      merged.description = source.description;
    }
    
    return merged;
  }

  private jsonSchemaToTypescriptInterface(schema: Record<string, any>): string {
    // Convert JSON schema to TypeScript interface
    function convertType(obj: any, depth: number = 0): string {
      const indent = '  '.repeat(depth);
      
      if (!obj || typeof obj !== 'object') {
        return 'any';
      }
      
      if (obj.enum) {
        return obj.enum.map((e: any) => typeof e === 'string' ? `"${e}"` : String(e)).join(' | ');
      }
      
      if (obj.type === 'string') return 'string';
      if (obj.type === 'number' || obj.type === 'integer') return 'number';
      if (obj.type === 'boolean') return 'boolean';
      if (obj.type === 'null') return 'null';
      
      if (obj.type === 'array') {
        const itemType = obj.items ? convertType(obj.items, depth) : 'any';
        return `${itemType}[]`;
      }
      
      if (obj.type === 'object' && obj.properties) {
        const props = Object.entries(obj.properties)
          .map(([key, prop]: [string, any]) => {
            const optional = !obj.required?.includes(key) ? '?' : '';
            const type = convertType(prop, depth + 1);
            const desc = prop.description ? ` // ${prop.description}` : '';
            return `${indent}  ${key}${optional}: ${type};${desc}`;
          })
          .join('\n');
        
        return `{\n${props}\n${indent}}`;
      }
      
      if (obj.anyOf) {
        return obj.anyOf.map((subSchema: any) => convertType(subSchema, depth)).join(' | ');
      }
      
      return 'any';
    }
    
    const interfaceName = schema.title || 'Schema';
    const interfaceBody = convertType(schema, 0);
    
    return `interface ${interfaceName} ${interfaceBody}`;
  }

  private jsonSchemaToNlpDataStructure(schema: Record<string, any>): string {
    // Convert JSON schema to natural language data structure description
    function describe(obj: any, depth: number = 0): string {
      const indent = '  '.repeat(depth);
      
      if (!obj || typeof obj !== 'object') {
        return 'any value';
      }
      
      if (obj.description) {
        return obj.description;
      }
      
      if (obj.type === 'string') return 'text string';
      if (obj.type === 'number' || obj.type === 'integer') return 'number';
      if (obj.type === 'boolean') return 'true/false value';
      if (obj.type === 'null') return 'null value';
      
      if (obj.type === 'array') {
        const itemDesc = obj.items ? describe(obj.items, depth) : 'any item';
        return `array of ${itemDesc}`;
      }
      
      if (obj.type === 'object' && obj.properties) {
        const props = Object.entries(obj.properties)
          .map(([key, prop]: [string, any]) => {
            const optional = !obj.required?.includes(key) ? ' (optional)' : '';
            const desc = describe(prop, depth + 1);
            return `${indent}- ${key}${optional}: ${desc}`;
          })
          .join('\n');
        
        return `object containing:\n${props}`;
      }
      
      if (obj.anyOf) {
        return `one of: ${obj.anyOf.map((subSchema: any) => describe(subSchema, depth)).join(', ')}`;
      }
      
      return 'value';
    }
    
    return describe(schema, 0);
  }

  private _getPatternAttribute(pattern: string, attribute: 'X-FieldPrompt' | 'X-ReasoningPrompt' | 'type'): string | null {
    // Navigate schema using pattern and return specified attribute
    const currentSchema = this._expandedObjectSchema;
    
    // Special case: "*" means the root schema itself
    if (pattern.trim() === '*') {
      if (attribute === 'X-FieldPrompt') {
        return currentSchema[attribute] || currentSchema.description || null;
      }
      if (attribute === 'type') {
        return this.schemaToTsType(currentSchema);
      }
      return currentSchema[attribute] || null;
    }

    const parts = pattern.split('.');
    let current = currentSchema;
    let index = 0;

    while (index < parts.length) {
      const part = parts[index];

      if (part === '*' || /^\d+$/.test(part)) {
        // Handle wildcard case for arrays
        if (current.items) {
          current = current.items;
          index++;
        } else {
          // Invalid use of "*" for the current schema
          return null;
        }
      } else if (current.properties && part in current.properties) {
        // Handle normal property navigation
        current = current.properties[part];
        index++;
      } else {
        // Cannot navigate further; invalid pattern
        return null;
      }
    }

    // At this point, we've navigated to the target node
    if (attribute === 'X-FieldPrompt') {
      return current[attribute] || current.description || null;
    } else if (attribute === 'type') {
      return this.schemaToTsType(current);
    }
    return current[attribute] || null;
  }

  private _setPatternAttribute(pattern: string, attribute: 'X-FieldPrompt' | 'X-ReasoningPrompt' | 'X-SystemPrompt' | 'description', value: string): void {
    // Navigate schema using pattern and set attribute at target location
    let current = this.json_schema;
    const definitions = this.json_schema.$defs || {};
    const parts = pattern.split('.');

    if (pattern.trim() === '*') {
      // Special case: "*" means the root schema itself
      current[attribute] = value;
      return;
    }

    if (attribute === 'X-SystemPrompt') {
      throw new Error('Cannot set the X-SystemPrompt attribute other than at the root schema.');
    }

    let index = 0;
    while (index < parts.length) {
      const part = parts[index];
      
      if (part === '*' || /^\d+$/.test(part)) {
        // Handle the array case
        if (current.items) {
          current = current.items;
          index++;
        } else {
          return; // Invalid pattern for the current schema
        }
      } else if (current.properties && part in current.properties) {
        // Handle the properties case
        current = current.properties[part];
        index++;
      } else if (current.$ref) {
        // Handle the $ref case
        const ref = current.$ref;
        if (!ref.startsWith('#/$defs/')) {
          return;
        }
        
        const refName = ref.substring('#/$defs/'.length);
        if (!definitions[refName]) {
          return;
        }

        // Count how many times this ref is used in the entire schema
        const refCount = JSON.stringify(this.json_schema).split(`"${ref}"`).length - 1;

        if (refCount > 1) {
          // Create a unique copy name by appending a number
          let copyNum = 1;
          let nextCopyName = `${refName}Copy${copyNum}`;
          while (definitions[nextCopyName]) {
            copyNum++;
            nextCopyName = `${refName}Copy${copyNum}`;
          }

          // Create a copy of the definition
          const defCopy = JSON.parse(JSON.stringify(definitions[refName]));

          // Change the title and name of the definition
          if (defCopy.title) {
            defCopy.title = `${defCopy.title} Copy ${copyNum}`;
          }
          if (defCopy.name) {
            defCopy.name = nextCopyName;
          }

          // Add the new copy to definitions
          definitions[nextCopyName] = defCopy;

          // Update the reference
          current.$ref = `#/$defs/${nextCopyName}`;
          current = definitions[nextCopyName];
        } else {
          // Reference is used only once; directly navigate to the definition
          current = definitions[refName];
        }
      } else {
        // Cannot navigate further; invalid pattern
        return;
      }
    }

    // Once we have navigated to the correct node, set the attribute
    current[attribute] = value;
  }

  private schemaToTsType(schema: Record<string, any>): string {
    // Convert JSON schema type to TypeScript type representation
    if (!schema || typeof schema !== 'object') {
      return 'any';
    }

    if (schema.type === 'string') return 'string';
    if (schema.type === 'number' || schema.type === 'integer') return 'number';
    if (schema.type === 'boolean') return 'boolean';
    if (schema.type === 'null') return 'null';

    if (schema.type === 'array') {
      const itemType = schema.items ? this.schemaToTsType(schema.items) : 'any';
      return `${itemType}[]`;
    }

    if (schema.type === 'object') {
      if (schema.properties) {
        const props = Object.entries(schema.properties)
          .map(([key, prop]: [string, any]) => {
            const optional = !schema.required?.includes(key) ? '?' : '';
            const type = this.schemaToTsType(prop);
            return `${key}${optional}: ${type}`;
          })
          .join('; ');
        return `{ ${props} }`;
      }
      return 'object';
    }

    if (schema.anyOf) {
      return schema.anyOf.map((subSchema: any) => this.schemaToTsType(subSchema)).join(' | ');
    }

    if (schema.enum) {
      return schema.enum.map((e: any) => typeof e === 'string' ? `"${e}"` : String(e)).join(' | ');
    }

    return 'any';
  }

  private mergeAllOfSchemas(allOfSchemas: any[]): Record<string, any> {
    // Merge multiple schemas from allOf into a single schema
    const merged: Record<string, any> = {};

    for (const subschema of allOfSchemas) {
      if (subschema.$ref) {
        // Handle $ref within allOf - this would need to be resolved first
        // For now, we'll include the $ref as-is
        Object.assign(merged, subschema);
      } else {
        // Merge properties, required fields, etc.
        if (subschema.type && !merged.type) {
          merged.type = subschema.type;
        }

        if (subschema.properties) {
          if (!merged.properties) {
            merged.properties = {};
          }
          Object.assign(merged.properties, subschema.properties);
        }

        if (subschema.required) {
          if (!merged.required) {
            merged.required = [];
          }
          // Merge required arrays, avoiding duplicates
          for (const field of subschema.required) {
            if (!merged.required.includes(field)) {
              merged.required.push(field);
            }
          }
        }

        // Copy other schema properties
        for (const [key, value] of Object.entries(subschema)) {
          if (!['type', 'properties', 'required'].includes(key) && !merged[key]) {
            merged[key] = value;
          }
        }
      }
    }

    return merged;
  }
}