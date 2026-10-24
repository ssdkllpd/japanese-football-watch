'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  STANDINGS_CONTRACT_VERSION,
  normalizeStandings,
  standingsLatestKey,
  standingsSnapshotKey,
  validateStandings,
  writeStandings,
} = require('../scripts/v2/fetch-standings');

function providerResponse() {
  return [{
    league: {
      id: 39,
      name: 'Premier League',
      country: 'England',
      logo: 'https://media.example/league.png',
      flag: 'https://media.example/flag.svg',
      season: 2026,
      standings: [[
        {
          rank: 1,
          team: { id: 40, name: 'Liverpool', logo: 'https://media.example/40.png' },
          points: 3,
          goalsDiff: 2,
          group: 'Premier League',
          form: 'W',
          status: 'same',
          description: 'Champions League',
          all: { played: 1, win: 1, draw: 0, lose: 0, goals: { for: 2, against: 0 } },
          home: { played: 1, win: 1, draw: 0, lose: 0, goals: { for: 2, against: 0 } },
          away: { played: 0, win: 0, draw: 0, lose: 0, goals: { for: 0, against: 0 } },
          update: '2026-08-22T01:00:00Z',
        },
        {
          rank: 2,
          team: { id: 50, name: 'Arsenal', logo: null },
          points: null,
          goalsDiff: null,
          group: 'Premier League',
          all: {},
        },
      ]],
    },
  }];
}

test('standings normalization keeps provider-native identity and explicit zero values', () => {
  const snapshot = normalizeStandings(providerResponse(), {
    league: 39,
    season: 2026,
    fetchedAt: '2026-08-22T02:00:00Z',
  });

  assert.equal(STANDINGS_CONTRACT_VERSION, '2.0.0');
  assert.equal(snapshot.contractVersion, '2.0.0');
  assert.equal(snapshot.competition.id, 'af:competition:39');
  assert.equal(snapshot.season.id, 'af:season:39:2026');
  assert.equal(snapshot.groups[0].table[0].team.id, 'af:team:40');
  assert.equal(snapshot.groups[0].table[0].overall.draws, 0);
  assert.equal(snapshot.groups[0].table[0].away.played, 0);
  assert.equal(snapshot.groups[0].table[1].points, null);
  assert.equal(snapshot.groups[0].table[1].overall.played, null);
  assert.equal(snapshot.sectionStates.standings.presence, 'present');
  assert.deepEqual(validateStandings(snapshot), []);
});

test('standings R2 keys include competition-specific season identity', () => {
  assert.equal(
    standingsLatestKey('af:competition:39', 'af:season:39:2026'),
    'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/latest.json',
  );
  assert.equal(
    standingsSnapshotKey('af:competition:39', 'af:season:39:2026', '2026-08-22T02:03:04Z'),
    'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/snapshots/20260822T020304Z.json',
  );
});

test('standings writer publishes an immutable snapshot and a latest object', () => {
  const snapshot = normalizeStandings(providerResponse(), {
    league: 39,
    season: 2026,
    fetchedAt: '2026-08-22T02:00:00Z',
  });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-standings-'));
  const manifest = writeStandings(outputDir, snapshot, {
    query: { league: 39, season: 2026 },
    quota: { dailyRemaining: 7000 },
  });

  assert.equal(manifest.rowCount, 2);
  assert.deepEqual(manifest.r2Objects.map(item => item.role), ['standings_snapshot', 'standings_latest']);
  assert.ok(fs.existsSync(path.join(outputDir, 'standings.json')));
  assert.ok(fs.existsSync(path.join(outputDir, 'manifest.json')));
});

test('missing standings IDs use only one exact provider team catalog identity, preserving the row and audit trail', async () => {
  const {fetchStandingsTeams}=require('../scripts/v2/fetch-standings');
  const raw=providerResponse();
  raw[0].league.standings[0][1].team={id:null,name:'Sabah FC',logo:null};
  const calls=[];
  const teams=await fetchStandingsTeams({get:async (endpoint,query)=>{
    calls.push({endpoint,query});
    return {data:{response:[{team:{id:9876,name:'Sabah FC'}}],results:1,paging:{total:1}}};
  }},raw,{league:39,season:2026});
  assert.deepEqual(calls,[{endpoint:'teams',query:{league:39,season:2026}}]);
  const snapshot=normalizeStandings(raw,{league:39,season:2026,teams});
  const row=snapshot.groups[0].table[1];
  assert.equal(row.team.id,'af:team:9876');
  assert.equal(row.team.name,'Sabah FC');
  assert.equal(row.points,null);
  assert.deepEqual(row.provenance.issues,['team_id_recovered_from_provider_team_catalog']);
  assert.equal(raw[0].league.standings[0][1].team.id,null,'Raw evidence must remain unchanged');
  const {assertValidStandingsPayload}=await import('../shared/standings-contract.mjs');
  // The original fixture intentionally omits home/away on its second row.
  row.home={played:null,wins:null,draws:null,losses:null,goalsFor:null,goalsAgainst:null};
  row.away=structuredClone(row.home);
  assert.doesNotThrow(()=>assertValidStandingsPayload(snapshot,{expectedCompetitionId:'af:competition:39',expectedSeasonId:'af:season:39:2026'}));
  for(const candidates of [[],[{id:9876,name:'Sabah'}],[{id:9876,name:'Sabah FC'},{id:9877,name:'Sabah FC'}]]) {
    assert.throws(()=>normalizeStandings(raw,{teams:candidates}),/cannot be uniquely recovered/);
  }
  await fetchStandingsTeams({get:()=>assert.fail('No extra team request for complete standings')},providerResponse(),{league:39,season:2026});
  await assert.rejects(()=>fetchStandingsTeams({get:async()=>({data:{response:[],paging:{total:2}}})},raw,{league:39,season:2026}),/incomplete/);
});
