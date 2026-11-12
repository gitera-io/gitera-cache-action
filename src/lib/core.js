'use strict';

// Minimal stand-ins for @actions/core, so the action ships with no dependencies.

const fs = require('node:fs');
const os = require('node:os');

function getInput(name) {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return typeof value === 'string' ? value.trim() : '';
}

function getMultilineInput(name) {
  return getInput(name)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getBooleanInput(name) {
  const value = getInput(name).toLowerCase();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`Input ${name} must be true or false, got "${getInput(name)}"`);
}

/** Appends `name<<delimiter ... delimiter` to a runner command file. */
function appendCommandFile(envName, name, value) {
  const file = process.env[envName];
  if (!file) return false;
  const delimiter = `gitera_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
  return true;
}

function setOutput(name, value) {
  appendCommandFile('GITHUB_OUTPUT', name, String(value));
}

function saveState(name, value) {
  appendCommandFile('GITHUB_STATE', name, String(value));
}

function getState(name) {
  return process.env[`STATE_${name}`] || '';
}

function exportVariable(name, value) {
  process.env[name] = value;
  appendCommandFile('GITHUB_ENV', name, value);
}

function setSecret(value) {
  if (value) process.stdout.write(`::add-mask::${value}${os.EOL}`);
}

const info = (message) => process.stdout.write(`${message}${os.EOL}`);
const warning = (message) => process.stdout.write(`::warning::${message}${os.EOL}`);
const notice = (message) => process.stdout.write(`::notice::${message}${os.EOL}`);

function setFailed(message) {
  process.stdout.write(`::error::${message}${os.EOL}`);
  process.exitCode = 1;
}

module.exports = {
  getInput,
  getMultilineInput,
  getBooleanInput,
  setOutput,
  saveState,
  getState,
  exportVariable,
  setSecret,
  info,
  warning,
  notice,
  setFailed,
};
