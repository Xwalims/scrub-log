'use strict';

/**
 * Numeric severity levels.
 *
 * The numbers follow the convention used by syslog and npm: a higher number is
 * more severe. The gaps between levels leave room for future insertions without
 * renumbering existing values.
 *
 * @type {Readonly<Record<string, number>>}
 */
const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

/** @type {ReadonlyArray<string>} Level names ordered from least to most severe. */
const LEVEL_NAMES = Object.freeze(Object.keys(LEVELS).sort((a, b) => LEVELS[a] - LEVELS[b]));

/** @type {ReadonlyArray<number>} Level values ordered from least to most severe. */
const LEVEL_VALUES = Object.freeze(LEVEL_NAMES.map((name) => LEVELS[name]));

/**
 * Resolve a level name to its numeric value.
 *
 * The lookup is case-insensitive and tolerates surrounding whitespace, so
 * user-supplied values such as `" WARN "` from an environment variable resolve.
 *
 * @param {string} name Level name, for example `"warn"`.
 * @returns {number} The numeric level.
 * @throws {TypeError} If `name` is not a string.
 * @throws {RangeError} If `name` is not a known level name.
 */
function fromName(name) {
  if (typeof name !== 'string') {
    throw new TypeError(`level name must be a string, received ${typeof name}`);
  }
  const key = name.trim().toLowerCase();
  // An own-property check is required: without it inherited members such as
  // "toString" or "constructor" would resolve to a function from
  // Object.prototype and silently pass validation.
  if (!Object.prototype.hasOwnProperty.call(LEVELS, key)) {
    throw new RangeError(
      `unknown level ${JSON.stringify(name)}; expected one of ${LEVEL_NAMES.join(', ')}`
    );
  }
  return LEVELS[key];
}

/**
 * Report whether a value is a known level name.
 *
 * Like {@link fromName} this is case-insensitive, but unlike `fromName` it
 * never throws: it is safe to call on untrusted input.
 *
 * @param {unknown} name Candidate level name.
 * @returns {boolean} True when `name` resolves to a known level.
 */
function isLevel(name) {
  return (
    typeof name === 'string' &&
    Object.prototype.hasOwnProperty.call(LEVELS, name.trim().toLowerCase())
  );
}

/**
 * Decide whether a record at `level` passes a `threshold`.
 *
 * This is the single comparison used by every logger, so filtering behaviour is
 * identical whether a numeric level or a level name is supplied.
 *
 * @param {number|string} level Level of the record being logged.
 * @param {number|string} threshold Minimum level that is emitted.
 * @returns {boolean} True when the record should be emitted.
 * @throws {RangeError} If either argument is not a known level.
 */
function shouldLog(level, threshold) {
  return toLevel(level) >= toLevel(threshold);
}

/**
 * Coerce a numeric level or level name to a numeric level.
 *
 * @param {number|string} value Level number or level name.
 * @returns {number} The numeric level.
 * @throws {RangeError} If the value is not a known level.
 */
function toLevel(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !LEVEL_VALUES.includes(value)) {
      throw new RangeError(
        `unknown level ${String(value)}; expected one of ${LEVEL_NAMES.join(', ')}`
      );
    }
    return value;
  }
  return fromName(value);
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  LEVEL_VALUES,
  fromName,
  isLevel,
  shouldLog,
  toLevel,
};