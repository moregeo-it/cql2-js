const LITERAL = /^[+-]?([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/;
const EXACT_DIGITS = 15;

/**
 * Tells whether a number was written as an integer with more digits than JavaScript keeps.
 * Numbers with up to 15 significant digits, such as 1e30, are approximate by notation and pass.
 *
 * @param {string} source the number as it was written
 * @param {number} value the number as JavaScript read it
 * @returns {boolean} whether reading the number changed its value
 */
export function isRounded(source, value) {
  const match = LITERAL.exec(source);
  if (!match || !Number.isFinite(value)) {
    return false;
  }
  const fraction = match[2] ?? '';
  const written = ((match[1] ?? '') + fraction).replace(/^0+/, '');
  const digits = written.replace(/0+$/, '');
  const scale = Number(match[3] ?? 0) - fraction.length + written.length - digits.length;
  if (digits.length <= EXACT_DIGITS || scale < 0) {
    return false;
  }
  return BigInt(digits) * 10n ** BigInt(scale) !== BigInt(value);
}

/**
 * @param {number} value
 * @returns {boolean} whether the integer cannot be written without changing its value
 */
export function isUnsafeInteger(value) {
  return Number.isInteger(value) && !Number.isSafeInteger(value) && isRounded(String(value), value);
}
