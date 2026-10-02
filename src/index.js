'use strict';

/**
 * Public entry point for the `scrub-log` package.
 *
 * @example
 * const { createLogger } = require('scrub-log');
 * const log = createLogger({ name: 'api' });
 * log.info('ready', { port: 8080 });
 */

const { createLogger, DEFAULT_LEVEL } = require('./logger.js');
const {
  CIRCULAR,
  REDACTED,
  RULES,
  SECRET_KEYS,
  isSecretKey,
  luhnValid,
  redact,
} = require('./redact.js');
const {
  LEVELS,
  LEVEL_NAMES,
  fromName,
  isLevel,
  shouldLog,
} = require('./levels.js');
const {
  ANSI,
  ndjson,
  pretty,
  resolveFormatter,
} = require('./formatter.js');

module.exports = {
  // logger
  createLogger,
  DEFAULT_LEVEL,
  // levels
  LEVELS,
  LEVEL_NAMES,
  fromName,
  isLevel,
  shouldLog,
  // redaction
  CIRCULAR,
  REDACTED,
  RULES,
  SECRET_KEYS,
  isSecretKey,
  luhnValid,
  redact,
  // formatting
  ANSI,
  ndjson,
  pretty,
  resolveFormatter,
};