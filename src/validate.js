import {
  CqlAccenti,
  CqlAnd,
  CqlArithmeticOperator,
  CqlArray,
  CqlArrayOperator,
  CqlBBox,
  CqlBetween,
  CqlBoolean,
  CqlCasei,
  CqlComparisonOperator,
  CqlDate,
  CqlFunction,
  CqlGeometry,
  CqlIn,
  CqlInterval,
  CqlIsNull,
  CqlLike,
  CqlNot,
  CqlNumber,
  CqlOr,
  CqlProperty,
  CqlSpatialOperator,
  CqlString,
  CqlTemporalOperator,
  CqlTimestamp
} from './nodes.js';

/**
 * @typedef {'boolean' | 'number' | 'string' | 'timestamp' | 'date' | 'interval' | 'geometry' | 'array'} CqlType
 */

/**
 * @typedef {object} FunctionDefinition
 * @property {CqlType} [returns]
 * @property {Array<CqlType | null>} [args]
 */

/**
 * @typedef {object} ValidateOptions
 * @property {string[]} [conformance] conformance classes the server supports, as URIs or short names
 * @property {Record<string, object | CqlType>} [queryables] JSON Schemas or types by property name
 * @property {boolean} [additionalProperties] whether properties outside of the queryables are allowed
 * @property {Record<string, FunctionDefinition>} [functions] the functions the server offers
 */

/**
 * @typedef {object} Problem
 * @property {string} code
 * @property {string} message
 * @property {any} node
 * @property {import('./errors.js').Span | null} span position in the text, if the filter was parsed from text
 * @property {Array<string | number> | null} path position in the JSON, if the filter was parsed from JSON
 * @property {string} [conformance] the conformance class that is needed
 */

export const CONFORMANCE_PREFIX = 'http://www.opengis.net/spec/cql2/1.0/conf/';

export const CONFORMANCE = Object.freeze({
  basic: 'basic-cql2',
  advancedComparison: 'advanced-comparison-operators',
  caseInsensitive: 'case-insensitive-comparison',
  accentInsensitive: 'accent-insensitive-comparison',
  basicSpatial: 'basic-spatial-functions',
  basicSpatialPlus: 'basic-spatial-functions-plus',
  spatial: 'spatial-functions',
  temporal: 'temporal-functions',
  array: 'array-functions',
  propertyProperty: 'property-property',
  functions: 'functions',
  arithmetic: 'arithmetic'
});

/** @type {Record<string, string[]>} */
const IMPLIED = {
  [CONFORMANCE.spatial]: [CONFORMANCE.basicSpatialPlus],
  [CONFORMANCE.basicSpatialPlus]: [CONFORMANCE.basicSpatial]
};

const SCALARS = new Set(['boolean', 'number', 'string', 'timestamp', 'date']);
const TEMPORALS = new Set(['timestamp', 'date', 'interval']);
const INSTANTS = new Set(['timestamp', 'date']);
const TYPES = new Set([...SCALARS, 'interval', 'geometry', 'array']);

/**
 * @param {any} schema a JSON Schema as used in a Queryables document, or a type name
 * @returns {CqlType | null}
 */
