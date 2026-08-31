#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertValidDateIndexPayload, compareCodePoint } from '../../shared/date-index-contract.mjs';

const PLAN_VERSION = 'd1-date-index-coverage-plan/1';

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

export function importDateIndexCoverage(database, plan, planDirectory) {
  if (plan?.schemaVersion !== PLAN_VERSION) throw new Error(`schemaVersion must be ${PLAN_VERSION}.`);
  if (!Array.isArray(plan.competitionIndexes)) throw new Error('competitionIndexes must be an array.');

  const generic = readJsonArtifact(planDirectory, plan.dateIndex);
  assertValidDateIndexPayload(generic.payload, { expectedCompetitionId: null });
  const date = generic.payload.date;
  const competitionArtifacts = plan.competitionIndexes.map(relativePath => {
    const artifact = readJsonArtifact(planDirectory, relativePath);
    const competitionId = artifact.payload?.competition?.id;
    assertValidDateIndexPayload(artifact.payload, {
      expectedDate: date,
      expectedCompetitionId: competitionId,
    });
    return { artifact, competitionId };
  }).sort((left, right) => compareCodePoint(left.competitionId, right.competitionId));
  sortedUnique(competitionArtifacts.map(item => item.competitionId), 'competitionIndexes');

  database.exec('BEGIN IMMEDIATE');
  let competitions;
  try {
    assertSameIds(
      generic.payload.fixtures.map(fixture => fixture.fixtureId),
      fixtureIdsForDate(database, date),
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
      return { artifact: item.artifact, competition };
    });
    database.prepare(`
      INSERT INTO date_index_coverages(
        date_jst, fixture_count, generated_at, source_r2_key, source_sha256
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(date_jst) DO UPDATE SET
        fixture_count = excluded.fixture_count,
        generated_at = excluded.generated_at,
        source_r2_key = excluded.source_r2_key,
        source_sha256 = excluded.source_sha256`).run(
      date,
      generic.payload.fixtures.length,
      generic.payload.generatedAt,
      `football/v2/indexes/date-jst/${date}.json`,
      generic.sha256,
    );
    database.prepare('DELETE FROM competition_date_index_coverages WHERE date_jst = ?1').run(date);
    const insertCompetition = database.prepare(`
      INSERT INTO competition_date_index_coverages(
        competition_id, date_jst, fixture_count, generated_at, source_r2_key, source_sha256
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`);
    for (const item of competitions) {
      const competitionId = item.competition.canonical_id;
      insertCompetition.run(
        item.competition.id,
        date,
        item.artifact.payload.fixtures.length,
        item.artifact.payload.generatedAt,
        `football/v2/indexes/competition/${competitionId}/date-jst/${date}.json`,
        item.artifact.sha256,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return {
    schemaVersion: 'd1-date-index-coverage-report/1',
    date,
    generic: {
      fixtureCount: generic.payload.fixtures.length,
      sourceSha256: generic.sha256,
    },
    competitions: competitions.map(item => ({
      competitionId: item.competition.canonical_id,
      fixtureCount: item.artifact.payload.fixtures.length,
      sourceSha256: item.artifact.sha256,
    })),
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
