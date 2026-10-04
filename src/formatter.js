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
 * Copy one own property onto `target` without ever invoking the
 * `Object.prototype.__proto__` accessor.
 *
 * `target[key] = value` is not the same thing as "copy this key" for every
 * possible key name: `__proto__` is an ACCESSOR inherited from
 * `Object.prototype`, so plain assignment runs the setter and REPLACES THE
 * PROTOTYPE of `target` instead of creating an own key. A record field called
 * `__proto__` is a legal field name — `JSON.parse('{"__proto__":{"a":1}}')`
 * produces an own data property for exactly those bytes — so dropping it is
 * data loss, and the dropped value is not even visible in the output to hint
 * at it:
 *
 *     const rec = JSON.parse('{"msg":"m","__proto__":{"role":"admin"}}');
 *     JSON.stringify(rec);           // {"msg":"m","__proto__":{"role":"admin"}}
 *     const ordered = {};
 *     ordered['__proto__'] = {...};  // setter ran
 *     JSON.stringify(ordered);       // {"msg":"m"} -- field gone
 *
 * `Object.defineProperty` creates a real own data property, matching
 * `JSON.parse`. Only `__proto__` needs this: `constructor`, `toString`,
 * `valueOf` and `hasOwnProperty` are ordinary data properties on the
 * prototype, so plain assignment shadows them correctly and escaping those
 * would itself be a bug.
 *
 * @param {object} target Object to write to.
 * @param {string} key Own key name taken from the record.
 * @param {unknown} value Value to store.
 * @returns {void}
 */
function assignKey(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
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
    assignKey(ordered, key, rest[key]);
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
    // Every header field is rendered through `displayValue` rather than
    // interpolated. A template literal calls `ToPrimitive`, which throws for a
    // value with no callable `toString` whose `valueOf` returns an object — an
    // array holding `{"toString":null}` reaches that state, and any record
    // assembled from JSON carrying that field will too. The logger accepts a
    // record object as documented, so none of these four fields may assume it
    // came from the logger's own `emit` path, where `msg` is already a string.
    if (time !== undefined) {
      const rendered = displayValue(time);
      parts.push(color ? `${ANSI.dim}${rendered}${ANSI.reset}` : rendered);
    }
    if (level !== undefined) {
      const rendered = displayValue(level);
      parts.push(paint(rendered.toUpperCase().padEnd(width), LEVEL_COLORS[rendered] || 'reset'));
    }
    if (name !== undefined) {
      parts.push(`[${displayValue(name)}]`);
    }
    for (const key of Object.keys(rest)) {
      parts.push(`${key}=${displayValue(rest[key])}`);
    }

    let line = parts.join(' ');
    if (msg !== undefined) {
      const rendered = displayValue(msg);
      line = line.length > 0 ? `${line} ${rendered}` : rendered;
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
  assignKey,
  displayValue,
  ndjson,
  orderRecord,
  pretty,
  resolveFormatter,
};