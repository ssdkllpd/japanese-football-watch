#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  assertValidStandingsPayload,
  compareCodePoint,
  standingsIdentityDigestInput,
} from '../../shared/standings-contract.mjs';

const PLAN_VERSION = 'd1-standings-import-plan/1';

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

function readArtifact(planDirectory, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Standings artifact path must be a non-empty relative path.');
  }
  const root = fs.realpathSync(planDirectory);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Standings artifact escapes the plan directory: ${relativePath}`);
  }
  const real = fs.realpathSync(resolved);
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`Standings artifact escapes the plan directory through a link: ${relativePath}`);
  }
  const raw = fs.readFileSync(real, 'utf8');
  return {
    payload: JSON.parse(raw),
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function expectedKey(competitionId, seasonId) {
  return `football/v2/competitions/${competitionId}/seasons/${seasonId}/standings/latest.json`;
}

function digest(groups) {
  return crypto.createHash('sha256').update(standingsIdentityDigestInput(groups)).digest('hex');
}

function resolveSeason(database, competitionId, seasonId) {
  return database.prepare(`
    SELECT season.id, season.provider_season, competition.source_id,
      competition.id AS competition_internal_id,
      competition.provider_id AS competition_provider_id
    FROM competition_seasons season
    JOIN competitions competition ON competition.id = season.competition_id
    WHERE competition.canonical_id = ?1 AND season.canonical_id = ?2
  `).get(competitionId, seasonId) || null;
}

function upsertTeam(database, sourceId, team) {
  const providerId = team.providerId;
  const existing = database.prepare(`
    SELECT id, provider_id FROM teams WHERE canonical_id = ?1
  `).get(team.id);
  if (existing) {
    if (existing.provider_id !== providerId) throw new Error(`Stored team provider ID differs: ${team.id}`);
    database.prepare(`
      UPDATE teams SET name = ?2, logo_url = ?3 WHERE id = ?1
    `).run(existing.id, team.name, team.logo);
    return existing.id;
  }
  const result = database.prepare(`
    INSERT INTO teams(canonical_id, source_id, provider_id, name, logo_url)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).run(team.id, sourceId, providerId, team.name, team.logo);
  return Number(result.lastInsertRowid);
}

function scopeValues(scope) {
  return [scope.played, scope.wins, scope.draws, scope.losses, scope.goalsFor, scope.goalsAgainst];
}

