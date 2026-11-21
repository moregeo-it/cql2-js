const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {boolean}
 */
function isCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

/**
 * @param {string} value
 * @returns {string | null} a description of the problem, or null if the value is valid
 */
export function checkDate(value) {
  const match = DATE.exec(value);
  if (!match) {
    return 'a date must have the form YYYY-MM-DD';
  }
  if (!isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return 'the date does not exist in the calendar';
  }
  return null;
}

/**
 * @param {string} value
 * @returns {string | null} a description of the problem, or null if the value is valid
 */
export function checkTimestamp(value) {
  const match = TIMESTAMP.exec(value);
  if (!match) {
    return 'a timestamp must be in UTC and have the form YYYY-MM-DDThh:mm:ssZ, with optional fractional seconds';
  }
  if (!isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return 'the date of the timestamp does not exist in the calendar';
  }
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 60) {
    return 'the time of the timestamp is out of range';
  }
  return null;
}
