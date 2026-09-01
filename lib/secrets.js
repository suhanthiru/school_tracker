'use strict';

const db = require('./db');

// Secrets live in the settings table, DPAPI-encrypted through Electron's
// safeStorage. Under plain `node server.js` there is no safeStorage, so values
// fall back to an obvious plaintext prefix — fine for local development, and
// the prefix makes the difference impossible to miss when inspecting the DB.

const SECRET_KEYS = ['canvas_token', 'ed_token', 'gmail_app_password', 'gcal_ics_url'];

function safeStorage() {
  try {
    const electron = require('electron');
    if (electron.safeStorage && electron.safeStorage.isEncryptionAvailable()) {
      return electron.safeStorage;
    }
  } catch { /* plain node */ }
  return null;
}

function setSecret(key, plaintext) {
  const value = String(plaintext || '').trim();
  if (!value) {
    db.setSetting(`secret_${key}`, '');
    return;
  }
  const ss = safeStorage();
  if (ss) {
    db.setSetting(`secret_${key}`, 'enc1:' + ss.encryptString(value).toString('base64'));
  } else {
    console.warn(`[secrets] storing ${key} UNENCRYPTED (no safeStorage — plain node run)`);
    db.setSetting(`secret_${key}`, 'plain1:' + Buffer.from(value, 'utf8').toString('base64'));
  }
}

function getSecret(key) {
  const stored = db.getSetting(`secret_${key}`, '');
  if (!stored) return null;
  if (stored.startsWith('plain1:')) {
    return Buffer.from(stored.slice(7), 'base64').toString('utf8');
  }
  if (stored.startsWith('enc1:')) {
    const ss = safeStorage();
    if (!ss) {
      console.warn(`[secrets] ${key} is encrypted; it can only be read inside the desktop app`);
      return null;
    }
    try {
      return ss.decryptString(Buffer.from(stored.slice(5), 'base64'));
    } catch (err) {
      console.warn(`[secrets] could not decrypt ${key}: ${err.message}`);
      return null;
    }
  }
  return null;
}

const hasSecret = (key) => !!db.getSetting(`secret_${key}`, '');

module.exports = { SECRET_KEYS, setSecret, getSecret, hasSecret };