function writeArtifact(database, declaration, artifact) {
  const payload = artifact.payload;
  assertValidStandingsPayload(payload, {
    expectedCompetitionId: declaration.competitionId,
    expectedSeasonId: declaration.seasonId,
  });
  const canonicalKey = expectedKey(declaration.competitionId, declaration.seasonId);
  if (declaration.sourceR2Key !== canonicalKey) {
    throw new Error(`Standings sourceR2Key must be ${canonicalKey}.`);
  }
  const season = resolveSeason(database, declaration.competitionId, declaration.seasonId);
  if (!season) throw new Error(`Competition-season is not stored in D1: ${declaration.seasonId}`);
  if (season.provider_season !== payload.season.providerSeason
    || season.competition_provider_id !== payload.competition.providerId) {
    throw new Error(`Competition-season provider identity differs: ${declaration.seasonId}`);
  }
  database.prepare(`
    UPDATE competitions SET name = ?2, country_name = ?3, logo_url = ?4, flag_url = ?5
    WHERE id = ?1
  `).run(
    season.competition_internal_id,
    payload.competition.name,
    payload.competition.country,
    payload.competition.logo,
    payload.competition.flag,
  );
  database.prepare(`UPDATE competition_seasons SET label = ?2 WHERE id = ?1`)
    .run(season.id, payload.season.label ?? String(payload.season.providerSeason));

  let snapshot = database.prepare(`
    SELECT id FROM standings_snapshots
    WHERE competition_season_id = ?1 AND observed_at = ?2
  `).get(season.id, payload.generatedAt);
  if (snapshot) {
    database.prepare('DELETE FROM standings_publications WHERE snapshot_id = ?1').run(snapshot.id);
    database.prepare('DELETE FROM standings_rows WHERE snapshot_id = ?1').run(snapshot.id);
    database.prepare('DELETE FROM standings_groups WHERE snapshot_id = ?1').run(snapshot.id);
    database.prepare(`
      UPDATE standings_snapshots SET checksum = ?2, contract_version = ?3,
        section_presence = ?4, provenance_source = ?5, provenance_fetched_at = ?6,
        provenance_verification = ?7, provenance_issues_json = ?8
      WHERE id = ?1
    `).run(
      snapshot.id,
      artifact.sha256,
      payload.contractVersion,
      payload.sectionStates.standings.presence,
      payload.provenance.source,
      payload.provenance.fetchedAt,
      payload.provenance.verification,
      JSON.stringify(payload.provenance.issues),
    );
  } else {
    const result = database.prepare(`
      INSERT INTO standings_snapshots(
        competition_season_id, observed_at, is_final, checksum, contract_version,
        section_presence, provenance_source, provenance_fetched_at,
        provenance_verification, provenance_issues_json
      ) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(
      season.id,
      payload.generatedAt,
      artifact.sha256,
      payload.contractVersion,
      payload.sectionStates.standings.presence,
      payload.provenance.source,
      payload.provenance.fetchedAt,
      payload.provenance.verification,
      JSON.stringify(payload.provenance.issues),
    );
    snapshot = { id: Number(result.lastInsertRowid) };
  }

  const insertGroup = database.prepare(`
    INSERT INTO standings_groups(snapshot_id, group_id, group_name, group_order)
    VALUES (?1, ?2, ?3, ?4)
  `);
  const insertRow = database.prepare(`
    INSERT INTO standings_rows(
      snapshot_id, team_id, rank, points, played, goal_difference, form,
      group_id, row_order, wins, draws, losses, goals_for, goals_against,
      home_played, home_wins, home_draws, home_losses, home_goals_for, home_goals_against,
      away_played, away_wins, away_draws, away_losses, away_goals_for, away_goals_against,
      status, description, updated_at, provenance_source, provenance_fetched_at,
      provenance_verification, provenance_issues_json
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
      ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
      ?31, ?32, ?33
    )
  `);
  let rowCount = 0;
  for (let groupOrder = 0; groupOrder < payload.groups.length; groupOrder += 1) {
    const group = payload.groups[groupOrder];
    insertGroup.run(snapshot.id, group.id, group.name, groupOrder);
    for (let rowOrder = 0; rowOrder < group.table.length; rowOrder += 1) {
      const row = group.table[rowOrder];
      const teamId = upsertTeam(database, season.source_id, row.team);
      database.prepare(`
        INSERT OR IGNORE INTO competition_season_teams(competition_season_id, team_id)
        VALUES (?1, ?2)
      `).run(season.id, teamId);
      insertRow.run(
        snapshot.id, teamId, row.rank, row.points,
        row.overall.played, row.goalDifference, row.form,
        group.id, rowOrder,
        ...scopeValues(row.overall).slice(1),
        ...scopeValues(row.home),
        ...scopeValues(row.away),
        row.status, row.description, row.updatedAt,
        row.provenance.source, row.provenance.fetchedAt,
        row.provenance.verification, JSON.stringify(row.provenance.issues),
      );
      rowCount += 1;
    }
  }
  const identityDigest = digest(payload.groups);
  database.prepare(`
    INSERT INTO standings_publications(
      competition_season_id, snapshot_id, row_count, identity_digest,
      generated_at, source_r2_key, source_sha256
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(competition_season_id) DO UPDATE SET
      snapshot_id = excluded.snapshot_id,
      row_count = excluded.row_count,
      identity_digest = excluded.identity_digest,
      generated_at = excluded.generated_at,
      source_r2_key = excluded.source_r2_key,
      source_sha256 = excluded.source_sha256
  `).run(
    season.id,
    snapshot.id,
    rowCount,
    identityDigest,
    payload.generatedAt,
    declaration.sourceR2Key,
    artifact.sha256,
  );
  return {
    competitionId: declaration.competitionId,
    seasonId: declaration.seasonId,
    groupCount: payload.groups.length,
    rowCount,
    identityDigest,
    sourceR2Key: declaration.sourceR2Key,
    artifactSha256: artifact.sha256,
  };
}

export function importStandingsPlan(database, plan, planDirectory) {
  if (plan?.schemaVersion !== PLAN_VERSION) throw new Error(`schemaVersion must be ${PLAN_VERSION}.`);
  if (!Array.isArray(plan.standings) || plan.standings.length === 0) {
    throw new Error('standings must contain at least one declaration.');
  }
  const declarations = plan.standings.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`standings[${index}] must be an object.`);
    }
    if (!/^af:competition:\d+$/.test(String(value.competitionId || ''))
      || !/^af:season:\d+:\d+$/.test(String(value.seasonId || ''))
      || typeof value.path !== 'string' || !value.path
      || typeof value.sourceR2Key !== 'string' || !value.sourceR2Key) {
      throw new Error(`standings[${index}] declaration is incomplete.`);
    }
    return value;
  }).sort((left, right) => compareCodePoint(
    `${left.competitionId}\t${left.seasonId}`,
    `${right.competitionId}\t${right.seasonId}`,
  ));
  const scopes = declarations.map(value => `${value.competitionId}\t${value.seasonId}`);
  if (new Set(scopes).size !== scopes.length) throw new Error('Standings plan contains duplicate scopes.');
  const artifacts = declarations.map(declaration => ({
    declaration,
    artifact: readArtifact(planDirectory, declaration.path),
  }));
  database.exec('BEGIN IMMEDIATE');
  try {
    const results = artifacts.map(item => writeArtifact(database, item.declaration, item.artifact));
    database.exec('COMMIT');
    return {
      schemaVersion: 'd1-standings-import-report/1',
      standings: results,
      passed: true,
      productionReady: false,
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['--database'] || !args['--plan']) {
    throw new Error('Usage: import-standings.mjs --database <sqlite> --plan <json> [--report <json>]');
  }
  const planPath = path.resolve(args['--plan']);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const database = new DatabaseSync(path.resolve(args['--database']));
  try {
    database.exec('PRAGMA foreign_keys = ON');
    const report = importStandingsPlan(database, plan, path.dirname(planPath));
    if (args['--report']) {
      fs.mkdirSync(path.dirname(path.resolve(args['--report'])), { recursive: true });
      fs.writeFileSync(path.resolve(args['--report']), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    database.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
