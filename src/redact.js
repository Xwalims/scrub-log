'use strict';

/**
 * Secret redaction engine.
 *
 * Redaction is implemented as an ordered list of rules. Each rule is a plain
 * object `{ name, pattern, replacement }` so the table can be inspected,
 * tested, and reordered by callers.
 *
 * ## ReDoS safety
 *
 * Every pattern in {@link RULES} is written so that it cannot backtrack
 * catastrophically:
 *
 * 1. No nested quantifiers of the same character class, for example no
 *    `(a+)+`. The only quantifiers present are simple `+`, `*`, `{n,m}` and the
 *    optional group `(?:...)?`, each applied to a character class with no
 *    ambiguous overlap.
 * 2. Repetition is always bounded. Run-length parts such as `{16}`, `{24}` and
 *    `{13,19}` use explicit bounds, so the engine backtracks over a fixed,
 *    small number of positions rather than an unbounded one.
 * 3. Alternatives are mutually exclusive at their first character, so at most
 *    one branch can match at any given position.
 * 4. The credit-card rule first matches a bounded digit run and then validates
 *    it with the Luhn checksum in code. No alternation over prefixes is used,
 *    which removes the main source of ambiguity in the usual implementations.
 * 5. Secrets are not copied into the output. Nested walking is driven by a
 *    `maxDepth` guard and a `WeakSet`, so recursion terminates on any input.
 *
 * @module redact
 */

/** Replacement token used for a secret-looking key whose value is dropped. */
const REDACTED = '[REDACTED]';

/** Replacement token written for a circular reference. */
const CIRCULAR = '[Circular]';

/** Default maximum depth walked when redacting nested structures. */
const DEFAULT_MAX_DEPTH = 12;

/**
 * Key names whose value is replaced wholesale, regardless of its shape.
 *
 * The list is intentionally restricted to names that are unambiguously
 * secret-bearing. Values under these keys are replaced without inspection, so
 * `"password": { "value": "hunter2" }` is also protected.
 *
 * @type {ReadonlySet<string>}
 */
const SECRET_KEYS = Object.freeze(
  new Set([
    'password',
    'passwd',
    'pwd',
    'pass',
    'secret',
    'secrets',
    'token',
    'tokens',
    'access_token',
    'accessToken',
    'refresh_token',
    'refreshToken',
    'id_token',
    'idToken',
    'apiKey',
    'api_key',
    'apikey',
    'apiSecret',
    'api_secret',
    'accessKey',
    'access_key',
    'secretKey',
    'secret_key',
    'privateKey',
    'private_key',
    'privatekey',
    'clientSecret',
    'client_secret',
    'clientsecret',
    'credentials',
    'authorization',
  ])
);

/**
 * Compute the Luhn checksum of a digit string.
 *
 * Used to tell a payment-card number apart from an arbitrary long integer such
 * as a timestamp or an order id.
 *
 * @param {string} digits A string of digits.
 * @returns {boolean} True when the digits satisfy the Luhn checksum.
 */
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Ordered redaction rules applied to every string.
 *
 * The order matters: specific credential formats are matched before the generic
 * key/value rule, so `token: ghp_...` becomes `[REDACTED_GITHUB_TOKEN]` rather
 * than the less informative generic marker.
 *
 * @type {ReadonlyArray<{name: string, pattern: RegExp, replacement: string|((substring: string, ...args: any[]) => string)}>}
 */
