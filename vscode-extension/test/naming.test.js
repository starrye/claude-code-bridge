'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computerLabel, folderName, MAX_NAME } = require('../lib/naming');

test('the setting wins over the host name, and the folder follows after @', () => {
  assert.equal(computerLabel('work-box', 'a1b2c3d4e5f6', '/workspaces/agent-bridge'), 'work-box@agent-bridge');
  assert.equal(computerLabel('', 'a1b2c3d4e5f6', '/workspaces/agent-bridge'), 'a1b2c3d4e5f6@agent-bridge');
  assert.equal(computerLabel('   ', 'host', '/p/blog'), 'host@blog');
});

test('no folder open, or a root, gives the bare name', () => {
  assert.equal(computerLabel('box', 'host', ''), 'box');
  assert.equal(computerLabel('', 'host', undefined), 'host');
  assert.equal(computerLabel('', 'host', '/'), 'host');
  assert.equal(computerLabel('', 'host', 'C:\\'), 'host');
});

test('the folder is the last path segment, with either kind of separator and trailing slashes', () => {
  assert.equal(folderName('/a/b/c/'), 'c');
  assert.equal(folderName('C:\\Users\\me\\proj'), 'proj');
  assert.equal(folderName('/home/me/项目 一'), '项目 一');
});

test('control characters and blanks never reach the relay, and an empty name gets a fallback', () => {
  assert.equal(computerLabel('a\nb\u001b[31m', 'h', '/x/y'), 'ab[31m@y');
  assert.equal(computerLabel('', '', ''), '未命名电脑');
  assert.equal(computerLabel('', '\n', '/x/y'), '未命名电脑@y');
});

test('the name is capped at 40 characters so the folder keeps room, and the whole thing fits what the relay keeps', () => {
  const folder = 'f'.repeat(19);
  const label = computerLabel('n'.repeat(80), 'h', `/w/${folder}`);
  assert.equal(Array.from(label).length, MAX_NAME);
  assert.ok(label.endsWith(`@${folder}`), 'a folder of up to 19 characters is intact however long the name is');
  assert.ok(label.startsWith('n'.repeat(39) + '…@'), label);
  assert.equal(computerLabel('box', 'h', `/w/${'f'.repeat(50)}`), `box@${'f'.repeat(50)}`, 'a short name leaves the folder plenty of room');
  const longFolder = computerLabel('box', 'h', `/w/${'d'.repeat(100)}`);
  assert.equal(Array.from(longFolder).length, MAX_NAME);
  assert.ok(longFolder.startsWith('box@') && longFolder.endsWith('…'));
  assert.equal(Array.from(computerLabel('n'.repeat(100), 'h', '')).length, MAX_NAME);
});

test('length is counted in characters, so astral characters are not split', () => {
  const label = computerLabel('😀'.repeat(70), 'h', '');
  assert.equal(Array.from(label).length, MAX_NAME);
  assert.ok(!/[\ud800-\udbff]$/.test(label) && !/^[\udc00-\udfff]/.test(label));
});
