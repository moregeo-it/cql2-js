/**
 * @typedef {object} Span
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {object} CqlErrorDetails
 * @property {number} [position]
 * @property {number} [line]
 * @property {number} [column]
 * @property {Array<string | number>} [path]
 */

export class CqlError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {CqlErrorDetails} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CqlError';
    this.code = code;
    this.position = details.position;
    this.line = details.line;
    this.column = details.column;
    this.path = details.path;
  }
}

/**
 * @param {string} text
 * @param {number} position
 * @returns {{ line: number, column: number }}
 */
export function locate(text, position) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

/**
 * @param {Array<string | number>} path
 * @returns {string}
 */
export function pointer(path) {
  return path.map(part => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
