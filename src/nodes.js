import { CqlError } from './errors.js';
import { geometryToWkt, numberToText } from './wkt.js';

export const PRECEDENCE = Object.freeze({
  or: 1,
  and: 2,
  not: 3,
  predicate: 4,
  additive: 5,
  multiplicative: 6,
  power: 7,
  atom: 9
});

export const RESERVED_WORDS = new Set([
  'and', 'or', 'not', 'like', 'between', 'in', 'is', 'null', 'true', 'false', 'div'
]);

const IDENTIFIER_START = ':_A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFE'
  + '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const IDENTIFIER_PART = `${IDENTIFIER_START}.0-9\\u0300-\\u036F\\u203F-\\u2040`;

/**
 * @param {string} source
 * @returns {RegExp}
 */
function unicodePattern(source) {
  return new RegExp(source, 'u');
}

export const IDENTIFIER_START_PATTERN = unicodePattern(`[${IDENTIFIER_START}]`);
export const IDENTIFIER_PART_PATTERN = unicodePattern(`[${IDENTIFIER_PART}]`);
const IDENTIFIER_PATTERN = unicodePattern(`^[${IDENTIFIER_START}][${IDENTIFIER_PART}]*$`);

/**
 * @param {string} name
 * @returns {boolean} whether the name can be written without quotes
 */
export function isIdentifier(name) {
  return typeof name === 'string' && IDENTIFIER_PATTERN.test(name) && !RESERVED_WORDS.has(name.toLowerCase());
}

/**
 * Anything that can be written as CQL2. Objects from other libraries can be used
 * as arguments as long as they implement these two methods.
 *
 * @typedef {object} CqlWritable
 * @property {() => any} toJSON
 * @property {() => string} toText
 */

/**
 * @param {any} node
 * @returns {number}
 */
function precedenceOf(node) {
  return typeof node?.precedence === 'number' ? node.precedence : PRECEDENCE.atom;
}

/**
 * @param {any} node
 * @param {number} minimum
 * @returns {string}
 */
function wrap(node, minimum) {
  const text = node.toText();
  return precedenceOf(node) < minimum ? `(${text})` : text;
}

const ESCAPES = new Map([['\\', '\\\\'], ["'", "''"], ['\x07', '\\a'], ['\x08', '\\b'], ['\x09', '\\t'], ['\x0A', '\\n'], ['\x0B', '\\v'], ['\x0C', '\\f'], ['\x0D', '\\r']]);
/**
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return `'${Array.from(value, char => ESCAPES.get(char) ?? char).join('')}'`;
}

export class CqlNode {

  constructor() {
    /** @type {import('./errors.js').Span | null} */
    this.span = null;
    /** @type {Array<string | number> | null} */
    this.path = null;
  }

  /** @returns {number} */
  get precedence() {
    return PRECEDENCE.atom;
  }

  /** @returns {any} */
  toJSON() {
    throw new CqlError('not-implemented', 'toJSON is not implemented');
  }

  /** @returns {string} */
  toText() {
    throw new CqlError('not-implemented', 'toText is not implemented');
  }

}

export class CqlValue extends CqlNode {

  /**
   * @param {any} value
   */
  constructor(value) {
    super();
    this.value = value;
  }

  /**
   * @param {any} value
   * @returns {any}
   */
  static create(value) {
    if (value !== null && typeof value === 'object'
      && typeof value.toJSON === 'function' && typeof value.toText === 'function') {
      return value;
    } else if (Array.isArray(value)) {
      return new CqlArray(value);
    } else if (value instanceof Date) {
      return new CqlTimestamp(value);
    } else if (typeof value === 'string') {
      return new CqlString(value);
    } else if (typeof value === 'number') {
      return new CqlNumber(value);
    } else if (typeof value === 'boolean') {
      return new CqlBoolean(value);
    } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
      return new CqlGeometry(value);
    }
    throw new CqlError('invalid-value', `Cannot create a CQL2 value from ${value === null ? 'null' : typeof value}`);
  }

  toJSON() {
    return this.value;
  }

  toText() {
    return String(this.value);
  }

}

export class CqlString extends CqlValue {

  /**
   * @param {string} value
   */
  constructor(value) {
    super(value);
  }

  toText() {
    return quote(this.value);
  }

}

export class CqlNumber extends CqlValue {

  /**
   * @param {number} value
   */
  constructor(value) {
    super(value);
  }

  toJSON() {
    numberToText(this.value);
    return this.value;
  }

  toText() {
    return numberToText(this.value);
  }

}

export class CqlBoolean extends CqlValue {

  /**
   * @param {boolean} value
   */
  constructor(value) {
    super(value);
  }

