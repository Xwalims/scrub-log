'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLogger, DEFAULT_LEVEL } = require('../src/logger.js');
const { REDACTED } = require('../src/redact.js');
const { ANSI } = require('../src/formatter.js');
const { createFakeStream } = require('./helpers/fake-stream.js');

/**
 * Return the `msg` of every record written to a fake stream.
 *
 * @param {{records: () => object[]}} stream The fake stream.
 * @returns {string[]} The messages, in order.
 */
function messages(stream) {
  return stream.records().map((record) => record.msg);
}

test('a new logger defaults to the info level', () => {
  assert.equal(DEFAULT_LEVEL, 'info');
  const stream = createFakeStream();
  const log = createLogger({ stream });
  assert.equal(log.level(), 'info');
});

test('log.info writes one ndjson record with the header fields', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, name: 'api' });
  log.info('listening', { port: 8080 });

  assert.equal(stream.lines().length, 1);
  const record = stream.records()[0];
  assert.equal(record.level, 'info');
  assert.equal(record.msg, 'listening');
  assert.equal(record.name, 'api');
  assert.equal(record.port, 8080);
  assert.deepEqual(Object.keys(record), ['time', 'level', 'msg', 'name', 'port']);
  assert.ok(!Number.isNaN(Date.parse(record.time)));
});

test('records below the threshold are dropped', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, level: 'warn' });
  log.trace('t');
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  log.fatal('f');

  assert.deepEqual(messages(stream), ['w', 'e', 'f']);
});

test('the threshold includes the chosen level itself', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, level: 'error' });
  log.warn('ignored');
  log.error('kept');
  assert.deepEqual(messages(stream), ['kept']);
});

test('log.level reads and updates the threshold', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, level: 'error' });
  log.info('hidden');
  assert.equal(stream.chunks.length, 0);

  log.level('debug');
  assert.equal(log.level(), 'debug');
  log.debug('now visible');
  assert.deepEqual(messages(stream), ['now visible']);
});

test('log.level rejects an unknown level name', () => {
  const log = createLogger({ stream: createFakeStream() });
  assert.throws(() => log.level('verbose'), RangeError);
});

test('an invalid configured level falls back to the default', () => {
  const log = createLogger({ stream: createFakeStream(), level: 'nonsense' });
  assert.equal(log.level(), 'info');
});

test('a numeric level is accepted', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, level: 50 });
  log.info('hidden');
  log.error('kept');
  assert.deepEqual(messages(stream), ['kept']);
});

test('base fields are merged into every record', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, base: { requestId: 'abc-123' } });
  log.info('one');
  log.info('two');
  for (const record of stream.records()) {
    assert.equal(record.requestId, 'abc-123');
  }
});

test('call fields override base fields', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, base: { region: 'eu' } });
  log.info('one', { region: 'us' });
  assert.equal(stream.records()[0].region, 'us');
});

test('secrets are redacted in fields', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream });
  log.info('login', { password: 'hunter2', token: 'abc' });
  const record = stream.records()[0];
  assert.equal(record.password, REDACTED);
  assert.equal(record.token, REDACTED);
});

test('secrets are redacted in the message', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream });
  log.info('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 for user@example.com');
  const record = stream.records()[0];
  assert.equal(record.msg, 'token [REDACTED_GITHUB_TOKEN] for [REDACTED_EMAIL]');
});

test('secrets are redacted in base fields', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, base: { apiKey: 'super-secret' } });
  log.info('ready');
  assert.equal(stream.records()[0].apiKey, REDACTED);
});

test('an Error field is serialised with name, message, stack and cause', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream });
  const cause = new Error('db refused for user@example.com');
  const error = new Error('query failed', { cause });
  log.error('request failed', { err: error });

  const record = stream.records()[0];
  assert.equal(record.err.name, 'Error');
  assert.equal(record.err.message, 'query failed');
  assert.equal(record.err.cause.message, 'db refused for [REDACTED_EMAIL]');
  assert.ok(record.err.stack.includes('Error: query failed'));
});

test('a child logger inherits the parent configuration', () => {
  const stream = createFakeStream();
  const parent = createLogger({ stream, name: 'api', level: 'warn' });
  const child = parent.child({ component: 'db' });

  child.error('failed');
  const record = stream.records()[0];
  assert.equal(record.name, 'api');
  assert.equal(record.component, 'db');
});

test('parent bindings come before child bindings', () => {
  const stream = createFakeStream();
  const parent = createLogger({ stream, base: { a: 1, b: 2 } });
  const child = parent.child({ b: 3, c: 4 });
  child.info('x');

  assert.deepEqual(Object.keys(stream.records()[0]), ['time', 'level', 'msg', 'a', 'b', 'c']);
  assert.equal(stream.records()[0].b, 3);
});

