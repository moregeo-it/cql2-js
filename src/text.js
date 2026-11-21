import { CqlError } from './errors.js';
import {
  CqlAccenti,
  CqlArithmeticOperator,
  CqlArray,
  CqlBBox,
  CqlBetween,
  CqlBoolean,
  CqlCasei,
  CqlDate,
  CqlFunction,
  CqlGeometry,
  CqlIn,
  CqlInterval,
  CqlIsNull,
  CqlLike,
  CqlNot,
  CqlNumber,
  CqlProperty,
  CqlString,
  CqlTimestamp,
  CqlAnd,
  CqlOr,
  RESERVED_WORDS,
  createOperator,
  isOperator
} from './nodes.js';
import { checkDate, checkTimestamp } from './temporal.js';
import { syntaxError, tokenize } from './tokenizer.js';
import { GEOMETRY_TYPES } from './wkt.js';

/** @typedef {import('./tokenizer.js').Token} Token */

const COMPARISONS = new Set(['=', '<>', '<', '>', '<=', '>=']);
const NEGATABLE = new Set(['like', 'between', 'in']);
const ARRAY_FUNCTIONS = new Set(['a_equals', 'a_contains', 'a_containedby', 'a_overlaps']);
const DEFAULT_MAX_DEPTH = 100;

class Parser {

  /**
   * @param {string} text
   * @param {number} maxDepth
   */
  constructor(text, maxDepth) {
    this.text = text;
    this.tokens = tokenize(text);
    this.index = 0;
    this.depth = 0;
    this.maxDepth = maxDepth;
    /** @type {WeakMap<object, number>} */
    this.groups = new WeakMap();
  }

  /** @returns {Token} */
  get token() {
    return this.tokens[this.index];
  }

  /** @returns {Token} */
  get previous() {
    return this.tokens[this.index - 1];
  }

