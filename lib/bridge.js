'use strict';

// lib/ code and main.js run in the same process; this emitter is how library
// code asks the Electron shell for things (toasts, the Gradescope SSO window)
// without importing electron everywhere.
const { EventEmitter } = require('node:events');

module.exports = new EventEmitter();
