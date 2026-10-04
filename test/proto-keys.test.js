'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ndjson, pretty, orderRecord } = require('../src/formatter.js');
const { redact } = require('../src/redact.js');
const { createLogger } = require('../src/logger.js');

/**
 * Ground truth for every assertion below is `JSON.parse`: it creates an own
 * data property for the key name `__proto__`, which is a legal JSON object
 * member name. Each test therefore compares against `JSON.parse` of the same
 * bytes, not against the project's own expectations.
 *
 * Plain `target[key] = value` is not equivalent: `__proto__` is an inherited
 * ACCESSOR on `Object.prototype`, so assignment runs the setter and retargets
 * the prototype instead of creating a key. Verified to disappear on Node's
 * V8 for the emitted text, for `Object.keys`, and for `hasOwnProperty`.
 */
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// --- formatter -------------------------------------------------------------

test('ndjson keeps a field named __proto__ that JSON.parse produced', () => {
  const record = JSON.parse('{"msg":"m","__proto__":{"role":"admin"},"n":1}');
  const parsed = JSON.parse(ndjson()(record));

  assert.deepEqual(Object.keys(parsed), ['msg', '__proto__', 'n']);
  assert.equal(own(parsed, '__proto__'), true);
  // The payload must survive intact, not merely appear as a key.
  assert.deepEqual(parsed.__proto__, { role: 'admin' });
});

test('orderRecord does not retarget the prototype of its own output', () => {
  const record = JSON.parse('{"msg":"m","__proto__":{"role":"admin"}}');
  const ordered = orderRecord(record);

  assert.equal(Object.getPrototypeOf(ordered), Object.prototype);
  assert.equal(own(ordered, '__proto__'), true);
});

test('pretty prints a __proto__ field instead of dropping it', () => {
  const record = JSON.parse('{"msg":"m","__proto__":{"role":"admin"}}');
  const line = pretty()(record);

  assert.match(line, /__proto__=/);
  assert.match(line, /role/);
});

test('ndjson round-trips a document whose only unusual key is __proto__', () => {
  const record = JSON.parse('{"__proto__":{"p":1}}');
  const parsed = JSON.parse(ndjson()(record));

  // A one-field record used to serialise as `{}`.
  assert.notDeepEqual(parsed, {});
  assert.deepEqual(Object.keys(parsed), ['__proto__']);
  assert.deepEqual(parsed.__proto__, { p: 1 });
});

// --- redact ----------------------------------------------------------------

