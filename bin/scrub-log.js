#!/usr/bin/env node
'use strict';

/**
 * `scrub-log` command line entry point.
 *
 * Keeps the executable wrapper thin: all behaviour lives in `src/cli.js` so it
 * can be unit tested without spawning a process.
 */

require('../src/cli.js').main();