  toText() {
    return this.value ? 'TRUE' : 'FALSE';
  }

}

export class CqlDate extends CqlValue {

  /**
   * @param {string | Date} value
   */
  constructor(value) {
    super(value instanceof Date ? value.toISOString().slice(0, 10) : value);
  }

  toJSON() {
    return { date: this.value };
  }

  toText() {
    return `DATE(${quote(this.value)})`;
  }

}

export class CqlTimestamp extends CqlValue {

  /**
   * @param {string | Date} value
   */
  constructor(value) {
    super(value instanceof Date ? value.toISOString() : value);
  }

  toJSON() {
    return { timestamp: this.value };
  }

  toText() {
    return `TIMESTAMP(${quote(this.value)})`;
  }

  /** @returns {Date} */
  toDate() {
    return new Date(this.value);
  }

}

export class CqlInterval extends CqlNode {

  /**
   * An open end is given as null.
   *
   * @param {CqlWritable | null} start
   * @param {CqlWritable | null} end
   */
  constructor(start = null, end = null) {
    super();
    this.args = [start, end];
  }

  toJSON() {
    return {
      interval: this.args.map(arg => {
        if (arg === null) {
          return '..';
        }
        return arg instanceof CqlDate || arg instanceof CqlTimestamp ? arg.value : arg.toJSON();
      })
    };
  }

  toText() {
    const parts = this.args.map(arg => {
      if (arg === null) {
        return "'..'";
      }
      return arg instanceof CqlDate || arg instanceof CqlTimestamp ? quote(arg.value) : arg.toText();
    });
    return `INTERVAL(${parts.join(', ')})`;
  }

}

export class CqlGeometry extends CqlValue {

  /**
   * @param {import('./wkt.js').Geometry} value a GeoJSON geometry
   */
  constructor(value) {
    super(value);
  }

  toText() {
    return geometryToWkt(this.value);
  }

}

export class CqlBBox extends CqlValue {

  /**
   * @param {number[]} value four or six numbers
   */
  constructor(value) {
    super(value);
  }

  toJSON() {
    this.value.forEach(numberToText);
    return { bbox: this.value };
  }

  toText() {
    return `BBOX(${this.value.map(numberToText).join(', ')})`;
  }

}

export class CqlArray extends CqlValue {

  /**
   * @param {any[]} value
   */
  constructor(value = []) {
    super(value.map(element => CqlValue.create(element)));
  }

  toJSON() {
    return this.value.map((/** @type {CqlWritable} */ element) => element.toJSON());
  }

  toText() {
    return `(${this.value.map((/** @type {CqlWritable} */ element) => element.toText()).join(', ')})`;
  }

}

export class CqlProperty extends CqlNode {

  /**
   * @param {string} name
   */
  constructor(name) {
    super();
    this.name = name;
  }

  toJSON() {
    return { property: this.name };
  }

  toText() {
    if (isIdentifier(this.name)) {
      return this.name;
    }
    return `"${this.name.replaceAll('"', '""')}"`;
  }

}

export class CqlOperator extends CqlNode {

  /**
   * @param {string} operator
   * @param {any[]} args
   */
  constructor(operator, args = []) {
    super();
    this.operator = operator;
    this.args = args;
  }

  toJSON() {
    return {
      op: this.operator,
      args: this.args.map(arg => arg.toJSON())
    };
  }

  toText() {
    return `${this.operator.toUpperCase()}(${this.args.map(arg => arg.toText()).join(', ')})`;
  }

}

export class CqlLogicalOperator extends CqlOperator {

  /**
   * @param {string} op
   * @param {any[]} args
   * @returns {CqlLogicalOperator | undefined}
   */
  static create(op, args) {
    if (['&&', 'and'].includes(op)) {
      return new CqlAnd(args);
    } else if (['||', 'or'].includes(op)) {
      return new CqlOr(args);
    } else if (['!', 'not'].includes(op)) {
      return new CqlNot(args[0]);
    }
    return undefined;
  }

}

export class CqlAnd extends CqlLogicalOperator {

  static SYMBOL = 'and';

  /**
   * @param {any[]} args
   */
  constructor(args = []) {
    super(CqlAnd.SYMBOL, args);
  }

  get precedence() {
    return PRECEDENCE.and;
  }

  toText() {
    return this.args.map(arg => wrap(arg, PRECEDENCE.and)).join(' AND ');
  }

}

export class CqlOr extends CqlLogicalOperator {

  static SYMBOL = 'or';

  /**
   * @param {any[]} args
   */
  constructor(args = []) {
    super(CqlOr.SYMBOL, args);
  }

