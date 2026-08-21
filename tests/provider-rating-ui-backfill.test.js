const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'jfw-rating.js'), 'utf8');

test('provider rating UI is reinstalled after the deferred backfill loader finishes', () => {
  assert.match(source, /script\.onload\s*=\s*\(\)\s*=>/);
  assert.match(source, /installProviderRatingUi/);
  const onloadIndex = source.indexOf('script.onload');
  const appendIndex = source.indexOf('document.body.appendChild(script)', onloadIndex);
  assert.ok(onloadIndex >= 0, 'backfill script should register an onload hook');
  assert.ok(appendIndex > onloadIndex, 'onload hook must be attached before the backfill script is appended');
});
