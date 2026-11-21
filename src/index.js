import { parseJson } from './json.js';
import { parseText } from './text.js';

export * from './nodes.js';
export { CqlError } from './errors.js';
export { parseJson, parseText };

/**
 * Parses a filter in either encoding. Objects and strings that start with a brace are read as CQL2 JSON.
 *
 * @param {string | object} filter
 * @param {{ maxDepth?: number }} [options]
 * @returns {any} the root node of the filter
 */
export function parse(filter, options = {}) {
  if (typeof filter === 'string' && !filter.trimStart().startsWith('{')) {
    return parseText(filter, options);
  }
  return parseJson(filter, options);
}

export { CONFORMANCE, CONFORMANCE_PREFIX, requiredConformance, schemaToType, validate } from './validate.js';

/** @typedef {import('./errors.js').Span} Span */
/** @typedef {import('./nodes.js').CqlWritable} CqlWritable */
/** @typedef {import('./validate.js').CqlType} CqlType */
/** @typedef {import('./validate.js').FunctionDefinition} FunctionDefinition */
/** @typedef {import('./validate.js').Problem} Problem */
/** @typedef {import('./validate.js').ValidateOptions} ValidateOptions */
