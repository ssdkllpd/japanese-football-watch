#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  assertValidDateIndexPayload,
  compareCodePoint,
  fixtureIdDigestInput,
} from '../../shared/date-index-contract.mjs';

const PLAN_VERSION = 'd1-date-index-coverage-plan/2';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function readJsonArtifact(planDirectory, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Coverage artifact path must be a non-empty string.');
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Coverage artifact path must be relative to the plan directory: ${relativePath}`);
  }
  const root = fs.realpathSync(planDirectory);
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Coverage artifact escapes the plan directory: ${relativePath}`);
  }
  const realPath = fs.realpathSync(absolutePath);
  const realRelative = path.relative(root, realPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`Coverage artifact escapes the plan directory through a link: ${relativePath}`);
  }
  const raw = fs.readFileSync(realPath, 'utf8');
  return {
    absolutePath: realPath,
    payload: JSON.parse(raw),
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function sortedUnique(values, label) {
  const sorted = [...values].sort(compareCodePoint);
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contains duplicate IDs.`);
  return sorted;
}

function assertSameIds(expected, stored, label) {
  const left = sortedUnique(expected, `${label} expected fixture set`);
  const right = sortedUnique(stored, `${label} stored fixture set`);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} fixture identity set does not match D1.`);
  }
}

function fixtureIdDigest(ids) {
  return crypto.createHash('sha256')
    .update(fixtureIdDigestInput(ids.map(fixtureId => ({ fixtureId }))))
    .digest('hex');
}

function expectedDateKey(date) {
  return `football/v2/indexes/date-jst/${date}.json`;
}

function expectedCompetitionDateKey(competitionId, date) {
  return `football/v2/indexes/competition/${competitionId}/date-jst/${date}.json`;
}

function validateArtifactDeclaration(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (typeof value.path !== 'string' || value.path.length === 0) {
    throw new Error(`${label}.path must be a non-empty string.`);
  }
  if (typeof value.sourceR2Key !== 'string' || value.sourceR2Key.length === 0) {
    throw new Error(`${label}.sourceR2Key must be a non-empty string.`);
  }
}

function fixtureIdsForDate(database, date) {
  return database.prepare(`
    SELECT canonical_id
    FROM fixtures
    WHERE date_jst = ?1
    ORDER BY canonical_id`).all(date).map(row => row.canonical_id);
}

function competitionForId(database, competitionId) {
  return database.prepare(`
    SELECT id, canonical_id
    FROM competitions
    WHERE canonical_id = ?1`).get(competitionId) || null;
}

function fixtureIdsForCompetitionDate(database, competitionInternalId, date) {
  return database.prepare(`
    SELECT fixture.canonical_id
    FROM fixtures fixture
    JOIN competition_seasons season ON season.id = fixture.competition_season_id
    WHERE season.competition_id = ?1 AND fixture.date_jst = ?2
    ORDER BY fixture.canonical_id`).all(competitionInternalId, date).map(row => row.canonical_id);
}

function competitionIdsWithFixturesForDate(database, date) {
  return database.prepare(`
    SELECT DISTINCT competition.canonical_id
    FROM fixtures fixture
    JOIN competition_seasons season ON season.id = fixture.competition_season_id
    JOIN competitions competition ON competition.id = season.competition_id
    WHERE fixture.date_jst = ?1
    ORDER BY competition.canonical_id`).all(date).map(row => row.canonical_id);
}

