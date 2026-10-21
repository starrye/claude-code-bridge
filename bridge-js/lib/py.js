'use strict';

// Python semantics the Bridge relies on, so the Node port produces the same output as the Python one.
// JS strings count UTF-16 units, Python counts code points; Python's whitespace, \w and str() differ too.

const fs = require('node:fs');
const path = require('node:path');

// str.isspace(): what Python's strip() and \s remove/match for str patterns.
const WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS_CLASS = `[${WS}]`;
const NOT_WS_CLASS = `[^${WS}]`;
// \w for str patterns: letters, numbers and underscore (needs the u flag)
const WORD = '[\\p{L}\\p{N}_]';
// \b with Python's Unicode notion of a word character (needs the u flag)
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

const LEADING_WS = new RegExp(`^${WS_CLASS}+`, 'u');
const TRAILING_WS = new RegExp(`${WS_CLASS}+$`, 'u');

function strip(text) {
  return text.replace(LEADING_WS, '').replace(TRAILING_WS, '');
}

// len(text): code points
function len(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

// text[:count] by code points
function head(text, count) {
  if (count <= 0) return '';
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (n === count) return text.slice(0, i);
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return text;
}

// str.splitlines() without keepends
const LINE_BREAK = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;
function splitlines(text) {
  if (text === '') return [];
  const parts = text.split(LINE_BREAK);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// bool(value)
function truthy(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

const isDict = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function reprString(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + quote;
}

function reprNumber(value) {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value);
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  return String(value);
}

// repr(value) for the JSON-shaped values tool inputs can hold
function repr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return reprNumber(value);
  if (typeof value === 'string') return reprString(value);
  if (Array.isArray(value)) return '[' + value.map(repr).join(', ') + ']';
  return '{' + Object.entries(value).map(([k, v]) => reprString(k) + ': ' + repr(v)).join(', ') + '}';
}

// str(value)
function str(value) {
  return typeof value === 'string' ? value : repr(value);
}

// sorted() for strings: code point order (JS default sort is UTF-16 order)
function compareCodePoints(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

// os.path.realpath: like fs.realpathSync, but a path that does not exist (fully or partly) is not an error
function realpath(target) {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(realpath(parent), path.basename(absolute));
  }
}

// int(value) for strings and JSON numbers; throws like Python's ValueError on anything else
function int(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const text = strip(value);
    if (/^[+-]?\d+(?:_\d+)*$/.test(text) && /^[+-]?[0-9_]+$/.test(text)) return parseInt(text.replace(/_/g, ''), 10);
  }
  throw new Error(`invalid literal for int(): ${repr(value)}`);
}

module.exports = { int, WS_CLASS, NOT_WS_CLASS, WORD, BOUNDARY, strip, len, head, splitlines, truthy, isDict, repr, str, compareCodePoints, realpath };
