'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { reconcileFixtureRevision, revisionContent } = require('../scripts/v2/reconcile-fixture-revision');

function bundle(overrides = {}) {
  return {
    contractVersion: '2.1.0',
    detailAvailability: 'available',
    fixture: {
      id: 'af:fixture:9001', providerId: 9001,
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
      kickoffUtc: '2026-08-21T20:00:00.000Z', dateJst: '2026-08-22',
      revision: 1,
      teams: { home: { id: 'af:team:40' }, away: { id: 'af:team:50' } },
      ...overrides,
    },
  };
}

test('fixture revision reconciliation starts at one and ignores an untrusted incoming revision', () => {
  const result = reconcileFixtureRevision(null, bundle({ revision: 99 }));
  assert.equal(result.bundle.fixture.revision, 1);
  assert.equal(result.reason, 'initial_revision');
});

test('fixture revision reconciliation preserves the revision only for identical canonical content', () => {
  const current = bundle({
    revision: 7, reconciledAt: '2026-08-21T22:00:00.000Z',
    provenance: { source: 'api-football', fetchedAt: '2026-08-21T22:00:00.000Z' },
  });
  const incoming = JSON.parse(JSON.stringify(current));
  incoming.fixture.revision = 1;
  incoming.fixture.reconciledAt = '2026-08-21T22:05:00.000Z';
  incoming.fixture.provenance.fetchedAt = '2026-08-21T22:05:00.000Z';
  const result = reconcileFixtureRevision(current, incoming);
  assert.equal(result.bundle.fixture.revision, 7);
  assert.equal(result.changed, false);
  assert.deepEqual(result.bundle, current);
});

test('fixture revision reconciliation increments after any stored contract content change', () => {
  const current = bundle({ revision: 7, statusShort: 'NS' });
  const incoming = bundle({ revision: 1, statusShort: '1H' });
  const result = reconcileFixtureRevision(current, incoming);
  assert.equal(result.bundle.fixture.revision, 8);
  assert.equal(result.reason, 'content_changed');
});

test('fixture revision comparison removes only recursive fetch and reconciliation timestamps', () => {
  assert.deepEqual(revisionContent({
    fetchedAt: 'outer', reconciledAt: 'outer', verifiedAt: 'keep',
    nested: [{ fetchedAt: 'inner', value: 1 }],
  }), {
    verifiedAt: 'keep', nested: [{ value: 1 }],
  });
});

test('fixture revision reconciliation rejects another fixture or a pre-2.1 current object', () => {
  const wrong = bundle({ id: 'af:fixture:9002', providerId: 9002 });
  assert.throws(() => reconcileFixtureRevision(wrong, bundle()), /fixture id differ/);
  const old = bundle();
  old.contractVersion = '2.0.0';
  assert.throws(() => reconcileFixtureRevision(old, bundle()), /contractVersion.*2\.1\.0/);
});

test('fixture publisher workflows reconcile the stored revision before every canonical R2 put', () => {
  for (const name of ['v2-fixture-vertical-slice.yml', 'v2-date-feed.yml']) {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');
    const reconcile = workflow.indexOf('reconcile-fixture-revision.js');
    const publish = workflow.indexOf('r2 object put', reconcile);
    assert.equal(reconcile > 0 && publish > reconcile, true, name);
    assert.match(workflow, /not found\|does not exist\|404/);
    assert.equal(workflow.includes('r2 object get') && workflow.includes('|| true'), false, name);
  }
});