export function schemaToType(schema) {
  if (typeof schema === 'string') {
    return TYPES.has(schema) ? /** @type {CqlType} */ (schema) : null;
  }
  if (schema === null || typeof schema !== 'object') {
    return null;
  }
  const format = typeof schema.format === 'string' ? schema.format : '';
  const reference = typeof schema.$ref === 'string' ? schema.$ref.toLowerCase() : '';
  if (format.startsWith('geometry') || reference.includes('geojson') || reference.includes('geometry')) {
    return 'geometry';
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((/** @type {any} */ candidate) => candidate !== 'null');
  switch (type) {
    case 'string':
      if (format === 'date-time') {
        return 'timestamp';
      }
      return format === 'date' ? 'date' : 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
  }
  return null;
}

/**
 * @param {string} name a URI or a short name of a conformance class
 * @returns {string}
 */
function shortName(name) {
  return name.startsWith(CONFORMANCE_PREFIX) ? name.slice(CONFORMANCE_PREFIX.length) : name;
}

/**
 * @param {string[]} classes
 * @returns {Set<string>}
 */
function expandConformance(classes) {
  /** @type {Set<string>} */
  const supported = new Set([CONFORMANCE.basic]);
  const add = (/** @type {string} */ name) => {
    if (!supported.has(name)) {
      supported.add(name);
    }
    (IMPLIED[name] ?? []).forEach(add);
  };
  classes.map(shortName).forEach(add);
  return supported;
}

/**
 * @param {any} node
 * @returns {any}
 */
function unwrap(node) {
  let current = node;
  while (current instanceof CqlCasei || current instanceof CqlAccenti) {
    current = current.args[0];
  }
  return current;
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isLiteral(node) {
  const inner = unwrap(node);
  if (inner instanceof CqlArray) {
    return inner.value.every(isLiteral);
  }
  if (inner instanceof CqlInterval) {
    return inner.args.every(arg => arg === null || isLiteral(arg));
  }
  return inner instanceof CqlString || inner instanceof CqlNumber || inner instanceof CqlBoolean
    || inner instanceof CqlDate || inner instanceof CqlTimestamp || inner instanceof CqlGeometry
    || inner instanceof CqlBBox;
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isKnownNode(node) {
  return node instanceof CqlProperty || node instanceof CqlArray || node instanceof CqlInterval
    || node instanceof CqlString || node instanceof CqlNumber || node instanceof CqlBoolean
    || node instanceof CqlDate || node instanceof CqlTimestamp || node instanceof CqlGeometry
    || node instanceof CqlBBox || Array.isArray(node?.args);
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isProperty(node) {
  const inner = unwrap(node);
  return inner instanceof CqlProperty || (!isKnownNode(inner) && typeof inner?.toJSON === 'function');
}

class Validator {

  /**
   * @param {ValidateOptions} options
   */
  constructor(options) {
    this.options = options;
    /** @type {Problem[]} */
    this.problems = [];
    /** @type {Set<string>} */
    this.required = new Set();
    this.supported = options.conformance ? expandConformance(options.conformance) : null;
  }

  /**
   * @param {any} node
   * @param {string} code
   * @param {string} message
   * @param {string} [conformance]
   */
  report(node, code, message, conformance) {
    /** @type {Problem} */
    const problem = { code, message, node, span: node?.span ?? null, path: node?.path ?? null };
    if (conformance) {
      problem.conformance = CONFORMANCE_PREFIX + conformance;
    }
    this.problems.push(problem);
  }

  /**
   * @param {any} node
   * @param {string} conformance
   * @param {string} what
   */
  need(node, conformance, what) {
    this.required.add(conformance);
    if (this.supported && !this.supported.has(conformance)) {
      this.report(node, 'needs-conformance', `${what} is not supported by the server`, conformance);
    }
  }

  /**
   * @param {any} node
   * @param {CqlType | null} actual
   * @param {Set<string> | string} expected
   * @param {string} role
   * @returns {boolean}
   */
  expect(node, actual, expected, role) {
    const allowed = typeof expected === 'string' ? new Set([expected]) : expected;
    if (actual === null || allowed.has(actual)) {
      return true;
    }
    const names = [...allowed].join(' or ');
    this.report(node, 'type-mismatch', `${role} must be of type ${names}, but is of type ${actual}`);
    return false;
  }

  /**
   * @param {any} node
   * @returns {string | null}
   */
  propertyName(node) {
    if (node instanceof CqlProperty) {
      return node.name;
    }
    const json = typeof node?.toJSON === 'function' ? node.toJSON() : null;
    return typeof json?.property === 'string' ? json.property : null;
  }

  /**
   * @param {any} node
   * @returns {CqlType | null}
   */
  property(node) {
    const name = this.propertyName(node);
    const queryables = this.options.queryables;
    if (name === null || !queryables) {
      return null;
    }
    if (!Object.hasOwn(queryables, name)) {
      if (this.options.additionalProperties !== true) {
        this.report(node, 'unknown-property', `The property ${JSON.stringify(name)} is not a queryable`);
      }
      return null;
    }
    return schemaToType(queryables[name]);
  }

  /**
   * @param {CqlFunction} node
   * @returns {CqlType | null}
   */
  function(node) {
    this.need(node, CONFORMANCE.functions, `The function ${node.name}`);
    const types = node.args.map(arg => this.visit(arg));
    const functions = this.options.functions;
    if (!functions) {
      return null;
    }
    const name = Object.keys(functions).find(candidate => candidate.toLowerCase() === node.name.toLowerCase());
    if (name === undefined) {
      this.report(node, 'unknown-function', `The function ${node.name} is not offered by the server`);
      return null;
    }
    const definition = functions[name];
    if (Array.isArray(definition.args)) {
      if (definition.args.length !== types.length) {
        this.report(node, 'type-mismatch',
          `The function ${node.name} needs ${definition.args.length} arguments, got ${types.length}`);
      } else {
        definition.args.forEach((expected, index) => {
          if (expected) {
            this.expect(node.args[index], types[index], expected, `Argument ${index + 1} of ${node.name}`);
          }
        });
      }
    }
    return definition.returns ?? null;
  }

  /**
   * @param {CqlComparisonOperator} node
   * @param {Array<CqlType | null>} types
   */
  comparison(node, types) {
    const [left, right] = node.args;
    const symbol = node.operator.toUpperCase();
    const ordinary = !(node instanceof CqlLike) && !(node instanceof CqlBetween)
      && !(node instanceof CqlIn) && !(node instanceof CqlIsNull);
    if (!ordinary && !(node instanceof CqlIsNull)) {
      this.need(node, CONFORMANCE.advancedComparison, `The operator ${symbol}`);
    }

    if (node instanceof CqlIsNull) {
      if (!isProperty(left)) {
        this.need(node, CONFORMANCE.propertyProperty, 'IS NULL on anything but a property');
      }
      return;
    }
    if (node instanceof CqlLike) {
      this.expect(left, types[0], 'string', 'The left side of LIKE');
      if (!(unwrap(right) instanceof CqlString)) {
        this.report(right, 'invalid-pattern', 'The pattern of LIKE must be a string');
      }
    } else if (node instanceof CqlBetween) {
      node.args.forEach((arg, index) => this.expect(arg, types[index], 'number', 'An operand of BETWEEN'));
    } else if (node instanceof CqlIn) {
      this.expect(left, types[0], SCALARS, 'The left side of IN');
      const items = right instanceof CqlArray ? right.value : [];
      for (const item of items) {
        const type = this.typeOf(item);
        if (this.expect(item, type, SCALARS, 'A value in the list of IN') && types[0] && type) {
          this.compatible(item, types[0], type, 'A value in the list of IN');
        }
      }
    } else {
      const leftOk = this.expect(left, types[0], SCALARS, `The left side of ${symbol}`);
      const rightOk = this.expect(right, types[1], SCALARS, `The right side of ${symbol}`);
      if (leftOk && rightOk && types[0] && types[1]) {
        this.compatible(right, types[0], types[1], `The right side of ${symbol}`);
      }
    }

    const basicForm = !isLiteral(left) && node.args.slice(1).every(isLiteral);
    if (!basicForm) {
      this.need(node, CONFORMANCE.propertyProperty, 'A comparison that is not between a property and a literal');
    }
  }

  /**
   * @param {any} node
   * @param {CqlType} expected
   * @param {CqlType} actual
   * @param {string} role
   */
  compatible(node, expected, actual, role) {
    if (expected === actual || (INSTANTS.has(expected) && INSTANTS.has(actual))) {
      return;
    }
    this.report(node, 'type-mismatch', `${role} is of type ${actual}, but is compared with type ${expected}`);
  }

  /**
   * @param {CqlSpatialOperator} node
   */
  spatial(node) {
    const name = node.operator.toUpperCase();
    const [first, second] = node.args;
    if (node.operator.toLowerCase() !== 's_intersects') {
      this.need(node, CONFORMANCE.spatial, `The spatial operator ${name}`);
    } else {
      const literal = [first, second].find(arg => arg instanceof CqlGeometry || arg instanceof CqlBBox);
      const simple = literal instanceof CqlBBox || literal?.value?.type === 'Point';
      if (isProperty(first) && literal === second && simple) {
        this.need(node, CONFORMANCE.basicSpatial, `The spatial operator ${name}`);
      } else if (isProperty(first) && literal === second) {
        this.need(node, CONFORMANCE.basicSpatialPlus, `${name} with a geometry other than a point or a bounding box`);
      } else {
        this.need(node, CONFORMANCE.spatial, `${name} with anything but a property and a geometry`);
      }
    }
  }

  /**
   * Returns the type of a node without reporting anything.
   *
   * @param {any} node
   * @returns {CqlType | null}
   */
  typeOf(node) {
    const silent = new Validator({ ...this.options, conformance: undefined, additionalProperties: true });
    return silent.visit(node);
  }

  /**
   * @param {any} node
   * @returns {CqlType | null}
   */
  visit(node) {
    if (node instanceof CqlString) {
      return 'string';
    } else if (node instanceof CqlNumber) {
      return 'number';
    } else if (node instanceof CqlBoolean) {
      return 'boolean';
    } else if (node instanceof CqlDate) {
      return 'date';
    } else if (node instanceof CqlTimestamp) {
      return 'timestamp';
    } else if (node instanceof CqlGeometry || node instanceof CqlBBox) {
      return 'geometry';
    } else if (node instanceof CqlArray) {
      node.value.forEach((/** @type {any} */ element) => this.visit(element));
      return 'array';
    } else if (node instanceof CqlInterval) {
      this.need(node, CONFORMANCE.temporal, 'An interval');
      for (const arg of node.args) {
        if (arg !== null) {
          this.expect(arg, this.visit(arg), INSTANTS, 'An end of an interval');
        }
      }
      return 'interval';
    } else if (node instanceof CqlFunction) {
      return this.function(node);
    } else if (node instanceof CqlAnd || node instanceof CqlOr || node instanceof CqlNot) {
      const name = node.operator.toUpperCase();
      node.args.forEach(arg => this.expect(arg, this.visit(arg), 'boolean', `An operand of ${name}`));
      return 'boolean';
    } else if (node instanceof CqlComparisonOperator) {
      const types = node.args.map(arg => this.visit(arg));
      this.comparison(node, types);
      return 'boolean';
    } else if (node instanceof CqlCasei || node instanceof CqlAccenti) {
      const name = node.operator.toUpperCase();
      const conformance = node instanceof CqlCasei ? CONFORMANCE.caseInsensitive : CONFORMANCE.accentInsensitive;
      this.need(node, conformance, `The function ${name}`);
      this.expect(node.args[0], this.visit(node.args[0]), 'string', `The argument of ${name}`);
      return 'string';
    } else if (node instanceof CqlSpatialOperator) {
      const name = node.operator.toUpperCase();
      node.args.forEach(arg => this.expect(arg, this.visit(arg), 'geometry', `An operand of ${name}`));
      this.spatial(node);
      return 'boolean';
    } else if (node instanceof CqlTemporalOperator) {
      const name = node.operator.toUpperCase();
      this.need(node, CONFORMANCE.temporal, `The temporal operator ${name}`);
      node.args.forEach(arg => this.expect(arg, this.visit(arg), TEMPORALS, `An operand of ${name}`));
      return 'boolean';
    } else if (node instanceof CqlArrayOperator) {
      const name = node.operator.toUpperCase();
      this.need(node, CONFORMANCE.array, `The array operator ${name}`);
      node.args.forEach(arg => this.expect(arg, this.visit(arg), 'array', `An operand of ${name}`));
      return 'boolean';
    } else if (node instanceof CqlArithmeticOperator) {
      this.need(node, CONFORMANCE.arithmetic, `The arithmetic operator ${node.operator}`);
      node.args.forEach(arg => this.expect(arg, this.visit(arg), 'number', `An operand of ${node.operator}`));
      return 'number';
    }
    return this.property(node);
  }

}

/**
 * Checks a parsed filter: operand types, queryables, functions and conformance classes.
 * All problems are collected. An empty list means the filter is valid.
 *
 * @param {any} node the root node of a filter
 * @param {ValidateOptions} [options]
 * @returns {Problem[]}
 */
export function validate(node, options = {}) {
  const validator = new Validator(options);
  const type = validator.visit(node);
  if (type !== null && type !== 'boolean') {
    validator.report(node, 'not-boolean', `A filter must be a boolean expression, but this is of type ${type}`);
  }
  return validator.problems;
}

/**
 * Lists the conformance classes that a server must support to evaluate the filter.
 *
 * @param {any} node the root node of a filter
 * @returns {string[]} URIs of conformance classes
 */
export function requiredConformance(node) {
  const validator = new Validator({});
  validator.required.add(CONFORMANCE.basic);
  validator.visit(node);
  return [...validator.required].map(name => CONFORMANCE_PREFIX + name);
}