  get precedence() {
    return PRECEDENCE.or;
  }

  toText() {
    return this.args.map(arg => wrap(arg, PRECEDENCE.or)).join(' OR ');
  }

}

export class CqlNot extends CqlLogicalOperator {

  static SYMBOL = 'not';

  /**
   * @param {any} arg
   */
  constructor(arg = null) {
    super(CqlNot.SYMBOL, arg ? [arg] : []);
  }

  get precedence() {
    const arg = this.args[0];
    return arg instanceof CqlComparisonOperator && arg.negatable ? PRECEDENCE.predicate : PRECEDENCE.not;
  }

  toText() {
    const arg = this.args[0];
    if (arg instanceof CqlComparisonOperator && arg.negatable) {
      return arg.toText(true);
    }
    return `NOT ${wrap(arg, PRECEDENCE.predicate)}`;
  }

}

export class CqlComparisonOperator extends CqlOperator {

  /**
   * @param {string} operator
   * @param {any} pred
   * @param {any} obj
   */
  constructor(operator, pred = null, obj = null) {
    super(operator, [pred, obj]);
  }

  get precedence() {
    return PRECEDENCE.predicate;
  }

  /**
   * Whether the text encoding has a negated form of its own, such as NOT LIKE.
   *
   * @returns {boolean}
   */
  get negatable() {
    return false;
  }

  /**
   * @param {any} pred
   * @param {string} op
   * @param {any} obj
   * @returns {CqlComparisonOperator | undefined}
   */
  static create(pred, op, obj) {
    if (['=', '==', '==='].includes(op)) {
      return new CqlEqual(pred, obj);
    } else if (['<>', '!=', '!==', '≠'].includes(op)) {
      return new CqlNotEqual(pred, obj);
    } else if (['>=', '≥'].includes(op)) {
      return new CqlGreaterThanEqual(pred, obj);
    } else if (op === '>') {
      return new CqlGreaterThan(pred, obj);
    } else if (['<=', '≤'].includes(op)) {
      return new CqlLessThanEqual(pred, obj);
    } else if (op === '<') {
      return new CqlLessThan(pred, obj);
    } else if (op.toLowerCase() === 'like') {
      return new CqlLike(pred, obj);
    }
    return undefined;
  }

  /**
   * @param {boolean} [negated]
   * @returns {string}
   */
  toText(negated = false) {
    const [left, right] = this.args;
    return `${wrap(left, PRECEDENCE.additive)} ${this.operator.toUpperCase()} ${wrap(right, PRECEDENCE.additive)}`;
  }

}

export class CqlEqual extends CqlComparisonOperator {

  static SYMBOL = '=';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlEqual.SYMBOL, pred, obj);
  }

}

export class CqlNotEqual extends CqlComparisonOperator {

  static SYMBOL = '<>';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlNotEqual.SYMBOL, pred, obj);
  }

}

export class CqlLessThan extends CqlComparisonOperator {

  static SYMBOL = '<';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlLessThan.SYMBOL, pred, obj);
  }

}

export class CqlLessThanEqual extends CqlComparisonOperator {

  static SYMBOL = '<=';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlLessThanEqual.SYMBOL, pred, obj);
  }

}

export class CqlGreaterThan extends CqlComparisonOperator {

  static SYMBOL = '>';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlGreaterThan.SYMBOL, pred, obj);
  }

}

export class CqlGreaterThanEqual extends CqlComparisonOperator {

  static SYMBOL = '>=';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlGreaterThanEqual.SYMBOL, pred, obj);
  }

}

export class CqlLike extends CqlComparisonOperator {

  static SYMBOL = 'like';

  /**
   * @param {any} pred
   * @param {any} pattern
   */
  constructor(pred = null, pattern = null) {
    super(CqlLike.SYMBOL, pred, pattern);
  }

  get negatable() {
    return true;
  }

  /**
   * @param {boolean} [negated]
   * @returns {string}
   */
  toText(negated = false) {
    const [left, pattern] = this.args;
    const keyword = negated ? 'NOT LIKE' : 'LIKE';
    return `${wrap(left, PRECEDENCE.additive)} ${keyword} ${wrap(pattern, PRECEDENCE.additive)}`;
  }

}

export class CqlBetween extends CqlComparisonOperator {

  static SYMBOL = 'between';

  /**
   * @param {any} pred
   * @param {any} lower
   * @param {any} upper
   */
  constructor(pred = null, lower = null, upper = null) {
    super(CqlBetween.SYMBOL, pred, lower);
    this.args.push(upper);
  }

  get negatable() {
    return true;
  }