test('child bindings override parent bindings of the same name', () => {
  const stream = createFakeStream();
  const parent = createLogger({ stream, base: { region: 'eu' } });
  parent.child({ region: 'us' }).info('x');
  assert.equal(stream.records()[0].region, 'us');
});

test('a child level change does not affect the parent', () => {
  const stream = createFakeStream();
  const parent = createLogger({ stream, level: 'error' });
  const child = parent.child({ id: 1 });
  child.level('trace');

  child.debug('child sees this');
  parent.debug('parent does not');
  assert.deepEqual(messages(stream), ['child sees this']);
});

test('child rejects non-object bindings', () => {
  const parent = createLogger({ stream: createFakeStream() });
  assert.throws(() => parent.child('nope'), TypeError);
  assert.throws(() => parent.child([1, 2]), TypeError);
  assert.throws(() => parent.child(null), TypeError);
});

test('a child name can override the parent name', () => {
  const stream = createFakeStream();
  const parent = createLogger({ stream, name: 'api' });
  parent.child({ name: 'worker' }).info('x');
  assert.equal(stream.records()[0].name, 'worker');
});

test('arguments may be given in either order', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream });
  log.info({ port: 8080 }, 'listening');
  const record = stream.records()[0];
  assert.equal(record.msg, 'listening');
  assert.equal(record.port, 8080);
});

test('a non-object field argument is kept as a detail field', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream });
  log.info('count', 42);
  assert.equal(stream.records()[0].detail, 42);
});

test('a non-string message is rendered as a string', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream });
  log.info(42);
  log.info(null);
  log.info({ a: 1 });
  assert.deepEqual(stream.records().map((r) => r.msg), ['42', 'null', '{"a":1}']);
});

test('an Error passed as the message uses its message text', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream });
  log.error(new Error('kaboom for user@example.com'));
  assert.equal(stream.records()[0].msg, 'kaboom for [REDACTED_EMAIL]');
});

test('redaction can be disabled', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, redact: false });
  log.info('password=hunter2');
  assert.equal(stream.records()[0].msg, 'password=hunter2');
});

test('redactOptions are forwarded to the engine', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, redactOptions: { redactIp: true } });
  log.info('from 10.0.0.1');
  assert.equal(stream.records()[0].msg, 'from [REDACTED_IP]');
});

test('the pretty format is available through the logger', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream, format: 'pretty', color: false, name: 'api' });
  log.info('ready', { port: 1 });
  assert.match(stream.output(), /INFO {2}\[api\] port=1 ready\n$/);
});

test('colour is enabled automatically for a TTY stream', () => {
  const stream = createFakeStream({ isTTY: true });
  createLogger({ stream, format: 'pretty' }).info('x');
  assert.ok(stream.output().includes(ANSI.green));
});

test('colour is off for a non-TTY stream', () => {
  const stream = createFakeStream({ isTTY: false });
  createLogger({ stream, format: 'pretty' }).info('x');
  assert.equal(stream.output().includes('['), false);
});

test('a stream failure is swallowed and reported once on stderr', (t) => {
  const stream = createFakeStream({ failWith: new Error('EPIPE') });
  const log = createLogger({ stream });

  const written = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = originalWrite;
  });

  assert.doesNotThrow(() => {
    log.info('one');
    log.info('two');
    log.info('three');
  });
  assert.equal(written.length, 1, 'expected exactly one stderr report');
  assert.ok(written[0].includes('failed to write log record'));
  assert.ok(written[0].includes('EPIPE'));
});

test('createLogger validates its stream option', () => {
  assert.throws(() => createLogger({ stream: null }), TypeError);
  assert.throws(() => createLogger({ stream: 42 }), TypeError);
  assert.throws(() => createLogger({ stream: {} }), TypeError);
});

test('createLogger validates its base option', () => {
  assert.throws(() => createLogger({ base: null }), TypeError);
  assert.throws(() => createLogger({ base: [1] }), TypeError);
});

test('createLogger rejects an unknown format', () => {
  assert.throws(() => createLogger({ format: 'xml' }), TypeError);
});

test('a circular field does not break logging', () => {
  const stream = createFakeStream();
  const log = createLogger({ stream });
  const node = { id: 1 };
  node.self = node;
  log.info('cycle', { node });

  const record = stream.records()[0];
  assert.equal(record.node.id, 1);
  assert.equal(record.node.self, '[Circular]');
});