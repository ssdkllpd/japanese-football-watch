'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshot, buildPrompt } = require('../jfw-analysis.js');
const { starterFromLineups, appearanceState } = require('../shared/player-appearance');

test('analysis uses the same-team starting lineup and bench even when every saved starter flag is true', () => {
  const lineups = [{ teamId: 'home', startXI: [{ id: 'p1' }], substitutes: [{ id: 'p2' }] },
    { teamId: 'away', startXI: [{ id: 'p3' }], substitutes: [] }];
  const rows = ['p1','p2','p3','p4'].map(playerId => ({ playerId, teamId: 'home', starter: true, values: {} }));
  const snapshot = buildSnapshot({ bundle: { lineups, playerStats: rows, sectionStates: { lineups: 'present', playerStats: 'present' } } });
  assert.deepEqual(snapshot.sections.playerStats.rows.map(row => row.starter), [true, false, null, null]);
  assert.ok(rows.every(row => row.starter === true), 'do not rewrite the original provider data');
  assert.equal(starterFromLineups(rows[0], [{ ...lineups[0], substitutes: [{ id: 'p1' }] }]), null);
  assert.equal(appearanceState(false, 25), 'substitute_used');
  assert.equal(appearanceState(false, 0), 'bench_unused');
  assert.equal(appearanceState(false, null), 'unknown');
  assert.equal(appearanceState(false, 0, 'provider_missing'), 'unknown');
});

test('analysis preserves acquired zero, missing, non-applicable and conflicting values as distinct states', () => {
  const snapshot = buildSnapshot({ bundle: {
    sectionStates: { playerStats: { presence: 'present' }, events: { presence: 'provider_missing' } },
    events: [{ type: 'goal' }],
    playerStats: [{ playerId: 'af:player:1', teamId: 'af:team:2',
      values: { goals: 0, assists: null, shots: 3, saves: 0, tackles: 2 },
      fieldStates: { shots: { presence: 'conflict' }, saves: { presence: 'not_applicable' } },
    }],
  } });
  const player = snapshot.sections.playerStats.rows[0];
  assert.equal(player.values.goals, 0);
  assert.equal(player.fieldStates.goals, undefined);
  assert.equal(player.values.shots, null);
  assert.equal(player.fieldStates.shots, 'conflict');
  assert.equal(player.values.saves, null);
  assert.equal(player.fieldStates.saves, 'not_applicable');
  assert.equal(player.values.penaltiesConceded, null);
  assert.equal(player.fieldStates.penaltiesConceded, 'not_fetched');
  assert.equal(player.values.tackles, 2);
  assert.deepEqual(snapshot.sections.events, { presence: 'provider_missing', rows: [] });
  assert.deepEqual(snapshot.sections.lineups, { presence: 'not_fetched', rows: [] });
});

test('analysis separates newer scoreboard from older details and does not export unrelated payload data', () => {
  const detailFixture = { id: 'af:fixture:1', status: { short: '2H', elapsed: 62 },
    reconciledAt: '2026-10-28T12:02:00Z', score: { goals: { home: 0, away: 0 } },
    provenance: { source: 'api-football', fetchedAt: '2026-10-28T12:02:00Z', issues: ['live_retained_playerStats'] },
  };
  const bundle = { fixture: detailFixture, secret: 'do-not-export', follows: ['private'],
    sectionStates: { teamStats: 'present' }, teamStats: [{ teamId: 'af:team:1', values: { shots: 0 } }],
  };
  const fixture = { ...detailFixture, status: { short: '2H', elapsed: 64 },
    reconciledAt: '2026-10-28T12:04:00Z', score: { goals: { home: 1, away: 0 } } };
  const capturedAt = '2026-10-28T12:05:00Z', receivedAt = '2026-10-28T12:03:00Z';
  const prompt = buildPrompt({ bundle, fixture, capturedAt, receivedAt, fixtureUrl: 'https://example.test/#/fixtures/af%3Afixture%3A1' });
  const snapshot = JSON.parse(prompt.split('JFWスナップショット（JSON）:\n')[1]);
  assert.equal(snapshot.capturedAt, capturedAt);
  assert.equal(snapshot.detailReceivedAt, receivedAt);
  assert.equal(snapshot.displayedFixture.score.goals.home, 1);
  assert.equal(snapshot.detailFixture.score.goals.home, 0);
  assert.equal(snapshot.sections.teamStats.rows[0].values.shots, 0);
  assert.deepEqual(snapshot.detailFixture.provenance.issues, ['live_retained_playerStats']);
  assert.match(prompt, /null・未掲載は0ではありません/);
  assert.doesNotMatch(prompt, /do-not-export|private/);
  assert.equal(bundle.fixture, detailFixture);
});

test('analysis labels JFW computation separately, retaining reasons and input gaps without publishing a fabricated score', () => {
  const snapshot = buildSnapshot({ bundle: {
    playerStats: [{ playerId: 'p1', values: { goals: 0 } }], sectionStates: { playerStats: 'present' },
  }, calculateRating: () => ({ value: null, ratingVersion: '1.0', reason: 'discipline_inputs_missing',
    missingRequired: ['penaltiesConceded'], ratingInputs: { goals: { state: 'value', value: 0 }, ownGoals: { state: 'value', value: 0 }, penaltiesConceded: { state: 'missing' } },
  }) });
  const rating = snapshot.sections.playerStats.rows[0].jfwRating;
  assert.equal(rating.value, null);
  assert.equal(rating.reason, 'discipline_inputs_missing');
  assert.deepEqual(rating.missingRequired, ['penaltiesConceded']);
  assert.deepEqual(rating.derivedInputs, { gaOnPitch: null, secondYellowRed: null, straightRed: null, ownGoals: 0 });
});
