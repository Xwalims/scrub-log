'use strict';

/**
 * Test helpers.
 *
 * Unit tests never write to the real `process.stdout`: they pass a fake
 * writable stream that records the chunks it is given. This keeps test output
 * clean and lets each test assert on exactly what the logger produced.
 */

/**
 * Create a fake writable stream that collects everything written to it.
 *
 * @param {object} [options] Fake stream options.
 * @param {boolean} [options.isTTY=false] Value reported as `isTTY`.
 * @param {Error|null} [options.failWith=null] When set, `write` throws this error.
 * @returns {{
 *   chunks: string[],
 *   output: () => string,
 *   lines: () => string[],
 *   records: () => object[],
 *   write: (chunk: string) => boolean,
 *   isTTY: boolean
 * }} The fake stream.
 */
function createFakeStream(options = {}) {
  const { isTTY = false, failWith = null } = options;
  const chunks = [];

  return {
    chunks,
    isTTY,
    write(chunk) {
      if (failWith) {
        throw failWith;
      }
      chunks.push(String(chunk));
      return true;
    },
    /** @returns {string} Everything written so far. */
    output() {
      return chunks.join('');
    },
    /** @returns {string[]} One entry per written line, without line endings. */
    lines() {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0);
    },
    /** @returns {object[]} Each written line parsed as JSON. */
    records() {
      return this.lines().map((line) => JSON.parse(line));
    },
  };
}

module.exports = { createFakeStream };