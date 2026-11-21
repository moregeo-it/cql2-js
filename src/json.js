import { CqlError, pointer } from './errors.js';
import {
  CqlArray,
  CqlBBox,
  CqlBoolean,
  CqlDate,
  CqlFunction,
  CqlGeometry,
  CqlInterval,
  CqlNumber,
  CqlProperty,
  CqlString,
  CqlTimestamp,
  createOperator,
  isIdentifier
} from './nodes.js';
import { checkDate, checkTimestamp } from './temporal.js';
import { GEOMETRY_TYPES } from './wkt.js';

/** @typedef {Array<string | number>} Path */

const GEOMETRY_NAMES = new Set(Object.values(GEOMETRY_TYPES));
/** @type {Record<string, { depth: number, kind: 'point' | 'line' | 'ring' }>} */
const COORDINATES = {
  Point: { depth: 0, kind: 'point' },
  MultiPoint: { depth: 1, kind: 'point' },
  LineString: { depth: 0, kind: 'line' },
  MultiLineString: { depth: 1, kind: 'line' },
  Polygon: { depth: 1, kind: 'ring' },
  MultiPolygon: { depth: 2, kind: 'ring' }
};
const DEFAULT_MAX_DEPTH = 100;

/**
 * @param {Path} path
 * @param {string} message
 * @returns {CqlError}
 */
function jsonError(path, message) {
  return new CqlError('syntax', `${message} (at ${pointer(path) || 'the root'})`, { path });
}

/**
 * @param {any} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

/**
 * @template {import('./nodes.js').CqlNode} T
 * @param {T} node
 * @param {Path} path
 * @returns {T}
 */
function at(node, path) {
  node.path = path;
  return node;
}

/**
 * @param {any} position
 * @param {Path} path
 */
function checkPosition(position, path) {
  const valid = Array.isArray(position) && position.length >= 2 && position.length <= 3
    && position.every(number => typeof number === 'number' && Number.isFinite(number));
  if (!valid) {
    throw jsonError(path, 'A position needs 2 or 3 numbers');
  }
}

/**
 * @param {any} positions
 * @param {'line' | 'ring'} kind
 * @param {Path} path
 */
function checkPositions(positions, kind, path) {
  if (!Array.isArray(positions)) {
    throw jsonError(path, `Expected an array of positions but found ${describe(positions)}`);
  }
  positions.forEach((position, index) => checkPosition(position, [...path, index]));
  const minimum = kind === 'ring' ? 4 : 2;
  if (positions.length < minimum) {
    const name = kind === 'ring' ? 'A polygon ring' : 'A line';
    throw jsonError(path, `${name} needs at least ${minimum} positions, got ${positions.length}`);
  }
  const first = positions[0];
  const last = positions[positions.length - 1];
  const closed = first.length === last.length
    && first.every((/** @type {number} */ value, /** @type {number} */ index) => value === last[index]);
  if (kind === 'ring' && !closed) {
    throw jsonError(path, 'A polygon ring must end at the position where it starts');
  }
}

/**
 * @param {any} coordinates
 * @param {number} depth
 * @param {'point' | 'line' | 'ring'} kind
 * @param {Path} path
 */
function checkCoordinates(coordinates, depth, kind, path) {
  if (depth > 0) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      throw jsonError(path, `Expected a non-empty array of coordinates but found ${describe(coordinates)}`);
    }
    coordinates.forEach((member, index) => checkCoordinates(member, depth - 1, kind, [...path, index]));
  } else if (kind === 'point') {
    checkPosition(coordinates, path);
  } else {
    checkPositions(coordinates, kind, path);
  }
}

/**
 * @param {any} value
 * @param {Path} path
 * @param {boolean} [nested]
 */
function checkGeometry(value, path, nested = false) {
  if (!GEOMETRY_NAMES.has(value.type)) {
    throw jsonError([...path, 'type'], `Unknown geometry type ${JSON.stringify(value.type)}`);
  }
  if (value.type === 'GeometryCollection') {
    if (nested) {
      throw jsonError(path, 'A geometry collection must not contain another geometry collection');
    }
    if (!Array.isArray(value.geometries)) {
      throw jsonError([...path, 'geometries'], 'A geometry collection needs an array of geometries');
    }
    value.geometries.forEach((/** @type {any} */ member, /** @type {number} */ index) => {
      const memberPath = [...path, 'geometries', index];
      if (member === null || typeof member !== 'object') {
        throw jsonError(memberPath, `Expected a geometry but found ${describe(member)}`);
      }
      checkGeometry(member, memberPath, true);
    });
    return;
  }
  const { depth, kind } = COORDINATES[value.type];
  const coordinatesPath = [...path, 'coordinates'];
  if (!Array.isArray(value.coordinates)) {
    throw jsonError(coordinatesPath, `Expected an array of coordinates but found ${describe(value.coordinates)}`);
  }
  if (value.coordinates.length > 0) {
    checkCoordinates(value.coordinates, depth, kind, coordinatesPath);
  }
}

/**
 * @param {any} value
 * @param {Path} path
 * @param {number} depth
 * @param {(value: any, path: Path, depth: number) => any} parse
 * @returns {any}
 */
