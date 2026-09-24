export const FIXTURE_PUBLISH_BUDGET_OPERATION = 'fixture_publish_budget';
export const MAX_DAILY_FIXTURE_PUBLISHES = 20;

export function assertFixturePublishBudgetRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'operation,schemaVersion'
    || value.operation !== FIXTURE_PUBLISH_BUDGET_OPERATION) {
    throw new Error('Fixture publication budget request is invalid.');
  }
  return value;
}

export async function readFixturePublishBudget(env, now = new Date()) {
  if (!env.FOOTBALL_DB) throw new Error('D1 fixture publication budget is unavailable.');
  const dateUtc = now.toISOString().slice(0, 10);
  const result = await env.FOOTBALL_DB.prepare(`
    SELECT fixture_id FROM fixture_detail_publish_days WHERE date_utc = ?
    ORDER BY fixture_id
  `).bind(dateUtc).all();
  const fixtureIds = (result.results || []).map(row => row.fixture_id);
  if (fixtureIds.length > MAX_DAILY_FIXTURE_PUBLISHES) {
    throw new Error('D1 fixture publication budget exceeds the reviewed daily cap.');
  }
  return {
    schemaVersion: 'jfw-d1-admin-ingest-report/1',
    operation: FIXTURE_PUBLISH_BUDGET_OPERATION,
    dateUtc, fixtureIds, remaining: MAX_DAILY_FIXTURE_PUBLISHES - fixtureIds.length,
  };
}

export function dailyFixturePublishStatement(database, fixtureId, revision, now = new Date()) {
  const dateUtc = now.toISOString().slice(0, 10);
  return database.prepare(`
    INSERT INTO fixture_detail_publish_days(date_utc, fixture_id, revision_no, published_at)
    VALUES (?, ?, ?, ?)
  `).bind(dateUtc, fixtureId, revision, now.toISOString());
}
