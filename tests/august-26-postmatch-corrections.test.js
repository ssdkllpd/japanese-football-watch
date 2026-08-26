'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const mergeCore = require(path.join(ROOT, 'backfill-merge.js'));
const ratingSource = fs.readFileSync(path.join(ROOT, 'jfw-rating.js'), 'utf8');

function ratingApi() {
  const window = { addEventListener() {} };
  const context = { window, document: {}, console, setTimeout() {} };
  vm.createContext(context);
  vm.runInContext(ratingSource, context);
  return window.JFWRating;
}

function loadRuntime() {
  const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2026-27/backfill/index.json'), 'utf8'));
  let out = D;
  for (const name of manifest.fragments) {
    const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2026-27/backfill', name), 'utf8'));
    out = mergeCore.mergeBackfillData(out, fragment, { season: '2026-27' });
  }
  return { D: out, manifest };
}

test('Aug 26 correction overlay is last and fixes Morita and Hatate', () => {
  const { D, manifest } = loadRuntime();
  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-26-4.json');

  const morita = D.playerMatchStats.find(r => r.recordId === 'r-morita-stoke-hull-20260825');
  assert.ok(morita);
  assert.equal(morita.start, false);
  assert.equal(morita.bench, true);
  assert.equal(morita.appearance, 'sub_59');
  assert.equal(morita.ratingInputs.minutes.value, 31);
  assert.equal(morita.jfwRating, 6.07);
  assert.equal(morita.ratingCoverage, 0.563);
  assert.equal(morita.ratingConfidence, 'medium');

  const hatate = D.playerMatchStats.find(r => r.recordId === 'r-hatate-lask-celtic-20260825');
  assert.ok(hatate);
  assert.equal(hatate.ratingInputs.penaltiesConceded.value, 1);
  assert.equal(hatate.jfwRating, 5.5);
  assert.equal(hatate.ratingCoverage, 0.447);
  assert.equal(hatate.ratingConfidence, 'medium');
  assert.ok(hatate.ratingConflicts.some(c => c.field === 'penaltiesConceded' && c.selected === 1 && c.discarded === 0));

  const api = ratingApi();
  assert.equal(api.compute(morita.ratingInputs, morita.ratingPosition).jfwRating, 6.07);
  assert.equal(api.compute(hatate.ratingInputs, hatate.ratingPosition).jfwRating, 5.5);
});

// Final correction test intentionally exercises the fully merged runtime, not the historical overlay alone.