export function importDateIndexCoverage(database, plan, planDirectory) {
  if (plan?.schemaVersion !== PLAN_VERSION) throw new Error(`schemaVersion must be ${PLAN_VERSION}.`);
  if (typeof plan.date !== 'string') throw new Error('date must be declared in the coverage plan.');
  if (!Array.isArray(plan.competitionIndexes)) throw new Error('competitionIndexes must be an array.');

  validateArtifactDeclaration(plan.dateIndex, 'dateIndex');
  const date = plan.date;
  if (plan.dateIndex.sourceR2Key !== expectedDateKey(date)) {
    throw new Error(`dateIndex.sourceR2Key must match the declared date: ${expectedDateKey(date)}`);
  }
  const generic = readJsonArtifact(planDirectory, plan.dateIndex.path);
  assertValidDateIndexPayload(generic.payload, {
    expectedDate: date,
    expectedCompetitionId: null,
  });
  const competitionArtifacts = plan.competitionIndexes.map((declaration, index) => {
    validateArtifactDeclaration(declaration, `competitionIndexes[${index}]`);
    const competitionId = declaration.competitionId;
    if (!/^af:competition:\d+$/.test(String(competitionId || ''))) {
      throw new Error(`competitionIndexes[${index}].competitionId must be canonical.`);
    }
    const expectedKey = expectedCompetitionDateKey(competitionId, date);
    if (declaration.sourceR2Key !== expectedKey) {
      throw new Error(`competitionIndexes[${index}].sourceR2Key must be ${expectedKey}.`);
    }
    const artifact = readJsonArtifact(planDirectory, declaration.path);
    assertValidDateIndexPayload(artifact.payload, {
      expectedDate: date,
      expectedCompetitionId: competitionId,
    });
    return { artifact, competitionId, sourceR2Key: declaration.sourceR2Key };
  }).sort((left, right) => compareCodePoint(left.competitionId, right.competitionId));
  sortedUnique(competitionArtifacts.map(item => item.competitionId), 'competitionIndexes');

  database.exec('BEGIN IMMEDIATE');
  let competitions;
  try {
    const declaredCompetitionIds = competitionArtifacts.map(item => item.competitionId);
    const requiredCompetitionIds = competitionIdsWithFixturesForDate(database, date);
    const undeclaredCompetitions = requiredCompetitionIds
      .filter(competitionId => !declaredCompetitionIds.includes(competitionId));
    if (undeclaredCompetitions.length > 0) {
      throw new Error(`Coverage plan omits competitions with fixtures on ${date}: ${undeclaredCompetitions.join(', ')}`);
    }
    const genericStoredIds = fixtureIdsForDate(database, date);
    assertSameIds(
      generic.payload.fixtures.map(fixture => fixture.fixtureId),
      genericStoredIds,
      `generic date ${date}`,
    );
    competitions = competitionArtifacts.map(item => {
      const competition = competitionForId(database, item.competitionId);
      if (!competition) throw new Error(`Competition is not stored in D1: ${item.competitionId}`);
      assertSameIds(
        item.artifact.payload.fixtures.map(fixture => fixture.fixtureId),
        fixtureIdsForCompetitionDate(database, competition.id, date),
        `competition date ${item.competitionId}/${date}`,
      );
      return { artifact: item.artifact, competition, sourceR2Key: item.sourceR2Key };
    });
    database.prepare(`
      INSERT INTO date_index_coverages(
        date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(date_jst) DO UPDATE SET
        fixture_count = excluded.fixture_count,
        fixture_id_digest = excluded.fixture_id_digest,
        generated_at = excluded.generated_at,
        source_r2_key = excluded.source_r2_key,
        source_sha256 = excluded.source_sha256`).run(
      date,
      generic.payload.fixtures.length,
      fixtureIdDigest(genericStoredIds),
      generic.payload.generatedAt,
      plan.dateIndex.sourceR2Key,
      generic.sha256,
    );
    database.prepare('DELETE FROM competition_date_index_coverages WHERE date_jst = ?1').run(date);
    const insertCompetition = database.prepare(`
      INSERT INTO competition_date_index_coverages(
        competition_id, date_jst, fixture_count, fixture_id_digest,
        generated_at, source_r2_key, source_sha256
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`);
    for (const item of competitions) {
      const competitionId = item.competition.canonical_id;
      const storedIds = fixtureIdsForCompetitionDate(database, item.competition.id, date);
      insertCompetition.run(
        item.competition.id,
        date,
        item.artifact.payload.fixtures.length,
        fixtureIdDigest(storedIds),
        item.artifact.payload.generatedAt,
        item.sourceR2Key,
        item.artifact.sha256,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return {
    schemaVersion: 'd1-date-index-coverage-report/2',
    date,
    generic: {
      fixtureCount: generic.payload.fixtures.length,
      fixtureIdDigest: fixtureIdDigest(generic.payload.fixtures.map(fixture => fixture.fixtureId)),
      sourceR2Key: plan.dateIndex.sourceR2Key,
      artifactSha256: generic.sha256,
    },
    competitions: competitions.map(item => ({
      competitionId: item.competition.canonical_id,
      fixtureCount: item.artifact.payload.fixtures.length,
      fixtureIdDigest: fixtureIdDigest(item.artifact.payload.fixtures.map(fixture => fixture.fixtureId)),
      sourceR2Key: item.sourceR2Key,
      artifactSha256: item.artifact.sha256,
    })),
    undeclaredCompetitions: [],
    passed: true,
    productionReady: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['--database'] || !args['--plan']) {
    throw new Error('Usage: import-date-index-coverage.mjs --database <sqlite> --plan <json> [--report <json>]');
  }
  const planPath = path.resolve(args['--plan']);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const database = new DatabaseSync(path.resolve(args['--database']));
  database.exec('PRAGMA foreign_keys = ON');
  try {
    const report = importDateIndexCoverage(database, plan, path.dirname(planPath));
    if (args['--report']) {
      fs.writeFileSync(path.resolve(args['--report']), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
