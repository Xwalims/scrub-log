'use strict';

/**
 * Output formatters.
 *
 * Two formats are supported: `ndjson`, one JSON object per line for machine
 * consumers, and `pretty`, an aligned human-readable line for a terminal.
 *
 * @module formatter
 */

/**
 * ANSI escape sequences used by the pretty formatter.
 *
 * They are emitted only when the target stream is a TTY, so redirected output
 * stays free of escape codes.
 *
 * @type {Readonly<Record<string, string>>}
 */
const ANSI = Object.freeze({
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  yellow: '[33m',
  green: '[32m',
  cyan: '[36m',
  gray: '[90m',
  magenta: '[35m',
});

/**
 * Colour used for each level name.
 *
 * @type {Readonly<Record<string, string>>}
 */
const LEVEL_COLORS = Object.freeze({
  trace: 'gray',
  debug: 'cyan',
  info: 'green',
  warn: 'yellow',
  error: 'red',
  fatal: 'magenta',
});

/**
 * Convert a value to a string for pretty output.
 *
 * Strings are returned as-is so multi-word values are not quoted; everything
 * else goes through `JSON.stringify` when it is representable, with a fallback
 * for values such as `BigInt` and `Map` that JSON cannot encode.
 *
 * @param {unknown} value Value to render.
 * @returns {string} A display string.
 */
function displayValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }
  // RegExp and other exotic objects stringify to "{}" through JSON.stringify,
  // which hides useful information, so use their own representation.
  if (value instanceof RegExp || value instanceof Date) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[Unserialisable]';
  }
}

/**
 * Build the record object shared by both formatters.
 *
 * The key order is fixed here so `ndjson` output is stable across runs and
 * across Node versions: `time`, `level`, `msg`, then logger name, then any
 * remaining fields in their original insertion order.
 *
 * @param {object} record A log record with `time`, `level`, `msg` and fields.
 * @returns {object} The record with a canonical key order.
 */
function orderRecord(record) {
  const ordered = {};
  const { time, level, msg, name, ...rest } = record;
  if (time !== undefined) {
    ordered.time = time;
  }
  if (level !== undefined) {
    ordered.level = level;
  }
  if (msg !== undefined) {
    ordered.msg = msg;
  }
  if (name !== undefined) {
    ordered.name = name;
  }
  for (const key of Object.keys(rest)) {
    ordered[key] = rest[key];
  }
  return ordered;
}

/**
 * Create an ndjson formatter.
 *
 * Each call returns exactly one line terminated by `\n`. Errors have already
 * been converted to plain objects by the logger, so `JSON.stringify` cannot
 * fail on them.
 *
 * @example
 * const format = ndjson();
 * format({ time: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'up' });
 * // => '{"time":"...","level":"info","msg":"up"}\n'
 *
 * @returns {(record: object) => string} A formatter function.
 */
function ndjson() {
  return function formatNdjson(record) {
    return `${JSON.stringify(orderRecord(record))}\n`;
  };
}

/**
 * Create a pretty formatter for terminal output.
 *
 * The line is laid out as `TIME LEVEL NAME key=value key=value MSG`, with the
 * level padded to a fixed width so columns align, and ANSI colour applied to
 * the level only when `color` is true.
 *
 * @param {object} [options] Formatter options.
 * @param {boolean} [options.color=false] Emit ANSI colour codes.
 * @returns {(record: object) => string} A formatter function.
 */
function pretty(options = {}) {
  const { color = false } = options;
  const width = 5;

  return function formatPretty(record) {
    const ordered = orderRecord(record);
    const { time, level, msg, name, ...rest } = ordered;

    const paint = (text, colour) => (color ? `${ANSI[colour]}${text}${ANSI.reset}` : text);

    const parts = [];
    if (time !== undefined) {
      parts.push(color ? `${ANSI.dim}${time}${ANSI.reset}` : time);
    }
    if (level !== undefined) {
      parts.push(paint(String(level).toUpperCase().padEnd(width), LEVEL_COLORS[String(level)] || 'reset'));
    }
    if (name !== undefined) {
      parts.push(`[${name}]`);
    }
    for (const key of Object.keys(rest)) {
      parts.push(`${key}=${displayValue(rest[key])}`);
    }

    let line = parts.join(' ');
    if (msg !== undefined) {
      line = line.length > 0 ? `${line} ${msg}` : String(msg);
    } else {
      // Drop the separator left by the padded level so the line has no trailing
      // whitespace when a record carries no message.
      line = line.trimEnd();
    }
    return `${line}\n`;
  };
}

/**
 * Resolve a format name or formatter function to a formatter function.
 *
 * @param {string|((record: object) => string)} format `"ndjson"`, `"pretty"`,
 *   or a custom formatter function.
 * @param {object} [options] Options forwarded to the built-in formatters.
 * @returns {(record: object) => string} A formatter function.
 * @throws {TypeError} If `format` is neither a known name nor a function.
 */
function resolveFormatter(format, options = {}) {
  if (typeof format === 'function') {
    return format;
  }
  switch (format) {
    case 'ndjson':
    case 'json':
      return ndjson();
    case 'pretty':
      return pretty(options);
    default:
      throw new TypeError(
        `unknown format ${JSON.stringify(format)}; expected "ndjson", "pretty" or a function`
      );
  }
}

module.exports = {
  ANSI,
  LEVEL_COLORS,
  displayValue,
  ndjson,
  orderRecord,
  pretty,
  resolveFormatter,
};