'use strict';

const { LEVELS, fromName, isLevel, shouldLog, toLevel } = require('./levels.js');
const { redact } = require('./redact.js');
const { resolveFormatter, assignKey } = require('./formatter.js');

/**
 * Copy every own key of `source` onto `target`.
 *
 * Object spread cannot be used for this: `{...source}` creates own properties
 * (so `__proto__` survives), but `base` is also re-spread later, and a spread
 * of an object whose prototype was retargeted copies nothing useful. The one
 * mechanism that is correct for a data-derived key name is `assignKey`, so
 * every merge in this module goes through it.
 *
 * @param {object} target Object to write to.
 * @param {object} source Object to copy own enumerable keys from.
 * @returns {void}
 */
function assignAll(target, source) {
  for (const key of Object.keys(source)) {
    assignKey(target, key, source[key]);
  }
}

/**
 * Logger implementation.
 *
 * @module logger
 */

/**
 * Default level applied when none is configured.
 *
 * @type {string}
 */
const DEFAULT_LEVEL = 'info';

/**
 * Resolve the level for a logger configuration.
 *
 * Falls back to {@link DEFAULT_LEVEL} when the level is absent or unusable, so
 * an environment variable holding an invalid value degrades to the default
 * instead of throwing during module initialisation.
 *
 * @param {unknown} level Configured level.
 * @returns {number} The numeric level.
 */
function resolveLevel(level) {
  if (level === undefined || level === null) {
    return fromName(DEFAULT_LEVEL);
  }
  if (typeof level === 'number') {
    return toLevel(level);
  }
  if (isLevel(level)) {
    return fromName(level);
  }
  return fromName(DEFAULT_LEVEL);
}

/**
 * Create a structured logger.
 *
 * Every record is redacted before it is formatted, so a secret cannot reach the
 * output stream even if the caller passes one as part of a message or a field.
 *
 * @example
 * const log = createLogger({ name: 'api', level: 'info' });
 * log.info('listening', { port: 8080, token: 'ghp_0123456789abcdef0123' });
 * // ndjson: {"time":"...","level":"info","msg":"listening","name":"api","port":8080,"token":"[REDACTED]"}
 *
 * @param {object} [options] Logger options.
 * @param {string} [options.name] Logger name attached to every record.
 * @param {string|number} [options.level='info'] Minimum level to emit.
 * @param {{write: (chunk: string) => unknown}} [options.stream=process.stdout]
 *   Destination stream.
 * @param {boolean} [options.redact=true] Enable automatic redaction.
 * @param {object} [options.redactOptions] Options forwarded to `redact`.
 * @param {string|((record: object) => string)} [options.format='ndjson'] Formatter.
 * @param {object} [options.base] Fields merged into every record.
 * @param {boolean} [options.color] Force ANSI colour on or off.
 * @returns {{
 *   trace: Function, debug: Function, info: Function,
 *   warn: Function, error: Function, fatal: Function,
 *   child: (bindings?: object) => object,
 *   level: (name?: string) => number|string,
 *   bindings: object
 * }} The logger.
 */
