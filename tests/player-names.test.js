'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const names = require('../player-names');
const registry = require('../player-name-data');
const { build } = require('../scripts/v2/build-player-name-data');
const evidence = require('../config/d1-major-league-snapshot-20260908.json');

test('provider pitch labels and expanded list names retain compound names and middle names', () => {
  for (const [id, short, full] of [
    [278088, 'C. Rushworth', 'Carl Andrew Rushworth'],
    [37961, 'M. van Ewijk', 'Milan Fabrizio van Ewijk'],
    [313245, 'M. Lewis-Skelly', 'Myles Anthony Lewis-Skelly'],
    [290, 'V. van Dijk', 'Virgil van Dijk'],
  ]) {
    const player = Object.freeze({ id:`af:player:${id}`, name:short });
    assert.equal(names.pitchName(player,registry),short);
    assert.equal(names.fullName(player,registry),full);
    assert.equal(player.name,short,'formatting must not modify stored identity or name');
  }
});
test('existing full names, local names and mononyms are preserved outside the pitch', () => {
  assert.equal(names.fullName({playerId:'af:player:978',name:'Kai Havertz'},registry),'Kai Havertz');
  assert.equal(names.pitchName({playerId:'af:player:978',name:'Kai Havertz'},registry),'K. Havertz');
  assert.equal(names.fullName({jfwPlayerId:'af:player:32966',name:'田中碧'},registry),'田中碧');
  assert.equal(names.fullName({id:'af:player:1496',name:'Raphinha'},registry),'Raphinha');
});
test('missing source parts, unknown IDs and failed data loading never fabricate a name', () => {
  const player={id:'af:player:551200',name:'M. Saka'};
  assert.equal(names.fullName(player,registry),'M. Saka');
  assert.equal(names.fullName({id:'af:player:999999999',name:'C. Rushworth'},registry),'C. Rushworth');
  assert.equal(names.pitchName({name:'Declan Rice'},registry),'Declan Rice','a name alone cannot select another player');
  assert.equal(names.pitchName({id:'af:player:2937',name:'Declan Rice'},null),'Declan Rice');
  assert.equal(names.fullName(player,null),'M. Saka');
});
test('name data generation rejects a different source and conflicting canonical identity', () => {
  const source={snapshotId:evidence.snapshotId,archiveSha256:evidence.archiveSha256,players:[{playerId:7,name:'A. Example',firstname:'Alex',lastname:'Example'}]};
  assert.deepEqual(build(source).players['af:player:7'],['A. Example','Alex Example']);
  assert.throws(()=>build({...source,archiveSha256:'stale'}),/pinned verified snapshot/);
  assert.throws(()=>build({...source,players:[...source.players,{playerId:7,name:'B. Other',firstname:'Bob',lastname:'Other'}]}),/Conflicting names/);
  assert.equal(registry.archiveSha256,evidence.archiveSha256);
});
