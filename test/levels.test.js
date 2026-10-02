'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEVELS,
  LEVEL_NAMES,
  LEVEL_VALUES,
  fromName,
  isLevel,
  shouldLog,
  toLevel,
} = require('../src/levels.js');

test('level numbers follow the syslog-style scale', () => {
  assert.deepEqual(LEVELS, {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
  });
});

test('level names and values are exposed in ascending order', () => {
  assert.deepEqual(LEVEL_NAMES, ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  assert.deepEqual(LEVEL_VALUES, [10, 20, 30, 40, 50, 60]);
});

test('the exported level table is frozen', () => {
  assert.equal(Object.isFrozen(LEVELS), true);
  assert.equal(Object.isFrozen(LEVEL_NAMES), true);
  assert.throws(() => {
    LEVELS.info = 99;
  }, TypeError);
});

test('fromName resolves every level name', () => {
  assert.equal(fromName('trace'), 10);
  assert.equal(fromName('debug'), 20);
  assert.equal(fromName('info'), 30);
  assert.equal(fromName('warn'), 40);
  assert.equal(fromName('error'), 50);
  assert.equal(fromName('fatal'), 60);
});

test('fromName is case-insensitive and trims whitespace', () => {
  assert.equal(fromName('WARN'), 40);
  assert.equal(fromName('  Info  '), 30);
});

test('fromName rejects unknown names', () => {
  assert.throws(() => fromName('verbose'), RangeError);
  assert.throws(() => fromName('constructor'), RangeError);
  assert.throws(() => fromName('__proto__'), RangeError);
  assert.throws(() => fromName('toString'), RangeError);
});

test('fromName rejects non-string input', () => {
  assert.throws(() => fromName(30), TypeError);
  assert.throws(() => fromName(null), TypeError);
  assert.throws(() => fromName(undefined), TypeError);
});

test('isLevel recognises valid names without throwing', () => {
  assert.equal(isLevel('error'), true);
  assert.equal(isLevel(' ERROR '), true);
  assert.equal(isLevel('verbose'), false);
  assert.equal(isLevel('toString'), false);
  assert.equal(isLevel(''), false);
  assert.equal(isLevel(30), false);
  assert.equal(isLevel(null), false);
  assert.equal(isLevel(undefined), false);
});

test('toLevel accepts names and known numbers only', () => {
  assert.equal(toLevel('fatal'), 60);
  assert.equal(toLevel(40), 40);
  assert.throws(() => toLevel(35), RangeError);
  assert.throws(() => toLevel(Number.NaN), RangeError);
  assert.throws(() => toLevel(Infinity), RangeError);
});

test('shouldLog emits records at or above the threshold', () => {
  assert.equal(shouldLog(50, 40), true);
  assert.equal(shouldLog(40, 40), true);
  assert.equal(shouldLog(30, 40), false);
});

test('shouldLog accepts level names as well as numbers', () => {
  assert.equal(shouldLog('fatal', 'error'), true);
  assert.equal(shouldLog('debug', 'info'), false);
  assert.equal(shouldLog(30, 'trace'), true);
});

test('shouldLog throws on unknown levels instead of guessing', () => {
  assert.throws(() => shouldLog('verbose', 'info'), RangeError);
  assert.throws(() => shouldLog(30, 42), RangeError);
});