function createLogger(options = {}) {
  const {
    name,
    stream = process.stdout,
    redact: redactEnabled = true,
    redactOptions = {},
    format = 'ndjson',
    base = {},
    color,
  } = options;

  if (stream === null || typeof stream !== 'object' || typeof stream.write !== 'function') {
    throw new TypeError('stream must be an object with a write(chunk) method');
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    throw new TypeError('base must be a plain object');
  }

  let threshold = resolveLevel(options.level);
  const useColor = color === undefined ? Boolean(stream.isTTY) : Boolean(color);
  const formatter = resolveFormatter(format, { color: useColor });

  /**
   * Emit a warning on stderr the first time the destination stream fails.
   *
   * A logger that throws while logging is worse than a logger that loses a
   * line, so write failures are swallowed. Reporting every failure would be
   * noisy, so only the first is reported.
   */
  let reportedWriteFailure = false;
  const write = (line) => {
    try {
      stream.write(line);
    } catch (error) {
      if (!reportedWriteFailure) {
        reportedWriteFailure = true;
        try {
          process.stderr.write(
            `scrub-log: failed to write log record to stream: ${error && error.message}\n`
          );
        } catch {
          // stderr is unavailable as well; there is nothing further to do.
        }
      }
    }
  };

  /**
   * Build and emit one record.
   *
   * @param {number} level Numeric level of the record.
   * @param {string} levelName Level name of the record.
   * @param {unknown} message Message to log.
   * @param {object} [fields] Additional structured fields.
   */
  const emit = (level, levelName, message, fields) => {
    if (!shouldLog(level, threshold)) {
      return;
    }

    let msg = message;
    let extra = fields;

    // Support both log.info('msg', { field: 1 }) and
    // log.info({ field: 1 }, 'msg') for convenience.
    if (typeof msg === 'object' && msg !== null && typeof extra === 'string') {
      [msg, extra] = [extra, msg];
    }
    if (extra === undefined) {
      extra = {};
    }
    if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
      extra = { detail: extra };
    }

    const record = {
      time: new Date().toISOString(),
      level: levelName,
      msg: typeof msg === 'string' ? msg : displayMessage(msg),
    };
    assignAll(record, base);
    if (name !== undefined) {
      record.name = name;
    }
    // Field names come from the caller, so they come from DATA. `Object.assign`
    // cannot be used here: it is `=` under the hood, so a field literally named
    // `__proto__` would run the inherited accessor and swap the record's
    // prototype instead of becoming a field. That is silent, and it hands an
    // attacker-shaped object to whatever later inspects the record. A computed
    // key in the literal above is likewise the wrong tool — `{'__proto__': v}`
    // is a prototype-setting shorthand while `{['__proto__']: v}` is an own
    // property, and the difference is easy to miss. `assignKey` does the one
    // thing that is always correct.
    for (const key of Object.keys(extra)) {
      assignKey(record, key, extra[key]);
    }

    const payload = redactEnabled ? redact(record, redactOptions) : record;
    write(formatter(payload));
  };

  /**
   * Render a non-string message value.
   *
   * @param {unknown} value Message value.
   * @returns {string} A display string.
   */
  function displayMessage(value) {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (value instanceof Error) {
      return value.message;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '[Unserialisable]';
    }
  }

  const logger = {
    /**
     * Set or read the current level.
     *
     * @param {string} [name] New level name. Omit to read the current level.
     * @returns {number|string} The new numeric level, or the current level name.
     */
    level(name_) {
      if (name_ === undefined) {
        return levelToName(threshold);
      }
      if (!isLevel(name_)) {
        throw new RangeError(
          `unknown level ${JSON.stringify(name_)}; expected one of ` +
            'trace, debug, info, warn, error, fatal'
        );
      }
      threshold = fromName(name_);
      return threshold;
    },

    /** @type {Readonly<object>} Fields merged into every record. */
    bindings: base,

    trace: (message, fields) => emit(10, 'trace', message, fields),
    debug: (message, fields) => emit(20, 'debug', message, fields),
    info: (message, fields) => emit(30, 'info', message, fields),
    warn: (message, fields) => emit(40, 'warn', message, fields),
    error: (message, fields) => emit(50, 'error', message, fields),
    fatal: (message, fields) => emit(60, 'fatal', message, fields),

    /**
     * Create a child logger that inherits this logger's configuration.
     *
     * Parent bindings come first, so a child binding of the same name wins.
     * The child's own fields therefore appear after and override the parent's.
     *
     * @param {object} [bindings] Fields added to every child record.
     * @returns {object} The child logger.
     */
    child(bindings = {}) {
      if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
        throw new TypeError('child bindings must be a plain object');
      }
      // Parent bindings first, so a child binding of the same name wins. The
      // merge is explicit rather than `{...base, ...bindings}` because both
      // sides have data-derived keys; see assignAll.
      const merged = {};
      assignAll(merged, base);
      assignAll(merged, bindings);
      return createLogger({
        ...options,
        name: bindings.name === undefined ? name : bindings.name,
        base: merged,
      });
    },
  };

  return logger;
}

/**
 * Convert a numeric level back to its name.
 *
 * @param {number} level Numeric level.
 * @returns {string} The level name.
 */
function levelToName(level) {
  for (const [levelName, value] of Object.entries(LEVELS)) {
    if (value === level) {
      return levelName;
    }
  }
  return String(level);
}

module.exports = { createLogger, DEFAULT_LEVEL };