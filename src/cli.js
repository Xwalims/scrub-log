'use strict';

const { isLevel } = require('./levels.js');
const { createLogger } = require('./logger.js');

/**
 * Command line interface.
 *
 * The CLI exists mainly as a demonstration that redaction works on real data
 * arriving from a pipe:
 *
 * ```sh
 * echo 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' | scrub-log
 * ```
 *
 * @module cli
 */

/**
 * Usage text shown for `--help` and on a usage error.
 *
 * @type {string}
 */
const USAGE = `Usage: scrub-log [options] [--] [MESSAGE]

Options:
  --level <name>     Level of the emitted record: trace, debug, info, warn,
                     error or fatal (default: info)
  --format <name>    Output format: ndjson or pretty (default: ndjson)
  --no-redact        Disable automatic redaction (not recommended)
  --ip               Also redact IPv4 addresses
  --name <name>      Attach a logger name to the record
  -h, --help         Show this help
  -v, --version      Show the version

If MESSAGE is omitted, standard input is read and logged as the "input" field.
Everything after "--" is treated as the message.

Examples:
  scrub-log "listening on 8080"
  scrub-log --format pretty --level warn "disk usage at 92%"
  echo 'user@example.com' | scrub-log
`;

/**
 * Raised for a usage error so the caller can print usage and exit non-zero.
 */
class UsageError extends Error {
  /**
   * @param {string} message Description of the problem.
   */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Parse command line arguments.
 *
 * Hand-rolled to keep the package dependency-free. Supports `--flag`,
 * `--flag=value` and `--flag value`, plus `--` to end option parsing.
 *
 * @param {ReadonlyArray<string>} argv Arguments after `node` and the script path.
 * @returns {{level: string, format: string, redact: boolean, redactIp: boolean,
 *   name: string|undefined, help: boolean, version: boolean, message: string|undefined}}
 *   The parsed options.
 * @throws {UsageError} If an option is unknown or a value is missing.
 */
function parseArgs(argv) {
  const options = {
    level: 'info',
    format: 'ndjson',
    redact: true,
    redactIp: false,
    name: undefined,
    help: false,
    version: false,
    message: undefined,
  };

  /**
   * Read the value for an option that requires one.
   *
   * @param {string} inline Value supplied with `=`, or undefined.
   * @param {string} name Option name for error messages.
   * @param {number} index Current argument index.
   * @param {ReadonlyArray<string>} args All arguments.
   * @returns {string} The option value.
   * @throws {UsageError} If no value is present.
   */
  const takeValue = (inline, name, index, args) => {
    if (inline !== undefined) {
      return inline;
    }
    const next = args[index + 1];
    if (next === undefined) {
      throw new UsageError(`option ${name} requires a value`);
    }
    return next;
  };

  /**
   * Advance the loop index past a consumed value.
   *
   * @param {number} index Current index.
   * @param {string|undefined} inline Inline value, if any.
   * @returns {number} The index to continue from.
   */
  const skip = (index, inline) => (inline === undefined ? index + 1 : index);

  let endOfOptions = false;
  const words = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (endOfOptions || !arg.startsWith('-') || arg === '-') {
      words.push(arg);
      continue;
    }

    if (arg === '--') {
      endOfOptions = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      const inline = equals === -1 ? undefined : arg.slice(equals + 1);

      switch (name) {
        case 'level': {
          const value = takeValue(inline, '--level', i, argv);
          if (!isLevel(value)) {
            throw new UsageError(
              `invalid --level ${JSON.stringify(value)}; expected trace, debug, info, warn, error or fatal`
            );
          }
          options.level = value.trim().toLowerCase();
          i = skip(i, inline);
          break;
        }
        case 'format': {
          const value = takeValue(inline, '--format', i, argv);
          if (value !== 'ndjson' && value !== 'pretty') {
            throw new UsageError(
              `invalid --format ${JSON.stringify(value)}; expected ndjson or pretty`
            );
          }
          options.format = value;
          i = skip(i, inline);
          break;
        }
        case 'no-redact':
          options.redact = false;
          break;
        case 'redact':
          options.redact = true;
          break;
        case 'ip':
          options.redactIp = true;
          break;
        case 'name': {
          const value = takeValue(inline, '--name', i, argv);
          options.name = value;
          i = skip(i, inline);
          break;
        }
        case 'help':
          options.help = true;
          break;
        case 'version':
          options.version = true;
          break;
        default:
          throw new UsageError(`unknown option ${JSON.stringify(`--${name}`)}`);
      }
      continue;
    }

    // Short options.
    switch (arg) {
      case '-h':
        options.help = true;
        break;
      case '-v':
        options.version = true;
        break;
      default:
        throw new UsageError(`unknown option ${JSON.stringify(arg)}`);
    }
  }

  if (words.length > 0) {
    options.message = words.join(' ');
  }
  return options;
}

/**
 * Read all of a stream as UTF-8 and trim the result.
 *
 * @param {NodeJS.ReadableStream} stream Stream to drain.
 * @returns {Promise<string>} The trimmed input.
 */
function readStdin(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    stream.on('error', reject);
  });
}

/**
 * Look up the package version from its own `package.json`.
 *
 * @returns {string} The version string.
 */
function readVersion() {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Run the CLI.
 *
 * Writes exactly one log line to `stdout` and exits 0 on success. A usage error
 * writes to `stderr` and exits 2; `--help` and `--version` exit 0.
 *
 * @param {ReadonlyArray<string>} [argv=process.argv.slice(2)] Arguments to parse.
 * @param {object} [io] Injectable streams, for testing.
 * @param {NodeJS.ReadableStream} [io.stdin] Input stream.
 * @param {NodeJS.WritableStream} [io.stdout] Output stream.
 * @param {NodeJS.WritableStream} [io.stderr] Error stream.
 * @returns {Promise<number>} The process exit code.
 */
async function run(argv = process.argv.slice(2), io = {}) {
  const {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
  } = io;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`scrub-log: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (options.version) {
    stdout.write(`${readVersion()}\n`);
    return 0;
  }

  // `--level` selects the severity of the single record the CLI emits, not a
  // filtering threshold: there is only one record, so a threshold could only
  // suppress it entirely. The threshold is set to `trace` so the record is
  // always written.
  const log = createLogger({
    stream: stdout,
    level: 'trace',
    format: options.format,
    redact: options.redact,
    redactOptions: { redactIp: options.redactIp },
    color: false,
    ...(options.name === undefined ? {} : { name: options.name }),
  });

  if (options.message !== undefined && options.message !== '') {
    log[options.level](options.message);
  } else {
    const input = await readStdin(stdin);
    log[options.level]('input', { input: input === '' ? '(empty)' : input });
  }
  return 0;
}

/**
 * Entry point used by `bin/scrub-log.js`.
 *
 * @returns {Promise<void>} Resolves once the exit code has been applied.
 */
async function main() {
  let code = 0;
  try {
    code = await run();
  } catch (error) {
    process.stderr.write(`scrub-log: ${error && error.message}\n`);
    code = 1;
  }
  process.exitCode = code;
}

module.exports = { USAGE, UsageError, main, parseArgs, readVersion, run };