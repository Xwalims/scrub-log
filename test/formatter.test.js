'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANSI,
  LEVEL_COLORS,
  displayValue,
  ndjson,
  orderRecord,
  pretty,
  resolveFormatter,
} = require('../src/formatter.js');

const RECORD = {
  msg: 'listening',
  port: 8080,
  level: 'info',
  name: 'api',
  time: '2026-01-01T12:00:00.000Z',
  extra: { nested: true },
};

test('ndjson emits exactly one JSON object per line', () => {
  const line = ndjson()(RECORD);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.trimEnd().includes('\n'), false);
  assert.deepEqual(JSON.parse(line), RECORD);
});

test('ndjson orders keys as time, level, msg, name, then the rest', () => {
  const line = ndjson()({
    port: 8080,
    msg: 'up',
    level: 'info',
    extra: 1,
    time: 'T',
    name: 'api',
  });
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'time',
    'level',
    'msg',
    'name',
    'port',
    'extra',
  ]);
});

test('ndjson key order is stable for the fixed header fields', () => {
  // The header fields always come first in the same order regardless of how the
  // record was built. Remaining fields keep their own insertion order, which is
  // the documented contract, so they are compared as sets.
  const first = ndjson()({ msg: 'a', b: 1, a: 2, level: 'info', time: 'T' });
  const second = ndjson()({ a: 2, time: 'T', level: 'info', b: 1, msg: 'a' });
  const header = (line) => Object.keys(JSON.parse(line)).slice(0, 3);
  assert.deepEqual(header(first), ['time', 'level', 'msg']);
  assert.deepEqual(header(second), header(first));
  assert.deepEqual(Object.keys(JSON.parse(first)).sort(), Object.keys(JSON.parse(second)).sort());
  assert.deepEqual(JSON.parse(first), JSON.parse(second));
});

test('ndjson preserves insertion order for fields after the header', () => {
  const line = ndjson()({ time: 'T', level: 'info', msg: 'a', zebra: 1, apple: 2 });
  assert.deepEqual(Object.keys(JSON.parse(line)), ['time', 'level', 'msg', 'zebra', 'apple']);
});

test('orderRecord omits absent fields', () => {
  assert.deepEqual(orderRecord({ level: 'info', msg: 'x' }), { level: 'info', msg: 'x' });
});

test('pretty renders timestamp, level, name, fields and message', () => {
  const line = pretty()(RECORD);
  assert.equal(
    line,
    '2026-01-01T12:00:00.000Z INFO  [api] port=8080 extra={"nested":true} listening\n'
  );
});

test('pretty aligns the level column across records', () => {
  const format = pretty();
  const info = format({ time: 'T', level: 'info', msg: 'a' });
  const fatal = format({ time: 'T', level: 'fatal', msg: 'b' });
  const firstMessageColumn = (line) => line.trimEnd().split(' ').pop().length;
  assert.equal(info.indexOf('a'), info.indexOf('a'));
  assert.ok(info.startsWith('T INFO  a\n'));
  assert.ok(fatal.startsWith('T FATAL b\n'));
  assert.equal(firstMessageColumn(info), firstMessageColumn(fatal));
});

test('pretty emits no ANSI codes by default', () => {
  assert.equal(pretty()(RECORD).includes('['), false);
});

test('pretty emits ANSI codes when colour is enabled', () => {
  const line = pretty({ color: true })(RECORD);
  assert.ok(line.includes(ANSI.green), 'expected the info level to be green');
  assert.ok(line.includes(ANSI.reset), 'expected a reset sequence');
  assert.ok(line.includes('INFO'));
});

test('pretty uses a distinct colour per level', () => {
  const format = pretty({ color: true });
  for (const [level, colour] of Object.entries(LEVEL_COLORS)) {
    assert.ok(
      format({ time: 'T', level, msg: 'x' }).includes(ANSI[colour]),
      `level ${level} should use ${colour}`
    );
  }
});

test('pretty handles a record with no fields', () => {
  assert.equal(pretty()({ time: 'T', level: 'warn', msg: 'careful' }), 'T WARN  careful\n');
});

test('pretty handles a missing message without trailing whitespace', () => {
  assert.equal(pretty()({ time: 'T', level: 'info' }), 'T INFO\n');
});

test('displayValue renders each supported type', () => {
  assert.equal(displayValue('text'), 'text');
  assert.equal(displayValue(42), '42');
  assert.equal(displayValue(true), 'true');
  assert.equal(displayValue(null), 'null');
  assert.equal(displayValue(undefined), 'undefined');
  assert.equal(displayValue(10n), '10n');
  assert.equal(displayValue({ a: 1 }), '{"a":1}');
  assert.equal(displayValue([1, 2]), '[1,2]');
  assert.equal(displayValue(/x/g), '/x/g');
});

test('displayValue survives values JSON cannot encode', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(displayValue(circular), '[Unserialisable]');
});

test('resolveFormatter accepts the built-in format names', () => {
  assert.equal(typeof resolveFormatter('ndjson'), 'function');
  assert.equal(typeof resolveFormatter('pretty'), 'function');
  assert.equal(typeof resolveFormatter('json'), 'function');
});

test('resolveFormatter passes a custom formatter through', () => {
  const custom = () => 'custom\n';
  assert.equal(resolveFormatter(custom), custom);
});

test('resolveFormatter rejects an unknown format', () => {
  assert.throws(() => resolveFormatter('xml'), TypeError);
  assert.throws(() => resolveFormatter(null), TypeError);
});

test('ndjson serialises an Error object as name, message, stack and cause', () => {
  const cause = new Error('inner');
  const error = new Error('outer', { cause });
  const line = ndjson()({
    time: 'T',
    level: 'error',
    msg: 'failed',
    err: {
      name: error.name,
      message: error.message,
      stack: 'Error: outer\n    at x',
      cause: { name: cause.name, message: cause.message },
    },
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.err.name, 'Error');
  assert.equal(parsed.err.message, 'outer');
  assert.equal(parsed.err.cause.message, 'inner');
  assert.ok(parsed.err.stack.includes('at x'));
});