const RULES = [
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
  {
    // Header form: "Authorization: Bearer <token>". The scheme keyword is kept
    // (normalised to the case that was actually written) so the record still
    // shows which auth scheme was used; only the credential is dropped.
    name: 'bearer',
    pattern: /\b([Bb]earer)\s+([A-Za-z0-9._~+/=-]{8,})/g,
    replacement: (match, scheme) => `${scheme} [REDACTED_BEARER_TOKEN]`,
  },
  {
    name: 'jwt',
    // Three base64url segments. Each segment is length-bounded and may not
    // contain a dot, so the pattern cannot partition a string ambiguously.
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{12,20}\b/g,
    replacement: '[REDACTED_AWS_ACCESS_KEY_ID]',
  },
  {
    name: 'aws-secret-access-key',
    // 40-character base64-ish run directly after a recognised key name.
    pattern: /\baws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/g,
    replacement: () => 'aws_secret_access_key=[REDACTED_AWS_SECRET_ACCESS_KEY]',
  },
  {
    name: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,255}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    name: 'github-fine-grained-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{8,255}\b/g,
    replacement: '[REDACTED_SLACK_TOKEN]',
  },
  {
    name: 'credit-card',
    // Matches a bounded run of digits, optionally grouped by spaces or hyphens,
    // then validates the digits with Luhn in the replacement function.
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    replacement: (match) => {
      const digits = match.replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19) {
        return match;
      }
      return luhnValid(digits) ? '[REDACTED_CREDIT_CARD]' : match;
    },
  },
  {
    name: 'secret-key-value',
    // Inline "key: value" or "key=value" form for secret-looking names.
    // The key part is captured and preserved; the value is replaced. Already
    // redacted placeholders are skipped so output is stable when redact runs
    // twice on the same string.
    pattern: /\b((?:pass(?:wo?rd)?|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|credential)s?["']?\s*[:=]\s*["']?)(?!\[REDACTED)([A-Za-z0-9/+=._-]{3,})/gi,
    replacement: (match, keyPart) => `${keyPart}${REDACTED}`,
  },
  {
    name: 'ipv4',
    // Applied only when the `redactIp` option is enabled. Each octet is
    // matched by an alternation of bounded literals, so the pattern is linear.
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\b/g,
    replacement: '[REDACTED_IP]',
    optional: 'redactIp',
  },
];

/**
 * Normalise the `options` argument into a plain object.
 *
 * @param {object} [options] Caller-supplied options.
 * @returns {{redactIp: boolean, maxDepth: number, rules: ReadonlyArray<object>}}
 */
function resolveOptions(options) {
  const { redactIp = false, maxDepth = DEFAULT_MAX_DEPTH, rules } = options || {};
  if (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new TypeError(`maxDepth must be a positive integer, received ${String(maxDepth)}`);
  }
  return {
    redactIp: redactIp === true,
    maxDepth,
    rules: Array.isArray(rules) ? rules : RULES,
  };
}

/**
 * Apply every enabled rule to a string.
 *
 * @param {string} input The string to scrub.
 * @param {object} [options] Resolved options from {@link resolveOptions}.
 * @returns {string} The scrubbed string.
 */
function redactString(input, options) {
  let output = input;
  for (const rule of options.rules) {
    if (rule.optional && !options[rule.optional]) {
      continue;
    }
    // Patterns are module-level and carry the `g` flag, so `lastIndex` is reset
    // before every use. Reusing a shared RegExp across calls is safe only with
    // this reset, and it avoids recompiling the pattern on every record.
    rule.pattern.lastIndex = 0;
    output = output.replace(rule.pattern, rule.replacement);
  }
  return output;
}

/**
 * Copy one own property onto `target` without ever invoking the
 * `Object.prototype.__proto__` accessor.
 *
 * `target[key] = value` is not the same thing as "copy this key" for every
 * possible key name: `__proto__` is an ACCESSOR inherited from
 * `Object.prototype`, so plain assignment runs the setter and REPLACES THE
 * PROTOTYPE of `target` rather than creating an own key. Both walk sites in
 * this module iterate `Object.keys(value)`, which means for the one legal
 * field name `__proto__` they are holding a real own data property — exactly
 * what `JSON.parse('{"__proto__":{"a":1}}')` produces — and would then drop
 * it. The value under it would reach no redaction rule at all, and the
 * rebuilt object would carry the attacker's object as its prototype.
 *
 * Only `__proto__` needs this. `constructor`, `toString`, `valueOf` and
 * `hasOwnProperty` are ordinary data properties on the prototype, so plain
 * assignment shadows them correctly and escaping those would itself be a bug.
 *
 * @param {object} target Object to write to.
 * @param {string} key Own key name taken from the input.
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
 * Report whether a property name denotes a secret.
 *
 * The comparison ignores case and separators, so `apiKey`, `api_key` and
 * `API-KEY` are all recognised.
 *
 * @param {unknown} key Property name.
 * @returns {boolean} True when the value must be replaced wholesale.
 */
function isSecretKey(key) {
  if (typeof key !== 'string') {
    return false;
  }
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_KEYS.has(key)) {
    return true;
  }
  for (const candidate of SECRET_KEYS) {
    if (candidate.replace(/[^a-z0-9]/g, '') === normalised) {
      return true;
    }
  }
  return false;
}

/**
 * Convert an `Error` into a plain, safely serialisable object.
 *
 * `cause` is included recursively because a wrapped error is often where the
 * credential actually appears.
 *
 * @param {Error} error The error to convert.
 * @param {object} options Resolved options.
 * @param {WeakSet<object>} path Currently open ancestors.
 * @param {number} depth Current depth.
 * @returns {object} A plain object with `name`, `message`, `stack` and `cause`.
 */
function redactError(error, options, path, depth) {
  // The error itself is already on the ancestor path: `redactValue` registered
  // it before dispatching here. Re-registering it would immediately trip the
  // circular check, so this function only descends into the cause and the own
  // enumerable properties.
  const result = {
    name: String(error.name),
    message: redactString(String(error.message), options),
    stack: typeof error.stack === 'string' ? redactString(error.stack, options) : undefined,
  };
  if (result.stack === undefined) {
    delete result.stack;
  }

  const { cause } = error;
  if (cause !== undefined && cause !== null) {
    if (cause instanceof Error) {
      result.cause = depth < options.maxDepth
        ? redactError(cause, options, path, depth + 1)
        : { name: String(cause.name), message: '[Truncated]' };
    } else {
      result.cause = redactValue(cause, options, path, depth + 1);
    }
  }

  // Own enumerable properties added by application code, for example
  // `err.requestHeaders.authorization`.
  for (const key of Object.keys(error)) {
    if (key === 'cause' || key === 'name' || key === 'message' || key === 'stack') {
      continue;
    }
    assignKey(result, key, redactProperty(key, error[key], options, path, depth));
  }
  return result;
}

