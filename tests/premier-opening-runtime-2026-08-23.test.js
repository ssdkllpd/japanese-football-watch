const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function loadMergeBackfillData() {
  const code = fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8');
  const context = {
    window: {},
    console,
    structuredClone: global.structuredClone,
    URLSearchParams,
    location: { search: '' },
    document: { addEventListener() {} },
    fetch: async () => { throw new Error('fetch must not be called in merge unit test'); }
  };
  vm.createContext(context);
  vm.runInContext(`${code}\nthis.__merge = mergeBackfillData;`, context);
  return context.__merge;
}

test('runtime merge exposes verified Premier League opening-round records without inventing ratings', () => {
  const merge = loadMergeBackfillData();
  const base = readJson('data.json');
  const manifest = readJson('data/2026-27/backfill/index.json');
  const fragments = manifest.fragments.map(name => readJson(`data/2026-27/backfill/${name}`));
  const merged = fragments.reduce((data, fragment) => merge(data, fragment), base);

  const expectedMatches = new Map([
    ['premier-2026-08-22-everton-palace', 'エヴァートン 2-0 クリスタル・パレス'],
    ['premier-2026-08-22-ipswich-sunderland', 'イプスウィッチ・タウン 2-1 サンダーランド'],
    ['premier-2026-08-22-forest-leeds', 'ノッティンガム・フォレスト 0-1 リーズ・ユナイテッド']
  ]);

  for (const [matchId, label] of expectedMatches) {
    const match = merged.matches.find(item => item.matchId === matchId);
    assert.ok(match, `${matchId} must load through the runtime merge`);
    assert.equal(match.match, label);
  }

  const records = merged.playerMatchStats.filter(record => [
    'premier-2026-08-22-everton-palace',
    'premier-2026-08-22-ipswich-sunderland',
    'premier-2026-08-22-forest-leeds'
  ].includes(record.matchId));

  assert.ok(records.some(record => record.player === '鎌田大地' && record.start === true));
  assert.ok(records.some(record => record.player === '冨安健洋' && record.substitution?.on === 72));
  assert.ok(records.some(record => record.player === '前田大然' && record.values?.minutes === 80));
  assert.ok(records.some(record => record.player === '田中碧' && record.values?.minutes === 0));
  for (const record of records) assert.equal(record.jfwRating, null);
});