  /**
   * @param {boolean} [negated]
   * @returns {string}
   */
  toText(negated = false) {
    const [value, lower, upper] = this.args.map(arg => wrap(arg, PRECEDENCE.additive));
    return `${value} ${negated ? 'NOT BETWEEN' : 'BETWEEN'} ${lower} AND ${upper}`;
  }

}

export class CqlIn extends CqlComparisonOperator {

  static SYMBOL = 'in';

  /**
   * @param {any} pred
   * @param {any} list a CqlArray or a plain array of values
   */
  constructor(pred = null, list = []) {
    super(CqlIn.SYMBOL, pred, CqlValue.create(list));
  }

  get negatable() {
    return true;
  }

  /**
   * @param {boolean} [negated]
   * @returns {string}
   */
  toText(negated = false) {
    const [value, list] = this.args;
    return `${wrap(value, PRECEDENCE.additive)} ${negated ? 'NOT IN' : 'IN'} ${list.toText()}`;
  }

}

export class CqlIsNull extends CqlComparisonOperator {

  static SYMBOL = 'isNull';

  /**
   * @param {any} pred
   */
  constructor(pred = null) {
    super(CqlIsNull.SYMBOL, pred);
    this.args.pop();
  }

  get negatable() {
    return true;
  }

  /**
   * @param {boolean} [negated]
   * @returns {string}
   */
  toText(negated = false) {
    return `${wrap(this.args[0], PRECEDENCE.additive)} ${negated ? 'IS NOT NULL' : 'IS NULL'}`;
  }

}

export class CqlCasei extends CqlOperator {

  static SYMBOL = 'casei';

  /**
   * @param {any} arg
   */
  constructor(arg = null) {
    super(CqlCasei.SYMBOL, [arg]);
  }

}

export class CqlAccenti extends CqlOperator {

  static SYMBOL = 'accenti';

  /**
   * @param {any} arg
   */
  constructor(arg = null) {
    super(CqlAccenti.SYMBOL, [arg]);
  }

}

export class CqlSpatialOperator extends CqlOperator {

  static SYMBOLS = Object.freeze([
    's_intersects', 's_equals', 's_disjoint', 's_touches', 's_within', 's_overlaps', 's_crosses', 's_contains'
  ]);

  /**
   * @param {string} operator
   * @param {any} a
   * @param {any} b
   */
  constructor(operator, a = null, b = null) {
    super(operator, [a, b]);
  }

}

export class CqlTemporalOperator extends CqlOperator {

  static SYMBOLS = Object.freeze([
    't_after', 't_before', 't_contains', 't_disjoint', 't_during', 't_equals', 't_finishedBy', 't_finishes',
    't_intersects', 't_meets', 't_metBy', 't_overlappedBy', 't_overlaps', 't_startedBy', 't_starts'
  ]);

  /**
   * @param {string} operator
   * @param {any} a
   * @param {any} b
   */
  constructor(operator, a = null, b = null) {
    super(operator, [a, b]);
  }

}

export class CqlArrayOperator extends CqlOperator {

  /**
   * @param {string} operator
   * @param {any} pred
   * @param {any} obj
   */
  constructor(operator, pred = null, obj = null) {
    super(operator, [pred, obj]);
  }

  /**
   * @param {any} pred
   * @param {string} op
   * @param {any} obj
   * @returns {CqlOperator | undefined}
   */
  static create(pred, op, obj) {
    switch (op.toLowerCase()) {
      case 'in':
        return new CqlIn(pred, obj);
      case 'a_overlaps':
        return new CqlArrayOverlaps(pred, obj);
      case 'a_contains':
        return new CqlArrayContains(pred, obj);
      case 'a_equals':
        return new CqlArrayEquals(pred, obj);
      case 'a_containedby':
      case 'a_contained_by':
        return new CqlArrayContainedBy(pred, obj);
    }
    return undefined;
  }

}

export class CqlArrayOverlaps extends CqlArrayOperator {

  static SYMBOL = 'a_overlaps';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlArrayOverlaps.SYMBOL, pred, obj);
  }

}

export class CqlArrayContains extends CqlArrayOperator {

  static SYMBOL = 'a_contains';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlArrayContains.SYMBOL, pred, obj);
  }

}

export class CqlArrayEquals extends CqlArrayOperator {

  static SYMBOL = 'a_equals';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlArrayEquals.SYMBOL, pred, obj);
  }

}

export class CqlArrayContainedBy extends CqlArrayOperator {

  static SYMBOL = 'a_containedBy';

  /**
   * @param {any} pred
   * @param {any} obj
   */
  constructor(pred = null, obj = null) {
    super(CqlArrayContainedBy.SYMBOL, pred, obj);
  }

}