function parseIntervalEnd(value, path, depth, parse) {
  if (typeof value === 'string') {
    if (value === '..') {
      return null;
    }
    if (checkDate(value) === null) {
      return at(new CqlDate(value), path);
    }
    if (checkTimestamp(value) === null) {
      return at(new CqlTimestamp(value), path);
    }
    throw jsonError(path, `Invalid interval end ${JSON.stringify(value)}: expected a date, a timestamp or ".."`);
  }
  const node = parse(value, path, depth);
  if (!(node instanceof CqlProperty) && !(node instanceof CqlFunction)) {
    throw jsonError(path, 'An interval end must be a date, a timestamp, "..", a property or a function');
  }
  return node;
}

/**
 * @param {any} value
 * @param {Path} path
 * @param {number} depth
 * @param {(value: any, path: Path, depth: number) => any} parse
 * @returns {any}
 */
function parseObject(value, path, depth, parse) {
  if ('op' in value) {
    if (typeof value.op !== 'string' || value.op === '') {
      throw jsonError([...path, 'op'], 'The operator must be a non-empty string');
    }
    if (!Array.isArray(value.args)) {
      throw jsonError([...path, 'args'], `Expected an array of arguments but found ${describe(value.args)}`);
    }
    const args = value.args.map((/** @type {any} */ arg, /** @type {number} */ index) =>
      parse(arg, [...path, 'args', index], depth));
    try {
      const node = createOperator(value.op, args);
      if (node instanceof CqlFunction && !isIdentifier(value.op)) {
        throw new CqlError('invalid-name', `${JSON.stringify(value.op)} is neither an operator nor a valid function name`);
      }
      return at(node, path);
    } catch (error) {
      if (error instanceof CqlError) {
        throw jsonError(path, error.message);
      }
      throw error;
    }
  }
  if (GEOMETRY_NAMES.has(value.type)) {
    checkGeometry(value, path);
    return at(new CqlGeometry(value), path);
  }
  if ('property' in value) {
    if (typeof value.property !== 'string' || value.property === '') {
      throw jsonError([...path, 'property'], 'A property name must be a non-empty string');
    }
    return at(new CqlProperty(value.property), path);
  }
  for (const kind of /** @type {const} */ (['date', 'timestamp'])) {
    if (kind in value) {
      const text = value[kind];
      let problem = `expected a string but found ${describe(text)}`;
      if (typeof text === 'string') {
        problem = (kind === 'date' ? checkDate(text) : checkTimestamp(text)) ?? '';
      }
      if (problem) {
        throw jsonError([...path, kind], `Invalid ${kind} ${JSON.stringify(text)}: ${problem}`);
      }
      return at(kind === 'date' ? new CqlDate(text) : new CqlTimestamp(text), path);
    }
  }
  if ('interval' in value) {
    if (!Array.isArray(value.interval) || value.interval.length !== 2) {
      throw jsonError([...path, 'interval'], 'An interval needs an array with a start and an end');
    }
    const [start, end] = value.interval.map((/** @type {any} */ part, /** @type {number} */ index) =>
      parseIntervalEnd(part, [...path, 'interval', index], depth, parse));
    return at(new CqlInterval(start, end), path);
  }
  if ('bbox' in value) {
    const bbox = value.bbox;
    const valid = Array.isArray(bbox) && (bbox.length === 4 || bbox.length === 6)
      && bbox.every(number => typeof number === 'number' && Number.isFinite(number));
    if (!valid) {
      throw jsonError([...path, 'bbox'], 'A bounding box needs an array of 4 or 6 numbers');
    }
    return at(new CqlBBox(bbox), path);
  }
  if ('type' in value) {
    checkGeometry(value, path);
    return at(new CqlGeometry(value), path);
  }
  throw jsonError(path, 'Expected an object with one of the members op, property, date, timestamp, interval, bbox or type');
}

/**
 * @param {any} value
 * @param {Path} path
 * @param {number} depth
 * @returns {any}
 */
function parseNode(value, path, depth) {
  if (depth <= 0) {
    throw jsonError(path, 'The filter is nested too deeply');
  }
  switch (typeof value) {
    case 'string':
      return at(new CqlString(value), path);
    case 'boolean':
      return at(new CqlBoolean(value), path);
    case 'number':
      if (!Number.isFinite(value)) {
        throw jsonError(path, 'A number must be finite');
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value) && Math.abs(value) < 1e21) {
        throw jsonError(path, `The integer ${value} is too large to be represented exactly`);
      }
      return at(new CqlNumber(value), path);
    case 'object':
      if (Array.isArray(value)) {
        return at(new CqlArray(value.map((element, index) => parseNode(element, [...path, index], depth - 1))), path);
      }
      if (value !== null) {
        return parseObject(value, path, depth - 1, parseNode);
      }
  }
  throw jsonError(path, `Unexpected ${describe(value)}`);
}

/**
 * Parses a filter in the CQL2 JSON encoding.
 *
 * @param {string | object} json a JSON string or the parsed JSON
 * @param {{ maxDepth?: number }} [options]
 * @returns {any} the root node of the filter
 * @throws {CqlError} with the path of the problem
 */
export function parseJson(json, options = {}) {
  let value = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json);
    } catch (error) {
      throw new CqlError('syntax', `The filter is not valid JSON: ${/** @type {Error} */ (error).message}`);
    }
  }
  return parseNode(value, [], options.maxDepth ?? DEFAULT_MAX_DEPTH);
}