  /**
   * @param {number} [offset]
   * @returns {Token}
   */
  peek(offset = 1) {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  /** @returns {Token} */
  next() {
    return this.tokens[this.index++];
  }

  /**
   * @param {Token} token
   * @param {string} message
   * @returns {CqlError}
   */
  error(token, message) {
    return syntaxError(this.text, token.start, message);
  }

  /**
   * @param {Token} token
   * @returns {string}
   */
  describe(token) {
    return token.type === 'end' ? 'the end of the filter' : JSON.stringify(this.text.slice(token.start, token.end));
  }

  /**
   * @param {string} value
   * @param {Token} [token]
   * @returns {boolean}
   */
  isSymbol(value, token = this.token) {
    return token.type === 'symbol' && token.value === value;
  }

  /**
   * @param {string} word
   * @param {Token} [token]
   * @returns {boolean}
   */
  isWord(word, token = this.token) {
    return token.type === 'identifier' && token.value.toLowerCase() === word;
  }

  /**
   * @param {string} value
   * @returns {Token}
   */
  expectSymbol(value) {
    if (!this.isSymbol(value)) {
      throw this.error(this.token, `Expected ${JSON.stringify(value)} but found ${this.describe(this.token)}`);
    }
    return this.next();
  }

  /**
   * @param {string} word
   * @returns {Token}
   */
  expectWord(word) {
    if (!this.isWord(word)) {
      throw this.error(this.token, `Expected ${word.toUpperCase()} but found ${this.describe(this.token)}`);
    }
    return this.next();
  }

  /**
   * @template {import('./nodes.js').CqlNode} T
   * @param {T} node
   * @param {Token | number} start
   * @returns {T}
   */
  at(node, start) {
    node.span = { start: typeof start === 'number' ? start : start.start, end: this.previous.end };
    return node;
  }

  /**
   * @param {any} node
   * @returns {number}
   */
  startOf(node) {
    return node.span.start;
  }

  /**
   * @param {string} op
   * @param {any[]} args
   * @param {Token | number} start
   * @returns {import('./nodes.js').CqlOperator}
   */
  operator(op, args, start) {
    try {
      return this.at(createOperator(op, args), start);
    } catch (error) {
      if (error instanceof CqlError) {
        throw syntaxError(this.text, typeof start === 'number' ? start : start.start, error.message);
      }
      throw error;
    }
  }

  /**
   * @param {Token} token
   * @returns {number}
   */
  number(token) {
    const value = Number(token.value);
    if (!Number.isFinite(value)) {
      throw this.error(token, `The number ${token.value} is too large`);
    }
    if (/^[0-9]+$/.test(token.value) && !Number.isSafeInteger(value)) {
      throw this.error(token, `The integer ${token.value} is too large to be represented exactly`);
    }
    return value;
  }

  /**
   * Refuses chains of operators that would build a tree deeper than the limit.
   *
   * @param {number} length
   */
  checkChain(length) {
    if (length > this.maxDepth) {
      throw this.error(this.token, `The filter chains more than ${this.maxDepth} arithmetic operators`);
    }
  }

  /** @returns {any} */
  parse() {
    const node = this.parseExpression();
    if (this.token.type !== 'end') {
      throw this.error(this.token, `Unexpected ${this.describe(this.token)}`);
    }
    return node;
  }

  /** @returns {any} */
  parseExpression() {
    if (++this.depth > this.maxDepth) {
      throw this.error(this.token, `The filter is nested deeper than ${this.maxDepth} levels`);
    }
    const node = this.parseOr();
    this.depth--;
    return node;
  }

  /** @returns {any} */
  parseOr() {
    const first = this.parseAnd();
    if (!this.isWord('or')) {
      return first;
    }
    const args = [first];
    while (this.isWord('or')) {
      this.next();
      args.push(this.parseAnd());
    }
    return this.at(new CqlOr(args), this.startOf(first));
  }

  /** @returns {any} */
  parseAnd() {
    const first = this.parseNot();
    if (!this.isWord('and')) {
      return first;
    }
    const args = [first];
    while (this.isWord('and')) {
      this.next();
      args.push(this.parseNot());
    }
    return this.at(new CqlAnd(args), this.startOf(first));
  }

  /** @returns {any} */
  parseNot() {
    if (!this.isWord('not')) {
      return this.parsePredicate();
    }
    if (++this.depth > this.maxDepth) {
      throw this.error(this.token, `The filter is nested deeper than ${this.maxDepth} levels`);
    }
    const start = this.next();
    const node = this.at(new CqlNot(this.parseNot()), start);
    this.depth--;
    return node;
  }

  /** @returns {any} */
  parsePredicate() {
    const left = this.parseAdditive();
    const start = this.startOf(left);
    if (this.token.type === 'symbol' && COMPARISONS.has(this.token.value)) {
      const op = this.next().value;
      return this.operator(op, [left, this.parseAdditive()], start);
    }
    if (this.isWord('is')) {
      this.next();
      const negated = this.isWord('not');
      if (negated) {
        this.next();
      }
      this.expectWord('null');
      const node = this.at(new CqlIsNull(left), start);
      return negated ? this.at(new CqlNot(node), start) : node;
    }
    const negated = this.isWord('not') && NEGATABLE.has(this.peek().value.toLowerCase());
    if (negated) {
      this.next();
    }
    let node;
    if (this.isWord('like')) {
      this.next();
      node = this.at(new CqlLike(left, this.parseAdditive()), start);
    } else if (this.isWord('between')) {
      this.next();
      const lower = this.parseAdditive();
      this.expectWord('and');
      node = this.at(new CqlBetween(left, lower, this.parseAdditive()), start);
    } else if (this.isWord('in')) {
      this.next();
      if (!this.isSymbol('(')) {
        throw this.error(this.token, `Expected a list in parentheses after IN but found ${this.describe(this.token)}`);
      }
      node = this.at(new CqlIn(left, this.parseArray()), start);
    } else {
      return left;
    }
    return negated ? this.at(new CqlNot(node), start) : node;
  }

  /** @returns {any} */
  parseAdditive() {
    let left = this.parseMultiplicative();
    let length = 0;
    while (this.isSymbol('+') || this.isSymbol('-')) {
      this.checkChain(++length);
      const op = this.next().value;
      left = this.at(new CqlArithmeticOperator(op, left, this.parseMultiplicative()), this.startOf(left));
    }
    return left;
  }

  /** @returns {any} */
  parseMultiplicative() {
    let left = this.parsePower();
    let length = 0;
    while (this.isSymbol('*') || this.isSymbol('/') || this.isSymbol('%') || this.isWord('div')) {
      this.checkChain(++length);
      const op = this.next().value.toLowerCase();
      left = this.at(new CqlArithmeticOperator(op, left, this.parsePower()), this.startOf(left));
    }
    return left;
  }

  /** @returns {any} */
  parsePower() {
    const base = this.parseUnary();
    if (!this.isSymbol('^')) {
      return base;
    }
    if (++this.depth > this.maxDepth) {
      throw this.error(this.token, `The filter is nested deeper than ${this.maxDepth} levels`);
    }
    this.next();
    const node = this.at(new CqlArithmeticOperator('^', base, this.parsePower()), this.startOf(base));
    this.depth--;
    return node;
  }

  /** @returns {any} */
  parseUnary() {
    if (!this.isSymbol('-') && !this.isSymbol('+')) {
      return this.parsePrimary();
    }
    if (++this.depth > this.maxDepth) {
      throw this.error(this.token, `The filter is nested deeper than ${this.maxDepth} levels`);
    }
    const sign = this.next();
    const operand = this.parseUnary();
    this.depth--;
    if (sign.value === '+') {
      return operand;
    }
    if (operand instanceof CqlNumber) {
      return this.at(new CqlNumber(-operand.value), sign);
    }
    return this.at(new CqlArithmeticOperator('*', this.at(new CqlNumber(-1), sign), operand), sign);
  }

  /**
   * @param {boolean} [arrayContext] whether parentheses denote an array rather than a group
   * @returns {any}
   */
  parsePrimary(arrayContext = false) {
    const token = this.token;
    switch (token.type) {
      case 'number':
        this.next();
        return this.at(new CqlNumber(this.number(token)), token);
      case 'string':
        this.next();
        return this.at(new CqlString(token.value), token);
      case 'quoted':
        this.next();
        if (token.value === '') {
          throw this.error(token, 'A property name must not be empty');
        }
        return this.at(new CqlProperty(token.value), token);
      case 'identifier':
        return this.parseIdentifier();
      case 'symbol':
        if (token.value === '(') {
          return arrayContext ? this.parseArray() : this.parseParentheses();
        }
    }
    throw this.error(token, `Expected a value, a property or a function but found ${this.describe(token)}`);
  }

  /** @returns {any} */
  parseParentheses() {
    const start = this.next();
    if (this.isSymbol(')')) {
      this.next();
      return this.at(new CqlArray([]), start);
    }
    const firstToken = this.token;
    const first = this.parseExpression();
    if (this.isSymbol(')')) {
      this.next();
      this.groups.set(first, (this.groups.get(first) ?? 0) + 1);
      return first;
    }
    const elements = [this.toElement(first, firstToken)];
    while (this.isSymbol(',')) {
      this.next();
      elements.push(this.parseElement());
    }
    this.expectSymbol(')');
    return this.at(new CqlArray(elements), start);
  }

  /**
   * Parses an array element or a function argument. Parentheses around the whole of it denote an array,
   * parentheses around a part of it group as usual.
   *
   * @returns {any}
   */
  parseElement() {
    const start = this.token;
    return this.toElement(this.parseExpression(), start);
  }

  /**
   * @param {any} node
   * @param {Token} start
   * @returns {any}
   */
  toElement(node, start) {
    const levels = this.groups.get(node) ?? 0;
    this.groups.delete(node);
    let element = node;
    for (let level = 0; level < levels; level++) {
      element = this.at(new CqlArray([element]), start);
    }
    return element;
  }

  /** @returns {CqlArray} */
  parseArray() {
    if (++this.depth > this.maxDepth) {
      throw this.error(this.token, `The filter is nested deeper than ${this.maxDepth} levels`);
    }
    const start = this.expectSymbol('(');
    const elements = [];
    if (!this.isSymbol(')')) {
      do {
        elements.push(this.parseElement());
      } while (this.isSymbol(',') && this.next());
    }
    this.expectSymbol(')');
    this.depth--;
    return this.at(new CqlArray(elements), start);
  }

  /**
   * @param {boolean} [elements] whether parentheses around a whole argument denote an array
   * @returns {any[]}
   */
  parseArguments(elements = false) {
    this.expectSymbol('(');
    const args = [];
    if (!this.isSymbol(')')) {
      do {
        args.push(elements ? this.parseElement() : this.parseExpression());
      } while (this.isSymbol(',') && this.next());
    }
    this.expectSymbol(')');
    return args;
  }

  /** @returns {any} */
  parseIdentifier() {
    const token = this.token;
    const word = token.value.toLowerCase();
    const called = this.isSymbol('(', this.peek());

    if (word in GEOMETRY_TYPES && (called || ['z', 'm', 'zm', 'empty'].some(marker => this.isWord(marker, this.peek())))) {
      this.next();
      return this.at(new CqlGeometry(this.parseGeometry(word, token)), token);
    }
    if (!called) {
      this.next();
      if (word === 'true' || word === 'false') {
        return this.at(new CqlBoolean(word === 'true'), token);
      }
      if (RESERVED_WORDS.has(word)) {
        throw this.error(token, `Unexpected ${token.value.toUpperCase()}. Put the name in double quotes if it is a property`);
      }
      return this.at(new CqlProperty(token.value), token);
    }

    this.next();
    switch (word) {
      case 'date':
      case 'timestamp':
        return this.parseInstant(word, token);
      case 'interval':
        return this.parseInterval(token);
      case 'bbox':
        return this.parseBBox(token);
      case 'casei':
      case 'accenti': {
        const args = this.parseArguments();
        if (args.length !== 1) {
          throw this.error(token, `${token.value.toUpperCase()} needs 1 argument, got ${args.length}`);
        }
        return this.at(word === 'casei' ? new CqlCasei(args[0]) : new CqlAccenti(args[0]), token);
      }
    }
    if (RESERVED_WORDS.has(word)) {
      throw this.error(token, `Unexpected ${token.value.toUpperCase()}`);
    }
    const standard = isOperator(word) && /^[sta]_/.test(word);
    const args = this.parseArguments(!standard || ARRAY_FUNCTIONS.has(word));
    if (standard) {
      return this.operator(word, args, token);
    }
    return this.at(new CqlFunction(token.value, args), token);
  }

  /**
   * @param {string} kind
   * @param {Token} start
   * @returns {any}
   */
  parseInstant(kind, start) {
    this.expectSymbol('(');
    const value = this.token;
    if (value.type !== 'string') {
      throw this.error(value, `Expected a string in ${kind.toUpperCase()}() but found ${this.describe(value)}`);
    }
    this.next();
    const problem = kind === 'date' ? checkDate(value.value) : checkTimestamp(value.value);
    if (problem) {
      throw this.error(value, `Invalid ${kind} ${JSON.stringify(value.value)}: ${problem}`);
    }
    this.expectSymbol(')');
    return this.at(kind === 'date' ? new CqlDate(value.value) : new CqlTimestamp(value.value), start);
  }

  /**
   * @param {Token} start
   * @returns {any}
   */
  parseInterval(start) {
    this.expectSymbol('(');
    const first = this.parseIntervalEnd();
    this.expectSymbol(',');
    const second = this.parseIntervalEnd();
    this.expectSymbol(')');
    return this.at(new CqlInterval(first, second), start);
  }

  /** @returns {any} */
  parseIntervalEnd() {
    const token = this.token;
    if (token.type === 'string') {
      this.next();
      if (token.value === '..') {
        return null;
      }
      if (checkDate(token.value) === null) {
        return this.at(new CqlDate(token.value), token);
      }
      const problem = checkTimestamp(token.value);
      if (problem === null) {
        return this.at(new CqlTimestamp(token.value), token);
      }
      throw this.error(token, `Invalid interval end ${JSON.stringify(token.value)}: expected a date, a timestamp or '..'`);
    }
    const node = this.parsePrimary();
    if (!(node instanceof CqlProperty) && !(node instanceof CqlFunction)) {
      throw this.error(token, 'An interval end must be a date, a timestamp, \'..\', a property or a function');
    }
    return node;
  }

  /** @returns {number} */
  parseSignedNumber() {
    let sign = 1;
    if (this.isSymbol('-') || this.isSymbol('+')) {
      sign = this.next().value === '-' ? -1 : 1;
    }
    if (this.token.type !== 'number') {
      throw this.error(this.token, `Expected a number but found ${this.describe(this.token)}`);
    }
    return sign * this.number(this.next());
  }

  /**
   * @param {Token} start
   * @returns {any}
   */
  parseBBox(start) {
    this.expectSymbol('(');
    const values = [this.parseSignedNumber()];
    while (this.isSymbol(',')) {
      this.next();
      values.push(this.parseSignedNumber());
    }
    this.expectSymbol(')');
    if (values.length !== 4 && values.length !== 6) {
      throw this.error(start, `A bounding box needs 4 or 6 numbers, got ${values.length}`);
    }
    return this.at(new CqlBBox(values), start);
  }

  /**
   * @param {string} word
   * @param {Token} start
   * @returns {import('./wkt.js').Geometry}
   */
  parseGeometry(word, start) {
    const type = GEOMETRY_TYPES[/** @type {keyof typeof GEOMETRY_TYPES} */ (word)];
    if (this.isWord('z')) {
      this.next();
    } else if (this.isWord('m') || this.isWord('zm')) {
      throw this.error(this.token, 'Geometries with measures (M) are not part of CQL2');
    }
    if (this.isWord('empty')) {
      this.next();
      return type === 'GeometryCollection' ? { type, geometries: [] } : { type, coordinates: [] };
    }
    if (!this.isSymbol('(')) {
      throw this.error(this.token, `Expected "(" after ${start.value.toUpperCase()} but found ${this.describe(this.token)}`);
    }
    switch (type) {
      case 'Point': {
        this.next();
        const coordinates = this.parsePosition();
        this.expectSymbol(')');
        return { type, coordinates };
      }
      case 'LineString':
        return { type, coordinates: this.parsePositions(2, 'A line') };
      case 'Polygon':
        return { type, coordinates: this.parseList(() => this.parseRing()) };
      case 'MultiPoint':
        return { type, coordinates: this.parseList(() => this.parseMultiPointMember()) };
      case 'MultiLineString':
        return { type, coordinates: this.parseList(() => this.parsePositions(2, 'A line')) };
      case 'MultiPolygon':
        return {
          type,
          coordinates: this.parseList(() => this.parseList(() => this.parseRing()))
        };
      default:
        return { type, geometries: this.parseList(() => this.parseCollectionMember()) };
    }
  }

  /** @returns {import('./wkt.js').Geometry} */
  parseCollectionMember() {
    const token = this.token;
    const word = token.value.toLowerCase();
    if (token.type !== 'identifier' || !(word in GEOMETRY_TYPES)) {
      throw this.error(token, `Expected a geometry but found ${this.describe(token)}`);
    }
    if (word === 'geometrycollection') {
      throw this.error(token, 'A geometry collection must not contain another geometry collection');
    }
    this.next();
    return this.parseGeometry(word, token);
  }

  /**
   * @template T
   * @param {() => T} parseMember
   * @returns {T[]}
   */
  parseList(parseMember) {
    this.expectSymbol('(');
    const members = [parseMember()];
    while (this.isSymbol(',')) {
      this.next();
      members.push(parseMember());
    }
    this.expectSymbol(')');
    return members;
  }

  /** @returns {number[]} */
  parseMultiPointMember() {
    if (!this.isSymbol('(')) {
      return this.parsePosition();
    }
    this.next();
    const position = this.parsePosition();
    this.expectSymbol(')');
    return position;
  }

  /**
   * @param {number} minimum
   * @param {string} name
   * @returns {number[][]}
   */
  parsePositions(minimum, name) {
    const start = this.token;
    const positions = this.parseList(() => this.parsePosition());
    if (positions.length < minimum) {
      throw this.error(start, `${name} needs at least ${minimum} positions, got ${positions.length}`);
    }
    return positions;
  }

  /** @returns {number[][]} */
  parseRing() {
    const start = this.token;
    const ring = this.parsePositions(4, 'A polygon ring');
    const last = ring[ring.length - 1];
    if (ring[0].length !== last.length || ring[0].some((value, index) => value !== last[index])) {
      throw this.error(start, 'A polygon ring must end at the position where it starts');
    }
    return ring;
  }

  /** @returns {number[]} */
  parsePosition() {
    const start = this.token;
    const position = [this.parseSignedNumber()];
    while (this.token.type === 'number' || this.isSymbol('-') || this.isSymbol('+')) {
      position.push(this.parseSignedNumber());
    }
    if (position.length < 2 || position.length > 3) {
      throw this.error(start, `A position needs 2 or 3 numbers, got ${position.length}`);
    }
    return position;
  }

}

/**
 * Parses a filter in the CQL2 text encoding.
 *
 * @param {string} text
 * @param {{ maxDepth?: number }} [options]
 * @returns {any} the root node of the filter
 * @throws {CqlError} with the position of the problem
 */
export function parseText(text, options = {}) {
  if (typeof text !== 'string') {
    throw new CqlError('syntax', 'The filter must be a string');
  }
  const parser = new Parser(text, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  if (parser.token.type === 'end') {
    throw parser.error(parser.token, 'The filter is empty');
  }
  return parser.parse();
}