test('redact keeps a __proto__ field instead of walking past it', () => {
  const value = JSON.parse('{"__proto__":{"role":"admin"},"a":1}');
  const out = redact(value);

  assert.deepEqual(Object.keys(out), ['__proto__', 'a']);
  assert.equal(own(out, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(out.__proto__, { role: 'admin' });
});

test('a __proto__ field no longer lends fabricated properties to the output', () => {
  const value = JSON.parse('{"__proto__":{"isAdmin":true},"msg":"x"}');
  const out = redact(value);

  // Before the fix `out.isAdmin` read `true` straight off the attacker's object.
  assert.equal(out.isAdmin, undefined);
  assert.equal(own(out, 'isAdmin'), false);
  assert.equal(out.msg, 'x');
});

test('redact applies the secret-key policy to a __proto__ field', () => {
  const value = JSON.parse('{"__proto__":{"password":"hunter2"},"n":1}');
  const out = redact(value);

  // The nested object is a value, so its contents are scrubbed as strings; the
  // check that matters is that the key survived into the output at all.
  assert.equal(own(out, '__proto__'), true);
  assert.equal(JSON.stringify(out.__proto__).includes('hunter2'), false);
});

test('redact keeps an own __proto__ property attached to an Error', () => {
  const error = new Error('boom');
  Object.defineProperty(error, '__proto__', {
    value: { requestId: 'r-1' },
    writable: true,
    enumerable: true,
    configurable: true,
  });

  const out = redact(error);
  assert.equal(own(out, '__proto__'), true);
  assert.deepEqual(out.__proto__, { requestId: 'r-1' });
});

// --- logger ----------------------------------------------------------------

test('a __proto__ field reaches the output stream', () => {
  const chunks = [];
  const log = createLogger({ stream: { write: (c) => chunks.push(c) } });
  log.info('m', JSON.parse('{"__proto__":{"role":"admin"},"n":1}'));

  const parsed = JSON.parse(chunks[0]);
  assert.deepEqual(Object.keys(parsed), ['time', 'level', 'msg', '__proto__', 'n']);
  assert.deepEqual(parsed.__proto__, { role: 'admin' });
});

test('a __proto__ field never retargets the record prototype', () => {
  const chunks = [];
  const log = createLogger({ stream: { write: (c) => chunks.push(c) } });
  const extra = JSON.parse('{"__proto__":{"isAdmin":true}}');
  log.info('m', extra);

  // The emitted record is a plain object; the attacker's object is data.
  const parsed = JSON.parse(chunks[0]);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(parsed.isAdmin, undefined);
});

test('base bindings named __proto__ survive every emit', () => {
  const chunks = [];
  const log = createLogger({
    stream: { write: (c) => chunks.push(c) },
    base: JSON.parse('{"__proto__":{"from":"base"},"b":1}'),
  });
  log.info('m');

  const parsed = JSON.parse(chunks[0]);
  assert.equal(own(parsed, '__proto__'), true);
  assert.deepEqual(parsed.__proto__, { from: 'base' });
});

test('child() merge keeps a __proto__ binding from both sides', () => {
  const chunks = [];
  const parent = createLogger({
    stream: { write: (c) => chunks.push(c) },
    base: JSON.parse('{"__proto__":{"from":"base"},"b":1}'),
  });
  parent.child(JSON.parse('{"__proto__":{"from":"child"},"c":2}')).info('m');

  const parsed = JSON.parse(chunks[0]);
  assert.equal(own(parsed, '__proto__'), true);
  // Child bindings are applied after parent bindings, so the child wins.
  assert.deepEqual(parsed.__proto__, { from: 'child' });
  assert.equal(parsed.b, 1);
  assert.equal(parsed.c, 2);
});

// --- unserialisable header fields -----------------------------------------

// A template literal calls `ToPrimitive`, which throws for a value with no
// callable `toString` whose `valueOf` returns an object. Every one of these
// records reaches that state purely through data, so each header field must
// go through displayValue rather than string interpolation.
const UNPRIMITIVE = JSON.parse('[[],{"toString":null}]');

test('pretty survives a msg with no callable toString', () => {
  const line = pretty()({ time: 'T', level: 'info', msg: UNPRIMITIVE });
  assert.match(line, /^T INFO {2}/);
  assert.match(line, /toString/);
});

test('pretty survives an unstringable name field', () => {
  const line = pretty()({ time: 'T', level: 'info', msg: 'x', name: UNPRIMITIVE });
  assert.match(line, /^T INFO {2}\[/);
  assert.match(line, /toString/);
});

test('pretty survives an unstringable time field', () => {
  const line = pretty()({ time: UNPRIMITIVE, level: 'info', msg: 'x' });
  assert.match(line, /toString/);
  assert.match(line, /INFO/);
});

test('pretty survives an unstringable level field', () => {
  const line = pretty()({ time: 'T', level: UNPRIMITIVE, msg: 'x' });
  // No level colour exists for this value, so the fallback colour is used and
  // the rendered text still occupies the padded column.
  assert.match(line, /^T /);
  assert.match(line.trimEnd(), /x$/);
});

test('pretty survives an unstringable field value', () => {
  const line = pretty()({ time: 'T', level: 'info', msg: 'x', detail: UNPRIMITIVE });
  assert.match(line, /detail=/);
});

test('the header fields keep their existing rendering', () => {
  // The fix must not change any output that already worked. These are the
  // exact expectations asserted in test/formatter.test.js.
  const record = {
    msg: 'listening',
    port: 8080,
    level: 'info',
    name: 'api',
    time: '2026-01-01T12:00:00.000Z',
    extra: { nested: true },
  };
  assert.equal(pretty()(record),
    '2026-01-01T12:00:00.000Z INFO  [api] port=8080 extra={"nested":true} listening\n');
  assert.equal(pretty()({ time: 'T', level: 'info' }), 'T INFO\n');
  assert.equal(pretty()({ time: 'T', level: 'info', msg: 'x' }), 'T INFO  x\n');
  // An object message still renders as JSON, which is what it always did.
  assert.match(pretty()({ time: 'T', level: 'info', msg: { a: 1 } }), /INFO {2}\{"a":1\}\n$/);
});

test('constructor, toString and valueOf remain ordinary data fields', () => {
  const record = JSON.parse('{"constructor":1,"toString":2,"valueOf":3}');

  const parsed = JSON.parse(ndjson()(record));
  assert.deepEqual(Object.keys(parsed), ['constructor', 'toString', 'valueOf']);
  assert.equal(parsed.constructor, 1);
  assert.equal(parsed.toString, 2);

  // These are plain data properties on Object.prototype, so assignment already
  // shadows them correctly; escaping them would itself be a bug.
  assert.deepEqual(Object.keys(redact(record)), ['constructor', 'toString', 'valueOf']);
});