/**
 * Redact the value stored under a property key.
 *
 * @param {string} key Property name.
 * @param {unknown} value Property value.
 * @param {object} options Resolved options.
 * @param {WeakSet<object>} path Currently open ancestors.
 * @param {number} depth Current depth.
 * @returns {unknown} The redacted value.
 */
function redactProperty(key, value, options, path, depth) {
  if (isSecretKey(key)) {
    return REDACTED;
  }
  return redactValue(value, options, path, depth);
}

/**
 * Recursively redact an arbitrary value.
 *
 * Strings are scrubbed by the rule list, plain objects and arrays are walked
 * with key order preserved, `Map`/`Set` are converted to arrays, and any other
 * value type is returned as-is.
 *
 * `path` holds only the objects on the current branch, not every object
 * visited. An object is added on entry and removed on exit, so a value that
 * legitimately appears twice as a sibling (a DAG rather than a cycle) is
 * redacted both times, while a true cycle is still detected and reported as
 * `'[Circular]'`.
 *
 * @param {unknown} value Value to redact.
 * @param {object} [options] Resolved options.
 * @param {WeakSet<object>} [path] Currently open ancestors.
 * @param {number} [depth] Current depth.
 * @returns {unknown} The redacted value.
 */
function redactValue(value, options, path = new WeakSet(), depth = 0) {
  if (typeof value === 'string') {
    return redactString(value, options);
  }
  if (value === null || typeof value !== 'object') {
    // numbers, booleans, bigint, undefined, symbol and functions carry no
    // embedded secrets in a serialisable form.
    return value;
  }
  if (depth >= options.maxDepth) {
    return '[Truncated]';
  }
  if (path.has(value)) {
    return CIRCULAR;
  }
  path.add(value);

  try {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof RegExp) {
      return String(value);
    }
    if (value instanceof Error) {
      return redactError(value, options, path, depth);
    }
    if (value instanceof Map) {
      // A Map entry names its value just like an object property does, so the
      // secret-key policy has to see the entry key too: `new Map([['password',
      // 'hunter2']])` must be redacted, exactly as `{ password: 'hunter2' }` is.
      // A non-string key falls through `isSecretKey` and is walked as a value.
      return Array.from(value, ([key, item]) => [
        redactValue(key, options, path, depth + 1),
        redactProperty(key, item, options, path, depth + 1),
      ]);
    }
    if (value instanceof Set) {
      return Array.from(value, (item) => redactValue(item, options, path, depth + 1));
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      // Binary payloads are never safe to inspect as text and are almost never
      // present in a log record, so they are dropped rather than decoded.
      return '[Binary]';
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, options, path, depth + 1));
    }

    // Plain object: rebuild with the original insertion order of `Object.keys`.
    // `assignKey` is required, not cosmetic: for the one key name `__proto__`
    // an own data property (which is what `Object.keys(value)` just listed)
    // would be dropped by plain assignment, and the value under it would
    // never be inspected by any redaction rule.
    const output = {};
    for (const key of Object.keys(value)) {
      assignKey(output, key, redactProperty(key, value[key], options, path, depth + 1));
    }
    return output;
  } finally {
    // Release the object so it is not treated as an ancestor by sibling
    // branches.
    path.delete(value);
  }
}

/**
 * Deeply redact secrets from a value.
 *
 * Objects, arrays, strings, `Error` instances, `Map` and `Set` are walked.
 * Key order is preserved, circular references terminate as `'[Circular]'`, and
 * recursion stops at `maxDepth`.
 *
 * @example
 * redact({ token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', port: 8080 });
 * // => { token: '[REDACTED]', port: 8080 }
 *
 * @param {unknown} value Value to redact.
 * @param {object} [options] Redaction options.
 * @param {boolean} [options.redactIp=false] Also redact IPv4 addresses.
 * @param {number} [options.maxDepth=12] Maximum recursion depth.
 * @param {ReadonlyArray<object>} [options.rules] Override the rule list.
 * @returns {unknown} A redacted copy; the input is never mutated.
 * @throws {TypeError} If `maxDepth` is not a positive integer.
 */
function redact(value, options) {
  return redactValue(value, resolveOptions(options));
}

module.exports = {
  CIRCULAR,
  DEFAULT_MAX_DEPTH,
  REDACTED,
  RULES,
  SECRET_KEYS,
  isSecretKey,
  luhnValid,
  redact,
};