export class CqlArithmeticOperator extends CqlOperator {

  static SYMBOLS = Object.freeze(['+', '-', '*', '/', '%', 'div', '^']);

  /**
   * @param {string} operator
   * @param {any} left
   * @param {any} right
   */
  constructor(operator, left = null, right = null) {
    super(operator, [left, right]);
  }

  get precedence() {
    if (this.operator === '+' || this.operator === '-') {
      return PRECEDENCE.additive;
    }
    return this.operator === '^' ? PRECEDENCE.power : PRECEDENCE.multiplicative;
  }

  toText() {
    if (!CqlArithmeticOperator.SYMBOLS.includes(this.operator)) {
      throw new CqlError('invalid-name', `${JSON.stringify(this.operator)} is not an arithmetic operator`);
    }
    const own = this.precedence;
    const [left, right] = this.args;
    if (this.operator === '^') {
      return `${wrap(left, own + 1)} ^ ${wrap(right, own)}`;
    }
    return `${wrap(left, own)} ${this.operator} ${wrap(right, own + 1)}`;
  }

}

export class CqlFunction extends CqlOperator {

  /**
   * @param {string} name
   * @param {any[]} args
   */
  constructor(name, args = []) {
    super(name, args);
  }

  /** @returns {string} */
  get name() {
    return this.operator;
  }

  toText() {
    if (!isIdentifier(this.operator)) {
      throw new CqlError('invalid-name', `${JSON.stringify(this.operator)} cannot be written as a function name`);
    }
    return `${this.operator}(${this.args.map(arg => arg.toText()).join(', ')})`;
  }

}

/** @type {Map<string, { symbol: string, arity: number | null, create: (args: any[]) => CqlOperator }>} */
const OPERATORS = new Map();

/**
 * @param {string} symbol
 * @param {number | null} arity
 * @param {(args: any[]) => CqlOperator} create
 */
function register(symbol, arity, create) {
  OPERATORS.set(symbol.toLowerCase(), { symbol, arity, create });
}

register('and', null, args => new CqlAnd(args));
register('or', null, args => new CqlOr(args));
register('not', 1, args => new CqlNot(args[0]));
for (const Class of [CqlEqual, CqlNotEqual, CqlLessThan, CqlLessThanEqual, CqlGreaterThan, CqlGreaterThanEqual, CqlLike]) {
  register(Class.SYMBOL, 2, args => new Class(args[0], args[1]));
}
register('between', 3, args => new CqlBetween(args[0], args[1], args[2]));
register('in', 2, args => new CqlIn(args[0], args[1]));
register('isNull', 1, args => new CqlIsNull(args[0]));
register('casei', 1, args => new CqlCasei(args[0]));
register('accenti', 1, args => new CqlAccenti(args[0]));
for (const symbol of CqlSpatialOperator.SYMBOLS) {
  register(symbol, 2, args => new CqlSpatialOperator(symbol, args[0], args[1]));
}
for (const symbol of CqlTemporalOperator.SYMBOLS) {
  register(symbol, 2, args => new CqlTemporalOperator(symbol, args[0], args[1]));
}
for (const Class of [CqlArrayOverlaps, CqlArrayContains, CqlArrayEquals, CqlArrayContainedBy]) {
  register(Class.SYMBOL, 2, args => new Class(args[0], args[1]));
}
for (const symbol of CqlArithmeticOperator.SYMBOLS) {
  register(symbol, 2, args => new CqlArithmeticOperator(symbol, args[0], args[1]));
}

/**
 * @param {string} op
 * @returns {boolean}
 */
export function isOperator(op) {
  return OPERATORS.has(op.toLowerCase());
}

/**
 * Creates the node for an operator of the standard, or a function node for any other name.
 *
 * @param {string} op
 * @param {any[]} args
 * @returns {CqlOperator}
 */
export function createOperator(op, args) {
  const known = OPERATORS.get(op.toLowerCase());
  if (!known) {
    return new CqlFunction(op, args);
  }
  if (known.arity === null && args.length < 2) {
    throw new CqlError('arity', `The operator ${known.symbol} needs at least 2 arguments, got ${args.length}`);
  }
  if (known.arity !== null && args.length !== known.arity) {
    const plural = known.arity === 1 ? 'argument' : 'arguments';
    throw new CqlError('arity', `The operator ${known.symbol} needs ${known.arity} ${plural}, got ${args.length}`);
  }
  if (known.symbol === 'in' && !(args[1] instanceof CqlArray)) {
    throw new CqlError('arity', 'The second argument of the operator in must be a list of values');
  }
  return known.create(args);
}
