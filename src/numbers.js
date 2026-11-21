const DIGITS = /^[+-]?[0-9]+$/;

/**
 * Integers beyond the safe range are rounded by JavaScript. From 1e21 on they are written
 * with an exponent and are treated as approximate numbers.
 *
 * @param {number} value
 * @returns {boolean}
 */
export function isUnsafeInteger(value) {
  return Number.isInteger(value) && !Number.isSafeInteger(value) && Math.abs(value) < 1e21;
}

/**
 * @param {string} source the number as it was written
 * @param {number} value the number as JavaScript read it
 * @returns {boolean} whether reading the number changed its value
 */
export function isRounded(source, value) {
  return isUnsafeInteger(value) || (DIGITS.test(source) && !Number.isSafeInteger(value));
}
