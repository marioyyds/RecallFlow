// 测试侧的最小 JSON Schema 2020-12 子集校验器。覆盖本仓库 schema 实际使用的
// type/required/properties/additionalProperties/items/$ref/oneOf/const/enum/边界。

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error('unsupported ref ' + ref);
  return ref
    .slice(2)
    .split('/')
    .reduce((value, part) => value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

export function validateJsonSchema(value, schema, root = schema, path = '$') {
  const errors = [];
  if (schema.$ref) {
    return validateJsonSchema(value, resolveRef(root, schema.$ref), root, path);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (candidate) => validateJsonSchema(value, candidate, root, path).length === 0
    );
    if (matches.length !== 1) errors.push(path + ': oneOf matched ' + matches.length);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(path + ': expected const ' + JSON.stringify(schema.const));
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(path + ': not in enum');
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(path + ': expected type ' + types.join('|'));
      return errors;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(path + ': too short');
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(path + ': below minimum');
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(item, schema.items, root, path + '[' + index + ']'));
    });
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(path + ': missing ' + key);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) {
        errors.push(...validateJsonSchema(child, childSchema, root, path + '.' + key));
      } else if (schema.additionalProperties === false) {
        errors.push(path + ': additional property ' + key);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        errors.push(
          ...validateJsonSchema(child, schema.additionalProperties, root, path + '.' + key)
        );
      }
    }
  }
  return errors;
}
