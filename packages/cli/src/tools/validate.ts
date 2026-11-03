/** Check common JSON Schema argument constraints before invoking a runtime. */
export function validateArguments(value: unknown, schema: unknown, location = 'args'): string | null {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
        return null;
    const rule = schema as Record<string, unknown>;
    if (Array.isArray(rule.enum) && !rule.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))
        return `${location} must match an allowed value`;
    if (rule.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return `${location} must be an object`;
        const record = value as Record<string, unknown>;
        const properties = (rule.properties ?? {}) as Record<string, unknown>;
        for (const key of Array.isArray(rule.required) ? rule.required : [])
            if (typeof key === 'string' && !(key in record))
                return `${location}.${key} is required`;
        for (const [key, item] of Object.entries(record)) {
            if (rule.additionalProperties === false && !(key in properties))
                return `${location}.${key} is not allowed`;
            const error = validateArguments(item, properties[key], `${location}.${key}`);
            if (error)
                return error;
        }
    }
    else if (rule.type === 'array') {
        if (!Array.isArray(value))
            return `${location} must be an array`;
        for (let i = 0; i < value.length; i++) {
            const error = validateArguments(value[i], rule.items, `${location}[${i}]`);
            if (error)
                return error;
        }
    }
    else if (rule.type === 'string' && typeof value !== 'string')
        return `${location} must be a string`;
    else if (rule.type === 'boolean' && typeof value !== 'boolean')
        return `${location} must be a boolean`;
    else if ((rule.type === 'number' || rule.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value))))
        return `${location} must be a ${rule.type}`;
    if (typeof value === 'number') {
        if (typeof rule.minimum === 'number' && value < rule.minimum)
            return `${location} is below its minimum`;
        if (typeof rule.maximum === 'number' && value > rule.maximum)
            return `${location} is above its maximum`;
    }
    return null;
}
