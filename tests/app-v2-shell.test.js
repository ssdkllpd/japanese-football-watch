'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app-v2.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app-v2.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app-v2.js'), 'utf8');

test('v2 app javascript is syntactically valid', () => {
  assert.doesNotThrow(() => new Function(js));
});

test('v2 shell exposes the approved five primary destinations', () => {
  for (const page of ['matches', 'leagues', 'following', 'japanese', 'more']) {
    assert.match(html, new RegExp(`data-page="${page}"`));
  }
  assert.match(html, /<title>Football Companion<\/title>/);
  assert.doesNotMatch(html, /<h1[^>]*>海外日本人ウォッチ<\/h1>/);
});

test('v2 match home is wired to Core date, live and fixture endpoints', () => {
  assert.match(js, /\/api\/v2\/dates\//);
  assert.match(js, /\/api\/v2\/live/);
  assert.match(js, /\/api\/v2\/fixtures\//);
  assert.match(js, /Core feed/);
});

test('v2 shell keeps mobile bottom navigation and a desktop equivalent', () => {
  assert.match(css, /\.bottom-nav\{/);
  assert.match(css, /\.desktop-rail\{/);
  assert.match(css, /@media\(min-width:840px\)/);
});

test('Japanese tracking is an optional page while generic match data remains the default page', () => {
  assert.match(js, /page: 'matches'/);
  assert.match(js, /日本人追跡は総合データアプリのオプション機能/);
});
