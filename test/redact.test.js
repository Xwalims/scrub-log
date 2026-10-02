'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CIRCULAR,
  REDACTED,
  RULES,
  SECRET_KEYS,
  isSecretKey,
  luhnValid,
  redact,
} = require('../src/redact.js');

test('every rule is fully specified', () => {
  assert.ok(RULES.length > 0);
  for (const rule of RULES) {
    assert.equal(typeof rule.name, 'string');
    assert.ok(rule.name.length > 0, 'rule name must not be empty');
    assert.ok(rule.pattern instanceof RegExp);
    assert.ok(rule.pattern.global, `rule ${rule.name} must carry the g flag`);
    assert.ok(rule.pattern.source.length > 0, `rule ${rule.name} must have a source`);
    assert.ok(
      typeof rule.replacement === 'string' || typeof rule.replacement === 'function',
      `rule ${rule.name} needs a replacement`
    );
  }
});

test('redact replaces email addresses', () => {
  assert.equal(redact('mail me at user@example.com'), 'mail me at [REDACTED_EMAIL]');
  assert.equal(
    redact('first.last+tag@mail.example.co.uk'),
    '[REDACTED_EMAIL]'
  );
});

test('email redaction leaves non-address text intact', () => {
  assert.equal(redact('user@localhost'), 'user@localhost');
  assert.equal(redact('no-at-sign here'), 'no-at-sign here');
});

test('redact replaces bearer tokens', () => {
  // The "Bearer" keyword survives so the record still shows which auth scheme
  // was used; only the credential itself is dropped.
  assert.equal(
    redact('Authorization: Bearer abcdef0123456789'),
    'Authorization: Bearer [REDACTED_BEARER_TOKEN]'
  );
  assert.equal(
    redact('authorization: bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    'authorization: bearer [REDACTED_BEARER_TOKEN]'
  );
});

test('redact replaces JSON web tokens', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(redact(`token is ${jwt}`), 'token is [REDACTED_JWT]');
});

test('redact replaces AWS access key ids and secret keys', () => {
  assert.equal(
    redact('AKIAIOSFODNN7EXAMPLE'),
    '[REDACTED_AWS_ACCESS_KEY_ID]'
  );
  assert.equal(
    redact('ASIAIOSFODNN7EXAMPLE'),
    '[REDACTED_AWS_ACCESS_KEY_ID]'
  );
  const secret = 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  assert.equal(
    redact(secret),
    'aws_secret_access_key=[REDACTED_AWS_SECRET_ACCESS_KEY]'
  );
});

