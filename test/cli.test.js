'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { USAGE, UsageError, parseArgs } = require('../src/cli.js');

const CLI = path.join(__dirname, '..', 'bin', 'scrub-log.js');

/**
 * Spawn the CLI and capture its exit code and streams.
 *
 * @param {string[]} args Arguments for the CLI.
 * @param {object} [options] Spawn options.
 * @param {string} [options.input] Data piped to standard input.
 * @returns {{status: number, stdout: string, stderr: string}} The result.
 */
function cli(args, options = {}) {
  const { input = '' } = options;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Parse a single stdout line as JSON.
 *
 * @param {string} stdout Raw stdout.
 * @returns {object} The parsed record.
 */
function record(stdout) {
  return JSON.parse(stdout.trim());
}

test('parseArgs applies defaults', () => {
  const options = parseArgs([]);
  assert.equal(options.level, 'info');
  assert.equal(options.format, 'ndjson');
  assert.equal(options.redact, true);
  assert.equal(options.redactIp, false);
  assert.equal(options.message, undefined);
});

test('parseArgs reads long options in both forms', () => {
  assert.equal(parseArgs(['--level', 'warn']).level, 'warn');
  assert.equal(parseArgs(['--level=warn']).level, 'warn');
  assert.equal(parseArgs(['--format', 'pretty']).format, 'pretty');
  assert.equal(parseArgs(['--format=pretty']).format, 'pretty');
  assert.equal(parseArgs(['--name=api']).name, 'api');
});

test('parseArgs accepts a level in mixed case', () => {
  assert.equal(parseArgs(['--level=WARN']).level, 'warn');
});

test('parseArgs handles the redaction flags', () => {
  assert.equal(parseArgs(['--no-redact']).redact, false);
  assert.equal(parseArgs(['--ip']).redactIp, true);
});

test('parseArgs joins words into one message', () => {
  assert.equal(parseArgs(['hello', 'there', 'world']).message, 'hello there world');
});

test('parseArgs stops option parsing after a double dash', () => {
  const options = parseArgs(['--', '--level', 'warn']);
  assert.equal(options.level, 'info');
  assert.equal(options.message, '--level warn');
});

test('parseArgs treats a lone dash as a message word', () => {
  assert.equal(parseArgs(['-']).message, '-');
});

test('parseArgs reports short options', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
});

test('parseArgs rejects an unknown option', () => {
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['-x']), UsageError);
});

test('parseArgs rejects a missing option value', () => {
  assert.throws(() => parseArgs(['--level']), UsageError);
  assert.throws(() => parseArgs(['--name']), UsageError);
});

test('parseArgs rejects an invalid level or format', () => {
  assert.throws(() => parseArgs(['--level=verbose']), UsageError);
  assert.throws(() => parseArgs(['--format=xml']), UsageError);
});

test('the CLI prints one ndjson record and exits 0', () => {
  const { status, stdout } = cli(['listening', 'on', 'port', '8080']);
  assert.equal(status, 0);
  assert.equal(stdout.trimEnd().split('\n').length, 1);

  const parsed = record(stdout);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'listening on port 8080');
  assert.ok(!Number.isNaN(Date.parse(parsed.time)));
});

test('the CLI redacts a message passed as an argument', () => {
  const { status, stdout } = cli(['token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
  assert.equal(status, 0);
  assert.equal(record(stdout).msg, 'token [REDACTED_GITHUB_TOKEN]');
});

test('the CLI redacts a message piped through stdin', () => {
  // A bare level name is consumed as the --level value, so the piped input is
  // logged as the "input" field rather than as the message.
  const { status, stdout } = cli(['--level=info'], {
    input: 'user@example.com password=hunter2',
  });
  assert.equal(status, 0);
  const parsed = record(stdout);
  assert.equal(parsed.msg, 'input');
  assert.equal(parsed.input, '[REDACTED_EMAIL] password=[REDACTED]');
});

test('the CLI logs piped input when no message is given', () => {
  const { status, stdout } = cli([], { input: 'plain log line' });
  assert.equal(status, 0);
  const parsed = record(stdout);
  assert.equal(parsed.msg, 'input');
  assert.equal(parsed.input, 'plain log line');
});

test('the CLI keeps the raw token out of piped output', () => {
  const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const { stdout } = cli([], { input: `token ${secret}` });
  assert.equal(stdout.includes(secret), false);
  assert.ok(stdout.includes('[REDACTED_GITHUB_TOKEN]'));
});

test('the CLI logs an empty stdin as a placeholder', () => {
  const { status, stdout } = cli([], { input: '   \n' });
  assert.equal(status, 0);
  assert.equal(record(stdout).input, '(empty)');
});

test('the CLI emits pretty output on request', () => {
  const { status, stdout } = cli(['--format=pretty', '--name=api', 'ready']);
  assert.equal(status, 0);
  assert.match(stdout, / INFO {2}\[api\] ready\n$/);
  // ANSI colour is only for a TTY, and spawned stdout is a pipe.
  assert.equal(stdout.includes('['), false);
});

test('the CLI honours --no-redact', () => {
  const { stdout } = cli(['--no-redact', 'password=hunter2']);
  assert.equal(record(stdout).msg, 'password=hunter2');
});

test('the CLI honours --ip', () => {
  const withIp = cli(['--ip', 'from 10.0.0.1']);
  assert.equal(record(withIp.stdout).msg, 'from [REDACTED_IP]');

  const withoutIp = cli(['from 10.0.0.1']);
  assert.equal(record(withoutIp.stdout).msg, 'from 10.0.0.1');
});

test('the CLI honours --level for the emitted record', () => {
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    const { status, stdout } = cli([`--level=${level}`, 'escalated']);
    assert.equal(status, 0);
    assert.equal(record(stdout).level, level);
  }
});

test('the CLI accepts a space-separated option value', () => {
  const { status, stdout } = cli(['--level', 'error', 'escalated']);
  assert.equal(status, 0);
  assert.equal(record(stdout).level, 'error');
});

test('the CLI prints help and exits 0', () => {
  const { status, stdout } = cli(['--help']);
  assert.equal(status, 0);
  assert.equal(stdout, USAGE);
});

test('the CLI prints its version and exits 0', () => {
  const { status, stdout } = cli(['--version']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), require('../package.json').version);
});

test('the CLI exits 2 with usage on a bad option', () => {
  const { status, stdout, stderr } = cli(['--nope']);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('unknown option'));
  assert.ok(stderr.includes('Usage: scrub-log'));
});

test('the CLI exits 2 on an invalid level', () => {
  const { status, stderr } = cli(['--level=verbose']);
  assert.equal(status, 2);
  assert.ok(stderr.includes('invalid --level'));
});

test('the CLI exits 2 when an option value is missing', () => {
  const { status, stderr } = cli(['--level']);
  assert.equal(status, 2);
  assert.ok(stderr.includes('requires a value'));
});