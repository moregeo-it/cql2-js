import { CqlError, locate } from './errors.js';
import { IDENTIFIER_PART_PATTERN, IDENTIFIER_START_PATTERN } from './nodes.js';

/**
 * @typedef {object} Token
 * @property {'identifier' | 'quoted' | 'string' | 'number' | 'symbol' | 'end'} type
 * @property {string} value
 * @property {number} start
 * @property {number} end
 */

const WHITESPACE = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const CONTROL_ESCAPES = { a: '\x07', b: '\x08', t: '\x09', n: '\x0A', v: '\x0B', f: '\x0C', r: '\x0D' };
const SYMBOLS = ['<>', '<=', '>=', '(', ')', ',', '=', '<', '>', '+', '-', '*', '/', '%', '^'];

/**
 * @param {string} text
 * @param {number} position
 * @param {string} message
 * @returns {CqlError}
 */
export function syntaxError(text, position, message) {
  const { line, column } = locate(text, position);
  return new CqlError('syntax', `${message} (line ${line}, column ${column})`, { position, line, column });
}

/**
 * @param {string} text
 * @param {number} start
 * @param {string} delimiter
 * @param {boolean} backslash whether a backslash escapes the delimiter
 * @returns {{ value: string, end: number }}
 */
function readDelimited(text, start, delimiter, backslash) {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (backslash && char === '\\' && (next === delimiter || next === '\\')) {
      value += next;
      i += 2;
    } else if (backslash && char === '\\' && Object.hasOwn(CONTROL_ESCAPES, next)) {
      value += CONTROL_ESCAPES[/** @type {keyof typeof CONTROL_ESCAPES} */ (next)];
      i += 2;
    } else if (char === delimiter && text[i + 1] === delimiter) {
      value += delimiter;
      i += 2;
    } else if (char === delimiter) {
      return { value, end: i + 1 };
    } else {
      value += char;
      i++;
    }
  }
  throw syntaxError(text, start, delimiter === "'" ? 'The string is not closed' : 'The quoted name is not closed');
}

/**
 * @param {string} text
 * @returns {Token[]}
 */
export function tokenize(text) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (WHITESPACE.test(char)) {
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      const { value, end } = readDelimited(text, i, char, char === "'");
      tokens.push({ type: char === "'" ? 'string' : 'quoted', value, start: i, end });
      i = end;
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (number) {
      tokens.push({ type: 'number', value: number[0], start: i, end: i + number[0].length });
      i += number[0].length;
      continue;
    }
    const codePoint = String.fromCodePoint(/** @type {number} */ (text.codePointAt(i)));
    if (IDENTIFIER_START_PATTERN.test(codePoint)) {
      let end = i + codePoint.length;
      while (end < text.length) {
        const next = String.fromCodePoint(/** @type {number} */ (text.codePointAt(end)));
        if (!IDENTIFIER_PART_PATTERN.test(next)) {
          break;
        }
        end += next.length;
      }
      tokens.push({ type: 'identifier', value: text.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    const symbol = SYMBOLS.find(candidate => text.startsWith(candidate, i));
    if (symbol) {
      tokens.push({ type: 'symbol', value: symbol, start: i, end: i + symbol.length });
      i += symbol.length;
      continue;
    }
    throw syntaxError(text, i, `Unexpected character ${JSON.stringify(codePoint)}`);
  }
  tokens.push({ type: 'end', value: '', start: text.length, end: text.length });
  return tokens;
}
