# scrub-log

A small structured logger for Node.js that redacts secrets before they reach
your log stream.

`scrub-log` writes newline-delimited JSON (ndjson) or aligned pretty output, and
every record is passed through a redaction engine first. Credentials that end up
in log output by accident, because somebody logged a request object or a config
blob, are replaced with a marker before a single byte is written.

- Zero runtime dependencies. CommonJS, Node.js 20 or newer.
- 151 tests using the built-in `node:test` runner.
- Redaction is on by default and cannot be forgotten at a call site.

<!-- hero -->

[![CI](https://github.com/Xwalims/scrub-log/actions/workflows/ci.yml/badge.svg)](https://github.com/Xwalims/scrub-log/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [Usage](#usage)
  - [Levels](#levels)
- [Redaction rules](#redaction-rules)
  - [Field names that collide with the prototype](#field-names-that-collide-with-the-prototype)
- [`createLogger(options?)`](#createloggeroptions)
  - [`redact(value, options?)`](#redactvalue-options)
  - [Level helpers](#level-helpers)
  - [Formatters](#formatters)

<!-- /hero -->

## Why redaction matters

Logs are copied. They are shipped to aggregation services, attached to bug
reports, pasted into chat, and kept for months in shared storage. A single
`console.log(config)` or a logged HTTP request can therefore publish a live API
key to every system that can read the log, long after the process that wrote it
is gone.

Two properties make this worse:

1. The exposure is usually silent. Nothing fails at the point of logging, so
   there is no signal that a credential was published.
2. Review happens late. The code that logs the secret was written weeks earlier
   and looks harmless, and nobody re-reads it before an incident.

Removing the value at the point of writing is the cheapest fix. `scrub-log`
redacts by default, so a record is scrubbed whether or not the call site
remembered to be careful. The value is never written to the stream, so it cannot
be recovered from log storage, an aggregation index, or a support ticket.

Redaction is a safety net, not a licence to log secrets on purpose. It is
pattern-based, so it cannot recognise a secret that looks like nothing in
particular. Do not log credentials deliberately, and keep real secrets in an
environment variable or a secret manager.

## Install

This package is **not published to npm** — the name is unregistered, so
`npm install scrub-log` fails. Clone and run it directly:

```sh
git clone https://github.com/Xwalims/scrub-log.git
cd scrub-log
node --test
node bin/scrub-log.js "hello"
```

To get the `scrub-log` command on your `PATH`, use `npm link` from the checkout.

## Usage

```js
const { createLogger } = require('scrub-log');

const log = createLogger({ name: 'api', level: 'info' });

log.info('server listening on port 8080');
```

```json
{"time":"2026-10-02T08:42:56.069Z","level":"info","msg":"server listening on port 8080"}
```

Structured fields are passed as a second argument:

```js
const log = createLogger({ name: 'api', base: { requestId: 'req_7f3a' } });

log.info('cache miss', { key: 'session:abc' });
log.warn('retrying upstream call', { attempt: 2, endpoint: 'https://api.example.com/v1' });
```

```json
{"time":"2026-10-02T08:43:11.351Z","level":"info","msg":"cache miss","name":"api","requestId":"req_7f3a","key":"session:abc"}
{"time":"2026-10-02T08:43:11.353Z","level":"warn","msg":"retrying upstream call","name":"api","requestId":"req_7f3a","attempt":2,"endpoint":"https://api.example.com/v1"}
```

Errors are serialised as `name`, `message`, `stack` and `cause`, so a stack
survives into the log without needing a custom serialiser:

```js
log.error('request failed', { err: new Error('upstream said 401') });
```

```json
{"time":"2026-10-02T08:43:11.353Z","level":"error","msg":"request failed","name":"api","requestId":"req_7f3a","err":{"name":"Error","message":"upstream said 401","stack":"Error: upstream said 401\n    at ..."}}
```

Pretty output is for a terminal, where colour and alignment help:

```sh
$ scrub-log --format pretty --name api "checkout failed for user@example.com"
2026-10-02T08:42:56.283Z INFO  [api] checkout failed for [REDACTED_EMAIL]
```

The bundled CLI reads standard input when no message is given, which makes it a
quick way to check what redaction does to real input:

```sh
$ printf 'user@example.com card 4111111111111111 token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n' \
    | scrub-log --level warn --name billing --format pretty
2026-10-02T08:43:10.168Z WARN  [billing] input=[REDACTED_EMAIL] card [REDACTED_CREDIT_CARD] token [REDACTED_GITHUB_TOKEN] input
```

Note the order of the fields: the message `input` comes first, then the piped
text, because the message is the record's headline and the pipe is a field on it.

### Levels

Levels follow the syslog scale, with gaps for future insertions. A record is
emitted when its level is greater than or equal to the logger threshold.

| Level  | Value | Use                                                  |
| ------ | ----- | ---------------------------------------------------- |
| `trace` | 10   | Very fine-grained diagnostics, usually disabled       |
| `debug` | 20   | Development detail that is not useful in production  |
| `info`  | 30   | Normal operational events, the default threshold      |
| `warn`  | 40   | Something unexpected that the process recovered from |
| `error` | 50   | A failure that needs attention                        |
| `fatal` | 60   | The process cannot continue                           |

## Redaction rules

Rules are applied in the order listed below. Specific credential formats are
matched before the generic key/value rule so a GitHub token is reported as a Git
Hub token rather than as an anonymous secret.

| Rule                    | Matches                                                              | Replaced with                       | Example output                              |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| `email`                 | Email addresses                                                        | `[REDACTED_EMAIL]`                  | `user@example.com`                          |
| `bearer`                | `Authorization: Bearer <token>`                                       | `Bearer [REDACTED_BEARER_TOKEN]`     | `Bearer eyJhbGci...`                        |
| `jwt`                   | Three base64url segments starting with `eyJ`                         | `[REDACTED_JWT]`                    | `eyJhbGci.eyJzdWIi.dBjftJeZ4`              |
| `aws-access-key-id`     | `AKIA`, `ASIA`, `AGPA`, `AIDA`, `AROA`, `ANPA` plus 12 to 20 chars     | `[REDACTED_AWS_ACCESS_KEY_ID]`      | `AKIAIOSFODNN7EXAMPLE`                      |
| `aws-secret-access-key` | `aws_secret_access_key` followed by 40 characters                     | `[REDACTED_AWS_SECRET_ACCESS_KEY]`  | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `github-token`          | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and `github_pat_` prefixes     | `[REDACTED_GITHUB_TOKEN]`           | `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`   |
| `slack-token`           | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-` prefixes                  | `[REDACTED_SLACK_TOKEN]`            | see `test/redact.test.js` |
| `credit-card`           | 13 to 19 digits that pass the Luhn checksum                           | `[REDACTED_CREDIT_CARD]`            | `4111111111111111`                         |
| `secret-key-value`      | `key: value` and `key=value` for secret-looking names                  | `[REDACTED]`                        | `password=hunter2`                         |
| `ipv4`                  | IPv4 addresses, only when `redactIp` is enabled                        | `[REDACTED_IP]`                     | `10.0.0.1`                                 |

Two of these deserve a note.

**The card rule is Luhn-checked on purpose.** A naive "redact any long number"
rule destroys ordinary data: timestamps such as `1756800000000`, order ids and
database keys are all 13 or more digits and would disappear. Requiring the Luhn
checksum reduces false positives to a negligible rate while still catching real
card numbers, and `9999999999999999999` stays in the log because it is not a card.

**IPv4 redaction is off by default.** This is a deliberate trade-off rather than
an oversight. Client IPs are frequently the single most useful field in a log:
you cannot investigate an outage, rate-limit an attacker, or diagnose a
geo-routing problem without them. Redacting them by default would break the main
reason to keep logs. Treat an IP address as personal data, and enable the option
where that matters:

```js
const log = createLogger({ redactOptions: { redactIp: true } });
```

```sh
scrub-log --ip "connect from 10.0.0.1"
```

Values stored under a secret-looking key are replaced wholesale, regardless of
what they contain, because the key itself is the signal. The comparison ignores
case and separators, so `apiKey`, `api_key`, `API-KEY` and `apikey` all match.
The recognised names are `password`, `passwd`, `pwd`, `pass`, `secret`, `secrets`,
`token`, `tokens`, `access_token`, `accessToken`, `refresh_token`,
`refreshToken`, `id_token`, `idToken`, `apiKey`, `api_key`, `apikey`, `apiSecret`,
`api_secret`, `accessKey`, `access_key`, `secretKey`, `secret_key`, `privateKey`,
`private_key`, `privatekey`, `clientSecret`, `client_secret`, `clientsecret`,
`credentials` and `authorization`.

### Why these patterns are safe to run on untrusted input

A logger sits on the hot path of every request, and its input is attacker-
controlled often enough that a catastrophic-backtracking pattern would be a
denial-of-service vector. Every pattern above is written to avoid it:

- No nested quantifiers. There is no `(x+)+` or `(a|b+)*` construction anywhere.
- Every repetition is bounded. Run lengths use explicit bounds such as `{16}`
  and `{13,19}`, so backtracking explores a fixed number of positions.
- Alternatives are distinguishable at the first character, so at most one
  branch can match at a position.
- The card rule matches a bounded digit run and then validates it with the
  Luhn algorithm in code, rather than trying to express card brands as a
  regex alternation, which is where most implementations introduce ambiguity.
- Recursion over nested values is bounded twice, by a `maxDepth` guard and by
  cycle detection, so `redact` always terminates.

The test suite includes a case that feeds each pattern 20,000 pathological
characters and asserts the call completes well under a second.

### Structural guarantees

- Key order is preserved, so a record reads the same before and after
  redaction.
- Circular references terminate as `'[Circular]'`. Detection tracks the current
  ancestor path rather than every object ever visited, so an object that
  legitimately appears twice as a sibling is redacted both times instead of
  being misreported as circular.
- `redact` never mutates its input; it returns a copy.
- Redaction is idempotent. Running it twice produces the same string, so a value
  that has already been redacted is not mangled further.
- A field named `__proto__` is data like any other. `JSON.parse` creates a real
  own property for that key name, and so does this library; see
  [Field names that collide with the prototype](#field-names-that-collide-with-the-prototype).
- Neither formatter throws on a value that has no callable `toString`. Header
  fields and field values are rendered through `displayValue`, which falls back
  to `'[Unserialisable]'` instead of letting `ToPrimitive` raise.

### Field names that collide with the prototype

`__proto__` is not a property of `Object.prototype`; it is an **accessor**
defined on it. So `target[key] = value` is not the same as "create a property
called `key`" for that one name: the assignment runs the setter, which replaces
the prototype of `target` and creates no key at all. The record then serialises
without the field, so the data is deleted and nothing reports it.

`__proto__` is a perfectly legal JSON member name, and a record assembled from
untrusted input may well carry one. `scrub-log` copies every data-derived key
with `Object.defineProperty` for this name, which is exactly what `JSON.parse`
does for the same bytes:

```js
const record = JSON.parse('{"msg":"m","__proto__":{"role":"admin"}}');

ndjson()(record);
// '{"msg":"m","__proto__":{"role":"admin"}}\n'

redact(record);
// { msg: 'm', __proto__: { role: 'admin' } }
```

Before the fix the same two calls returned `'{"msg":"m"}\n'` and
`{ msg: 'm' }`. The object also came back with the attacker-shaped payload as its
**prototype**, so an ordinary property read such as `record.role` returned
`'admin'` for a field the record never contained — a log redactor that invents
the field it reports on.

`constructor`, `toString`, `valueOf` and `hasOwnProperty` are deliberately left
alone. Those are ordinary data properties on the prototype, so plain assignment
shadows them correctly and the output stays faithful to the input; escaping them
would itself be a bug. There is a test asserting both directions.

The redaction walk and the logger's field merge (`Object.assign` and object
spread, both of which are assignment in disguise) are covered by
`test/proto-keys.test.js`, and a cross-seed differential oracle checks the
property:

```sh
node scripts/oracle-proto-keys.js <seed> <rounds>
```

It generates random documents that use prototype-colliding key names, parses
them with `JSON.parse` so the input genuinely holds own `__proto__` properties,
and asserts that `redact`, `ndjson` and the full logger path all expose exactly
the own-key set `JSON.parse` defines, with `Object.prototype` left in place.

## Library API

```js
const {
  createLogger,
  redact,
  fromName,
  shouldLog,
  isLevel,
  ndjson,
  pretty,
} = require('scrub-log');
```

### `createLogger(options?)`

| Option           | Type                       | Default        | Description                                        |
| ---------------- | -------------------------- | -------------- | -------------------------------------------------- |
| `name`           | `string`                   | none           | Name attached to every record                       |
| `level`          | `string \| number`         | `'info'`       | Minimum level to emit; an invalid value falls back to the default |
| `stream`         | `{ write(chunk) }`         | `process.stdout` | Destination stream                               |
| `redact`         | `boolean`                  | `true`         | Enable automatic redaction                          |
| `redactOptions`  | `object`                   | `{}`           | Options forwarded to `redact`                       |
| `format`         | `'ndjson' \| 'pretty' \| function` | `'ndjson'` | Formatter for each record                     |
| `base`           | `object`                   | `{}`           | Fields merged into every record                     |
| `color`          | `boolean`                  | `stream.isTTY` | Force ANSI colour on or off                         |

Returns `{ trace, debug, info, warn, error, fatal, child, level, bindings }`.

- Each log method accepts `(message, fields)`, and also `(fields, message)` for
  convenience.
- `child(bindings)` returns a logger that inherits the parent's configuration
  and merges `bindings` into every record. Parent bindings are emitted first,
  so a child binding of the same name wins. Changing the child's level does not
  affect the parent.
- `level()` returns the current level name; `level(name)` changes it and returns
  the new numeric level. An unknown name throws a `RangeError`.
- `bindings` exposes the base fields.

A write failure on the destination stream is swallowed and reported once on
standard error. A logger that throws while logging is worse than a logger that
loses a line.

### `redact(value, options?)`

Deeply redacts secrets from a value and returns a redacted copy.

| Option      | Type      | Default | Description                        |
| ----------- | --------- | ------- | ---------------------------------- |
| `redactIp`  | `boolean` | `false` | Also redact IPv4 addresses         |
| `maxDepth`  | `number`  | `12`    | Maximum recursion depth            |
| `rules`     | `Array`   | `RULES` | Replace the rule list entirely     |

Objects, arrays, strings, `Error` instances, `Map`, `Set`, `Date` and `RegExp`
are handled. Buffers and typed arrays are replaced with `'[Binary]'` rather than
decoded. Primitives pass through unchanged.

A `Map` becomes an array of entries, and the secret-key policy is applied to the
entry key as well as to its value: `new Map([['password', 'hunter2']])` is
redacted, exactly as `{ password: 'hunter2' }` is. A non-string key cannot name a
secret, so it is walked as a value like any other.

### Level helpers

- `LEVELS`, `LEVEL_NAMES` — the level table and its names in ascending order.
- `fromName(name)` — resolve a case-insensitive level name to its number.
  Throws `RangeError` for an unknown name.
- `isLevel(name)` — non-throwing validity check.
- `shouldLog(level, threshold)` — the threshold comparison used by every logger.

### Formatters

- `ndjson()` — one JSON object per line, with the header fields ordered
  `time`, `level`, `msg`, `name`, then remaining fields in their original order.
- `pretty({ color })` — aligned line for a terminal.
- `resolveFormatter(format, options)` — resolve a name or pass through a custom
  function.

ANSI colour is emitted only when the destination stream is a TTY, so redirected
and piped output never contains escape codes.

### Command line

```
Usage: scrub-log [options] [--] [MESSAGE]

Options:
  --level <name>     Level of the emitted record: trace, debug, info, warn,
                     error or fatal (default: info)
  --format <name>    Output format: ndjson or pretty (default: ndjson)
  --no-redact        Disable automatic redaction (not recommended)
  --ip               Also redact IPv4 addresses
  --name <name>      Attach a logger name to the record
  -h, --help         Show this help
  -v, --version      Show the version
```

With no message, standard input is read and logged as the `input` field. The CLI
exits 0 on success and 2 on a usage error.

## Running tests

```sh
node --test
```

No install step and no test framework to download; the suite uses the built-in
`node:test` runner. Unit tests pass a fake writable stream and never write to the
real standard output, except in `test/cli.test.js`, which spawns the real binary
with `child_process.spawnSync` and asserts on exit codes and captured stdout.

```
ℹ tests 151
ℹ suites 0
ℹ pass 151
ℹ fail 0
```

CI runs the same command on Node.js 20, 22 and 24.

Two extra harnesses check the properties that a unit test can only sample:

```sh
bash scripts/verify-proto-regression.sh   # each fix reverted in turn; the suite must fail
bash scripts/verify-oracle.sh             # cross-seed differential run against JSON.parse
```

`verify-proto-regression.sh` restores `src/` from a backup before every scenario
and reverts exactly one fix, so a passing suite means the tests genuinely detect
the old behaviour rather than merely agreeing with the new code.

## License

MIT. See [LICENSE](LICENSE).