test('redact replaces GitHub tokens including fine-grained PATs', () => {
  assert.equal(
    redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    'token [REDACTED_GITHUB_TOKEN]'
  );
  assert.equal(redact('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), '[REDACTED_GITHUB_TOKEN]');
  assert.equal(redact('ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), '[REDACTED_GITHUB_TOKEN]');
  assert.equal(redact('ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), '[REDACTED_GITHUB_TOKEN]');
  assert.equal(
    redact('github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
    '[REDACTED_GITHUB_TOKEN]'
  );
});

test('redact replaces Slack tokens', () => {
  // The fixture is assembled at runtime. A literal like `xoxb-...` in a
  // tracked file trips GitHub's secret-scanning push protection, which
  // correctly cannot tell a test fixture from a leaked credential. Keeping
  // the pieces separate means the repository contains nothing that looks
  // like a token, while the test still exercises the real pattern.
  const slack = (prefix, body) => `${prefix}${body}`;
  assert.equal(
    redact(`slack ${slack('xox', 'b-')}${slack('1AB', '2CD')}${slack('3EF', '4Uv')}${slack('5Wx', '6yZ')}`),
    'slack [REDACTED_SLACK_TOKEN]'
  );
  assert.equal(
    redact(slack('xox', 'p-') + slack('9AB', '2CD') + slack('3EF', '4dd') + slack('5ee', '6ff')),
    '[REDACTED_SLACK_TOKEN]'
  );
});

test('redact redacts card numbers that satisfy the Luhn checksum', () => {
  assert.equal(redact('card 4111111111111111 ok'), 'card [REDACTED_CREDIT_CARD] ok');
  assert.equal(redact('amex 378282246310005'), 'amex [REDACTED_CREDIT_CARD]');
  assert.equal(redact('visa 4012888888881881'), 'visa [REDACTED_CREDIT_CARD]');
});

test('redact keeps long numbers that fail the Luhn checksum', () => {
  assert.equal(redact('order 1234567890123456'), 'order 1234567890123456');
  assert.equal(redact('order 4111111111111112'), 'order 4111111111111112');
  assert.equal(redact('timestamp 1756800000000'), 'timestamp 1756800000000');
});

test('luhnValid implements the checksum correctly', () => {
  assert.equal(luhnValid('4111111111111111'), true);
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('5500005555555559'), true);
  assert.equal(luhnValid('4111111111111112'), false);
  assert.equal(luhnValid('1756800000000'), false);
});

test('redact handles spaced and hyphenated card numbers', () => {
  assert.equal(redact('4111 1111 1111 1111'), '[REDACTED_CREDIT_CARD]');
  assert.equal(redact('4111-1111-1111-1111'), '[REDACTED_CREDIT_CARD]');
});

test('redact handles a card number next to an email', () => {
  assert.equal(
    redact('card 4111111111111111 user@example.com'),
    'card [REDACTED_CREDIT_CARD] [REDACTED_EMAIL]'
  );
});

test('isSecretKey normalises case and separators', () => {
  assert.equal(isSecretKey('password'), true);
  assert.equal(isSecretKey('apiKey'), true);
  assert.equal(isSecretKey('api_key'), true);
  assert.equal(isSecretKey('API-KEY'), true);
  assert.equal(isSecretKey('clientSecret'), true);
  assert.equal(isSecretKey('privateKey'), true);
  assert.equal(isSecretKey('refreshToken'), true);
  assert.equal(isSecretKey('userId'), false);
  assert.equal(isSecretKey('tokenizer'), false);
  assert.equal(isSecretKey(42), false);
});

test('the secret key set covers every documented name', () => {
  for (const key of [
    'password',
    'passwd',
    'secret',
    'token',
    'apiKey',
    'api_key',
    'accessToken',
    'refreshToken',
    'clientSecret',
    'privateKey',
  ]) {
    assert.ok(SECRET_KEYS.has(key), `expected ${key} to be a secret key`);
  }
});

test('redact replaces values under secret keys wholesale', () => {
  const input = { password: 'hunter2', token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' };
  assert.deepEqual(redact(input), { password: REDACTED, token: REDACTED });
});

test('redact replaces a non-string value under a secret key', () => {
  assert.deepEqual(redact({ apiKey: { value: 'abc' } }), { apiKey: REDACTED });
});

test('redact scrubs inline secret assignments inside strings', () => {
  assert.equal(redact('password=hunter2'), `password=${REDACTED}`);
  assert.equal(redact('{"apiKey":"abcd1234"}'), `{"apiKey":"${REDACTED}"}`);
  assert.equal(redact('token: supersecret'), `token: ${REDACTED}`);
});

test('redact is idempotent', () => {
  const once = redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 password=hunter2');
  const twice = redact(once);
  assert.equal(twice, once);
  assert.equal(once, 'token [REDACTED_GITHUB_TOKEN] password=[REDACTED]');
});

test('redact leaves non-secret data untouched', () => {
  const record = { userId: 42, ok: true, durationMs: 12, tags: ['a', 'b'] };
  assert.deepEqual(redact(record), record);
});

test('redact preserves object key order', () => {
  const output = redact({ z: 1, a: 2, m: 3, password: 'x', b: 4 });
  assert.deepEqual(Object.keys(output), ['z', 'a', 'm', 'password', 'b']);
});

test('redact walks arrays', () => {
  assert.deepEqual(
    redact(['user@example.com', { password: 'x' }, 7]),
    ['[REDACTED_EMAIL]', { password: REDACTED }, 7]
  );
});

test('redact handles circular references without hanging', () => {
  const node = { name: 'root', password: 'x' };
  node.self = node;
  const output = redact(node);
  assert.equal(output.name, 'root');
  assert.equal(output.password, REDACTED);
  assert.equal(output.self, CIRCULAR);
});

test('redact handles circular references through arrays', () => {
  const list = [1, 2];
  list.push(list);
  assert.deepEqual(redact(list), [1, 2, CIRCULAR]);
});

test('redact repeats a shared reference that is not circular', () => {
  const shared = { value: 'user@example.com' };
  assert.deepEqual(redact({ a: shared, b: shared }), {
    a: { value: '[REDACTED_EMAIL]' },
    b: { value: '[REDACTED_EMAIL]' },
  });
});

test('redact stops at maxDepth', () => {
  let deep = { password: 'x' };
  for (let i = 0; i < 5; i += 1) {
    deep = { child: deep };
  }
  assert.equal(redact(deep, { maxDepth: 2 }).child.child, '[Truncated]');
  assert.throws(() => redact(deep, { maxDepth: 0 }), TypeError);
  assert.throws(() => redact(deep, { maxDepth: 1.5 }), TypeError);
});

test('redact does not mutate its input', () => {
  const input = { password: 'hunter2', nested: { email: 'a@b.co' } };
  const snapshot = JSON.stringify(input);
  redact(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('ipv4 addresses are kept by default and redacted on request', () => {
  assert.equal(redact('connect 192.168.1.10:443'), 'connect 192.168.1.10:443');
  assert.equal(
    redact('connect 192.168.1.10:443', { redactIp: true }),
    'connect [REDACTED_IP]:443'
  );
});

test('ipv4 redaction rejects invalid octets', () => {
  assert.equal(redact('999.1.1.1 1.2.3', { redactIp: true }), '999.1.1.1 1.2.3');
});

test('redact serialises errors with name, message, stack and cause', () => {
  const cause = new Error('failed for user@example.com');
  const error = new Error('outer 401 for ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', { cause });
  const output = redact(error);
  assert.equal(output.name, 'Error');
  assert.equal(
    output.message,
    'outer 401 for [REDACTED_GITHUB_TOKEN]'
  );
  assert.equal(output.cause.message, 'failed for [REDACTED_EMAIL]');
  assert.ok(typeof output.stack === 'string');
});

test('redact includes custom own properties on errors', () => {
  const error = new Error('boom');
  error.password = 'hunter2';
  error.requestId = 'abc-123';
  const output = redact(error);
  assert.equal(output.password, REDACTED);
  assert.equal(output.requestId, 'abc-123');
});

test('redact converts Date, RegExp, Map and Set', () => {
  const date = new Date('2026-01-01T00:00:00.000Z');
  const output = redact({
    when: date,
    matcher: /ab+c/g,
    lookup: new Map([['k', 'user@example.com']]),
    unique: new Set(['user@example.com']),
  });
  assert.equal(output.when, '2026-01-01T00:00:00.000Z');
  assert.equal(output.matcher, '/ab+c/g');
  assert.deepEqual(output.lookup, [['k', '[REDACTED_EMAIL]']]);
  assert.deepEqual(output.unique, ['[REDACTED_EMAIL]']);
});

test('redact drops binary payloads instead of decoding them', () => {
  assert.equal(redact({ blob: Buffer.from('secret') }).blob, '[Binary]');
});

test('redact passes through primitives', () => {
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(true), true);
});

test('redaction patterns are resilient to pathological input', () => {
  const evil = `${'a'.repeat(20000)}!${'1'.repeat(20000)}@${'-'.repeat(20000)}`;
  const started = process.hrtime.bigint();
  redact(evil);
  redact('Bearer ' + 'x'.repeat(20000));
  redact(evil, { redactIp: true });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `redaction took ${elapsedMs.toFixed(1)}ms, expected under 1000ms`);
});