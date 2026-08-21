const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readJson(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.notEqual(text.trim(), '', `${rel} must not be empty`);
  return JSON.parse(text);
}

test('current-season backfill manifest references only valid JSON fragments', () => {
  const seasons = readJson('seasons.json');
  const current = seasons.seasons.find(s => s.id === seasons.current);
  assert.ok(current, 'current season must resolve');

  const manifestRel = `data/${seasons.current}/backfill/index.json`;
  const manifest = readJson(manifestRel);
  assert.ok(Array.isArray(manifest.fragments));

  for (const fragment of manifest.fragments) {
    const rel = `data/${seasons.current}/backfill/${fragment}`;
    const parsed = readJson(rel);
    assert.equal(typeof parsed, 'object', `${rel} must contain a JSON object`);
    assert.equal(parsed.season, seasons.current, `${rel} season mismatch`);
  }
});
