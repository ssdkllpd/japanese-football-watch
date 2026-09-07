'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../app-v2-router.js');

test('canonical routes preserve entity ids, tabs and season namespaces', () => {
  assert.deepEqual(
    router.parseHash('#/fixtures/af%3Afixture%3A42?tab=ratings&player=jfw%3A7&ratingMode=jfw'),
    {
      kind: 'fixture', page: 'matches', fixtureId: 'af:fixture:42', tab: 'ratings',
      playerId: 'jfw:7', ratingMode: 'jfw',
      canonicalHash: '#/fixtures/af%3Afixture%3A42?tab=ratings&player=jfw%3A7&ratingMode=jfw', shouldReplace: false,
    },
  );
  assert.equal(router.parseHash('#/competitions/af%3Acompetition%3A39?competitionSeason=af%3Aseason%3A2026&tab=standings').tab, 'standings');
});

test('match filters are canonical and live=1 is normalized once', () => {
  const legacy = router.parseHash('#/matches?date=2026-09-04&live=1');
  assert.equal(legacy.filter, 'live');
  assert.equal(legacy.canonicalHash, '#/matches?date=2026-09-04&filter=live');
  assert.equal(legacy.shouldReplace, true);
  assert.equal(router.parseHash('#/matches?filter=unknown', { date: '2026-09-04' }).filter, 'all');
});

test('season parameters fail closed when the namespace belongs to another screen', () => {
  const competition = router.parseHash('#/competitions/39?competitionSeason=jfw%3Aseason%3A2026-27');
  const player = router.parseHash('#/players/7?productSeason=af%3Aseason%3A2026');
  assert.equal(competition.code, 'invalid_season_namespace');
  assert.equal(competition.status, 400);
  assert.equal(player.code, 'invalid_season_namespace');
});

test('only documented legacy hashes migrate and unknown hashes become a 404 state', () => {
  assert.equal(router.parseHash('#insights').canonicalHash, '#/japanese');
  assert.equal(router.parseHash('#coverage').canonicalHash, '#/more');
  assert.equal(router.parseHash('#players').status, 404);
  assert.equal(router.parseHash('#made-up').status, 404);
});

test('invalid or missing dates and slash root normalize to an honest canonical date',()=>{
 for(const hash of ['#/matches?date=2026-02-30','#/matches','#/']) {
 const route=router.parseHash(hash,{date:'2026-09-01'});assert.equal(route.date,'2026-09-01');assert.equal(route.shouldReplace,true);assert.equal(route.canonicalHash,'#/matches?date=2026-09-01&filter=all');
 }
 assert.equal(router.pageHash('leagues'),'#/competitions');
 assert.equal(router.parseHash('#matches?date=2026-09-01&live=1').filter,'live');
});
test('legacy names migrate once only with a unique exact canonical identity',()=>{
 const input={players:[{name:'Player',id:'af:player:7'},{name:'Player Two',id:'af:player:8'}]};
 const resolved=router.migrateLegacy('?player=Player&season=2026-27&source=share','#stats',input);
 assert.equal(resolved.hash,'#/players/af%3Aplayer%3A7?productSeason=jfw%3Aseason%3A2026-27');assert.equal(resolved.search,'?source=share');
 assert.equal(router.migrateLegacy(resolved.search,resolved.hash,input),null);
 assert.equal(router.migrateLegacy('?player=Player','','').hash,'#/japanese');
 assert.equal(router.migrateLegacy('?player=Player','', {players:[...input.players,{name:'Player',id:'af:player:9'}]}).hash,'#/japanese');
 assert.equal(router.migrateLegacy('?club=Unknown&campaign=x','').hash,'#/competitions');
 assert.equal(router.migrateLegacy('?player=Player','#players',input),null);
});
