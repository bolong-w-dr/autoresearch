// Minimal JSON Schema (draft 2020-12 subset) validator. Covers what the
// Pydantic-generated mission schema uses: type, required, properties,
// additionalProperties, enum, const, numeric bounds, string length/pattern,
// array bounds/items, anyOf/oneOf, discriminator, and local $ref.
// The service re-validates every command, so this only exists for fast
// feedback in the editor.

export function validate(schema, data, root = schema) {
  const errors = [];
  walk(schema, data, "$", errors, root, 0);
  return errors;
}

function resolveRef(ref, root) {
  if (!ref.startsWith("#/")) return null;
  return ref
    .slice(2)
    .split("/")
    .reduce((node, part) => (node == null ? null : node[part.replace(/~1/g, "/").replace(/~0/g, "~")]), root);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return expected === actual;
}

function walk(schema, value, path, errors, root, depth) {
  if (!schema || depth > 50) return;
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    if (target) walk(target, value, path, errors, root, depth + 1);
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${path}: expected ${types.join(" | ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${path}: must be < ${schema.exclusiveMaximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: must be at most ${schema.maxLength} characters`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: must match ${schema.pattern}`);
      } catch {
        /* unsupported regex flavour: skip */
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors, root, depth + 1));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) walk(sub, value[key], `${path}.${key}`, errors, root, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in props)) walk(schema.additionalProperties, v, `${path}.${key}`, errors, root, depth + 1);
      }
    }
  }

  const alternatives = schema.oneOf || schema.anyOf;
  if (alternatives) {
    const disc = schema.discriminator && schema.discriminator.propertyName;
    let candidates = alternatives;
    if (disc && value && typeof value === "object" && disc in value && schema.discriminator.mapping) {
      const mapped = schema.discriminator.mapping[value[disc]];
      if (mapped) candidates = [{ $ref: mapped }];
      else {
        errors.push(`${path}.${disc}: must be one of ${Object.keys(schema.discriminator.mapping).join(", ")}`);
        return;
      }
    }
    const attempts = candidates.map((alt) => {
      const sub = [];
      walk(alt, value, path, sub, root, depth + 1);
      return sub;
    });
    if (!attempts.some((sub) => sub.length === 0)) {
      // Report the alternative with the fewest errors; it is usually the intended one.
      const best = attempts.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(...best);
    }
  }
}
