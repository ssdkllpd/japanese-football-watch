'use strict';

const POLICY_VERSION = 'jfw-api-football-automation-policy/1';
const STATE_VERSION = 'jfw-api-football-automation-state/1';
const PLAN_VERSION = 'jfw-api-football-automation-plan/1';
const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN']);
const REVIEWED_SCOPES = ['39:2026', '40:2026', '61:2026', '78:2026', '88:2026', '94:2026',
  '135:2026', '140:2026', '144:2026', '179:2026'];
const REVIEWED_RECHECKS = [
  { stage: 'initial', afterHours: 0 },
  { stage: 'correction_6h', afterHours: 6 },
  { stage: 'correction_24h', afterHours: 24 },
  { stage: 'correction_72h', afterHours: 72 },
];
const RECHECK_STAGES = new Set(REVIEWED_RECHECKS.map(item => item.stage));

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(', ')}.`);
  }
}

function positiveInteger(value, label, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`);
  }
  return value;
}

function validatePolicy(policy) {
  exactKeys(policy, [
    'schemaVersion', 'scheduledSynchronizationEnabled', 'timeZone', 'cron',
    'competitionSeasons', 'discovery', 'finalDetailRechecks', 'limits',
  ], 'Automation policy');
  if (policy.schemaVersion !== POLICY_VERSION) throw new Error(`schemaVersion must be ${POLICY_VERSION}.`);
  if (typeof policy.scheduledSynchronizationEnabled !== 'boolean') {
    throw new Error('scheduledSynchronizationEnabled must be boolean.');
  }
  if (policy.timeZone !== 'Asia/Tokyo') throw new Error('Automation timeZone must be Asia/Tokyo.');
  if (policy.cron !== '*/15 * * * *') throw new Error('Automation cron must stay at the reviewed 15-minute cadence.');
  if (!Array.isArray(policy.competitionSeasons) || policy.competitionSeasons.length !== 10) {
    throw new Error('competitionSeasons must declare the reviewed ten-league scope.');
  }
  const scopes = new Set();
  for (const [index, scope] of policy.competitionSeasons.entries()) {
    exactKeys(scope, ['league', 'season'], `competitionSeasons[${index}]`);
    positiveInteger(scope.league, `competitionSeasons[${index}].league`);
    positiveInteger(scope.season, `competitionSeasons[${index}].season`);
    const key = `${scope.league}:${scope.season}`;
    if (scopes.has(key)) throw new Error(`competitionSeasons contains duplicate scope ${key}.`);
    scopes.add(key);
  }
  if (JSON.stringify([...scopes].sort()) !== JSON.stringify([...REVIEWED_SCOPES].sort())) {
    throw new Error('competitionSeasons differs from the reviewed ten-league 2026 scope.');
  }
  exactKeys(policy.discovery, [
    'lookbackDays', 'lookaheadDays', 'eligibleAfterKickoffHours',
  ], 'discovery');
  positiveInteger(policy.discovery.lookbackDays, 'discovery.lookbackDays', true);
  positiveInteger(policy.discovery.lookaheadDays, 'discovery.lookaheadDays', true);
  positiveInteger(policy.discovery.eligibleAfterKickoffHours, 'discovery.eligibleAfterKickoffHours');
  if (policy.discovery.lookbackDays !== 1 || policy.discovery.lookaheadDays !== 1
    || policy.discovery.eligibleAfterKickoffHours !== 3) {
    throw new Error('discovery differs from the reviewed one-day window and three-hour finality delay.');
  }
  if (!Array.isArray(policy.finalDetailRechecks) || policy.finalDetailRechecks.length !== 4) {
    throw new Error('finalDetailRechecks must declare the four reviewed stages.');
  }
  let priorHours = -1;
  const stageNames = new Set();
  for (const [index, stage] of policy.finalDetailRechecks.entries()) {
    exactKeys(stage, ['stage', 'afterHours'], `finalDetailRechecks[${index}]`);
    if (!/^[a-z][a-z0-9_]*$/.test(stage.stage) || stageNames.has(stage.stage)) {
      throw new Error(`finalDetailRechecks[${index}].stage is invalid or duplicated.`);
    }
    positiveInteger(stage.afterHours, `finalDetailRechecks[${index}].afterHours`, true);
    if (stage.afterHours <= priorHours) throw new Error('finalDetailRechecks must be strictly increasing.');
    priorHours = stage.afterHours;
    stageNames.add(stage.stage);
  }
  if (JSON.stringify(policy.finalDetailRechecks) !== JSON.stringify(REVIEWED_RECHECKS)) {
    throw new Error('finalDetailRechecks differs from the reviewed 0/6/24/72-hour policy.');
  }
  exactKeys(policy.limits, [
    'dailyRequestReserve', 'minimumRequestIntervalMs', 'maxProviderRequestsPerRun',
    'maxFinalDetailFixturesPerRun', 'maxStandingsPerRun', 'standingsMinimumIntervalHours',
  ], 'limits');
  for (const key of Object.keys(policy.limits)) positiveInteger(policy.limits[key], `limits.${key}`);
  if (policy.limits.maxFinalDetailFixturesPerRun > 20) {
    throw new Error('maxFinalDetailFixturesPerRun exceeds the reviewed hard cap of 20.');
  }
  if (policy.limits.dailyRequestReserve < 100
    || policy.limits.minimumRequestIntervalMs < 300
    || policy.limits.maxProviderRequestsPerRun > 150
    || policy.limits.maxStandingsPerRun > 10
    || policy.limits.standingsMinimumIntervalHours < 6) {
    throw new Error('Automation limits exceed the reviewed request or cadence budget.');
  }
  return policy;
}

function emptyAutomationState() {
  return { schemaVersion: STATE_VERSION, fixtures: {}, standings: {},
    lastSuccessfulRunAt: null, pendingDiscoveryDate: null };
}

function validateState(value) {
  const state = value && !Object.hasOwn(value, 'pendingDiscoveryDate')
    ? { ...value, pendingDiscoveryDate: null } : value || emptyAutomationState();
  exactKeys(state, ['schemaVersion', 'fixtures', 'standings', 'lastSuccessfulRunAt',
    'pendingDiscoveryDate'], 'Automation state');
  if (state.schemaVersion !== STATE_VERSION) throw new Error(`Automation state schemaVersion must be ${STATE_VERSION}.`);
  for (const key of ['fixtures', 'standings']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) {
      throw new Error(`Automation state ${key} must be an object.`);
    }
  }
  if (state.lastSuccessfulRunAt !== null && !Number.isFinite(Date.parse(state.lastSuccessfulRunAt))) {
    throw new Error('Automation state lastSuccessfulRunAt must be null or a timestamp.');
  }
  if (state.pendingDiscoveryDate !== null && !realDate(state.pendingDiscoveryDate)) {
    throw new Error('Automation state pendingDiscoveryDate must be null or a real JST date.');
  }
  for (const [fixtureId, fixture] of Object.entries(state.fixtures)) {
    exactKeys(fixture, [
      'providerFixtureId', 'fixtureId', 'competitionId', 'seasonId', 'league', 'season',
      'kickoffUtc', 'lastStatus', 'completedStages', 'lastDetailFetchedAt',
    ], `Automation state fixture ${fixtureId}`);
    positiveInteger(fixture.providerFixtureId, `Automation state fixture ${fixtureId}.providerFixtureId`);
    positiveInteger(fixture.league, `Automation state fixture ${fixtureId}.league`);
    positiveInteger(fixture.season, `Automation state fixture ${fixtureId}.season`);
    if (fixtureId !== fixture.fixtureId || fixture.fixtureId !== `af:fixture:${fixture.providerFixtureId}`) {
      throw new Error(`Automation state fixture ${fixtureId} has inconsistent identity.`);
    }
    if (fixture.competitionId !== `af:competition:${fixture.league}`
      || fixture.seasonId !== `af:season:${fixture.league}:${fixture.season}`) {
      throw new Error(`Automation state fixture ${fixtureId} has inconsistent competition scope.`);
    }
    if (!Number.isFinite(Date.parse(fixture.kickoffUtc)) || !FINAL_STATUSES.has(fixture.lastStatus)) {
      throw new Error(`Automation state fixture ${fixtureId} has invalid final metadata.`);
    }
    if (!Array.isArray(fixture.completedStages)
      || fixture.completedStages.some(stage => !RECHECK_STAGES.has(stage))
      || new Set(fixture.completedStages).size !== fixture.completedStages.length) {
      throw new Error(`Automation state fixture ${fixtureId} has invalid completedStages.`);
    }
    const expectedStages = REVIEWED_RECHECKS.slice(0, fixture.completedStages.length)
      .map(item => item.stage);
    if (JSON.stringify(fixture.completedStages) !== JSON.stringify(expectedStages)) {
      throw new Error(`Automation state fixture ${fixtureId} completedStages must be a prefix.`);
    }
    if (fixture.lastDetailFetchedAt === null && fixture.completedStages.length === 0) continue;
    if (!Number.isFinite(Date.parse(fixture.lastDetailFetchedAt))) {
      throw new Error(`Automation state fixture ${fixtureId} has invalid lastDetailFetchedAt.`);
    }
  }
  for (const [scope, standings] of Object.entries(state.standings)) {
    exactKeys(standings, ['lastFetchedAt'], `Automation state standings ${scope}`);
    const match = /^af:competition:(\d+)\/af:season:(\d+):(\d+)$/.exec(scope);
    if (!match || match[1] !== match[2] || !Number.isFinite(Date.parse(standings.lastFetchedAt))) {
      throw new Error(`Automation state standings ${scope} is invalid.`);
    }
  }
  return state;
}

function dateJst(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Automation time is invalid.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function shiftDate(date, days) {
  const base = new Date(`${date}T12:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return dateJst(base);
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const instant = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

function discoveryDates(policy, now) {
  const center = dateJst(now);
  const result = [];
  for (let offset = -policy.discovery.lookbackDays; offset <= policy.discovery.lookaheadDays; offset += 1) {
    result.push(shiftDate(center, offset));
  }
  return result;
}

function startAutomationDiscovery(state, policy, now) {
  const next = structuredClone(validateState(state));
  validatePolicy(policy);
  next.pendingDiscoveryDate ||= discoveryDates(policy, now)[0];
  return validateState(next);
}

function plannedDiscoveryDates(policy, state, now) {
  const normal = discoveryDates(policy, now);
  const first = state.pendingDiscoveryDate || normal[0];
  const dates = [];
  for (let date = first; date <= normal.at(-1) && dates.length < normal.length;
    date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function canonicalFixture(row) {
  const providerFixtureId = Number(row?.fixture?.id);
  const league = Number(row?.league?.id);
  const season = Number(row?.league?.season);
  const kickoff = new Date(row?.fixture?.date);
  if (!Number.isSafeInteger(providerFixtureId) || providerFixtureId <= 0
    || !Number.isSafeInteger(league) || league <= 0
    || !Number.isSafeInteger(season) || season <= 0
    || Number.isNaN(kickoff.getTime())) return null;
  return {
    providerFixtureId,
    fixtureId: `af:fixture:${providerFixtureId}`,
    competitionId: `af:competition:${league}`,
    seasonId: `af:season:${league}:${season}`,
    league,
    season,
    kickoffUtc: kickoff.toISOString(),
    status: String(row?.fixture?.status?.short || '').toUpperCase(),
  };
}

function completedStages(state, fixtureId) {
  const stages = state.fixtures?.[fixtureId]?.completedStages;
  return new Set(Array.isArray(stages) ? stages.filter(value => typeof value === 'string') : []);
}

function nextDueStage(policy, state, fixture, nowMs) {
  if (!FINAL_STATUSES.has(fixture.status)) return null;
  const eligibleAt = Date.parse(fixture.kickoffUtc)
    + policy.discovery.eligibleAfterKickoffHours * 60 * 60 * 1000;
  const completed = completedStages(state, fixture.fixtureId);
  for (const stage of policy.finalDetailRechecks) {
    const dueAt = eligibleAt + stage.afterHours * 60 * 60 * 1000;
    if (!completed.has(stage.stage) && nowMs >= dueAt) {
      return { ...stage, dueAt: new Date(dueAt).toISOString() };
    }
  }
  return null;
}

function hoursSince(timestamp, nowMs) {
  const parsed = Date.parse(timestamp || '');
  return Number.isFinite(parsed) ? (nowMs - parsed) / 3600000 : Infinity;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function planAutomation({ policy, state, fixturesByDate, now, quota = {}, preview = false,
  dailyBudget = null }) {
  validatePolicy(policy);
  state = validateState(state);
  const nowDate = new Date(now || Date.now());
  if (Number.isNaN(nowDate.getTime())) throw new Error('Automation plan now is invalid.');
  const dates = plannedDiscoveryDates(policy, state, nowDate);
  const expectedDates = Object.keys(fixturesByDate || {}).sort();
  if (JSON.stringify(expectedDates) !== JSON.stringify([...dates].sort())) {
    throw new Error('Provider discovery dates differ from the policy window.');
  }
  const allowed = new Set(policy.competitionSeasons.map(item => `${item.league}:${item.season}`));
  const discoveredFixtures = [];
  const identities = new Set();
  let excludedFixtureCount = 0;
  for (const date of dates) {
    if (!Array.isArray(fixturesByDate[date])) throw new Error(`Provider discovery ${date} must be an array.`);
    for (const row of fixturesByDate[date]) {
      const fixture = canonicalFixture(row);
      if (!fixture || !allowed.has(`${fixture.league}:${fixture.season}`)) {
        excludedFixtureCount += 1;
        continue;
      }
      if (identities.has(fixture.fixtureId)) throw new Error(`Provider discovery duplicated ${fixture.fixtureId}.`);
      identities.add(fixture.fixtureId);
      discoveredFixtures.push(fixture);
    }
  }
  const fixturesById = new Map();
  for (const fixture of Object.values(state.fixtures)) {
    if (!allowed.has(`${fixture.league}:${fixture.season}`)) {
      throw new Error(`Automation state contains out-of-policy fixture ${fixture.fixtureId}.`);
    }
    fixturesById.set(fixture.fixtureId, { ...fixture, status: fixture.lastStatus });
  }
  for (const fixture of discoveredFixtures) {
    const retained = fixturesById.get(fixture.fixtureId);
    if (retained && (retained.providerFixtureId !== fixture.providerFixtureId
      || retained.league !== fixture.league
      || retained.season !== fixture.season
      || retained.kickoffUtc !== fixture.kickoffUtc)) {
      throw new Error(`Provider discovery changed retained identity for ${fixture.fixtureId}.`);
    }
    fixturesById.set(fixture.fixtureId, fixture);
  }
  const fixtures = [...fixturesById.values()];
  const nowMs = nowDate.getTime();
  const candidates = fixtures
    .map(fixture => ({ fixture, stage: nextDueStage(policy, state, fixture, nowMs) }))
    .filter(item => item.stage)
    .sort((left, right) => compareText(left.stage.dueAt, right.stage.dueAt)
      || compareText(left.fixture.kickoffUtc, right.fixture.kickoffUtc)
      || compareText(left.fixture.fixtureId, right.fixture.fixtureId));
  const discoveryRequestCount = dates.length + 1; // includes the quota-free status call
  const remaining = Number.isSafeInteger(quota.dailyRemaining) ? quota.dailyRemaining : null;
  const enabled = policy.scheduledSynchronizationEnabled || preview;
  if (enabled && remaining === null) {
    throw new Error('API-Football daily remaining quota is required before planning automated work.');
  }
  const dateUtc = nowDate.toISOString().slice(0, 10);
  if (dailyBudget && (dailyBudget.dateUtc !== dateUtc
    || !Array.isArray(dailyBudget.fixtureIds)
    || dailyBudget.fixtureIds.length > 240
    || dailyBudget.fixtureIds.some(id => !/^af:fixture:\d+$/.test(id))
    || new Set(dailyBudget.fixtureIds).size !== dailyBudget.fixtureIds.length)) {
    throw new Error('D1 daily fixture publication budget is invalid or stale.');
  }
  if (enabled && !preview && !dailyBudget) {
    throw new Error('D1 daily fixture publication budget is required for execution.');
  }
  const publishedToday = new Set(dailyBudget?.fixtureIds || []);
  const statePublishedToday = Object.values(state.fixtures)
    .filter(fixture => fixture.lastDetailFetchedAt?.slice(0, 10) === dateUtc);
  for (const fixture of statePublishedToday) publishedToday.add(fixture.fixtureId);
  let publishCapacity = Math.max(0, 20 - publishedToday.size);
  let requestCapacity = policy.limits.maxProviderRequestsPerRun - discoveryRequestCount;
  if (remaining !== null) requestCapacity = Math.min(
    requestCapacity,
    Math.max(0, remaining - policy.limits.dailyRequestReserve),
  );
  const detailFetches = [];
  for (const candidate of candidates) {
    if (detailFetches.length >= policy.limits.maxFinalDetailFixturesPerRun || requestCapacity < 5) break;
    if (state.fixtures[candidate.fixture.fixtureId]?.lastDetailFetchedAt?.slice(0, 10) === dateUtc) continue;
    const recoveryOnly = publishedToday.has(candidate.fixture.fixtureId);
    if (!recoveryOnly && publishCapacity === 0) continue;
    detailFetches.push({ ...candidate.fixture, recheckStage: candidate.stage.stage, dueAt: candidate.stage.dueAt });
    requestCapacity -= 5;
    if (!recoveryOnly) publishCapacity -= 1;
  }
  const competitionScopes = new Map(policy.competitionSeasons.map(item => [item.league, item]));
  const standingsFetches = [];
  for (const league of [...competitionScopes.keys()].sort((a, b) => a - b)) {
    if (standingsFetches.length >= policy.limits.maxStandingsPerRun || requestCapacity < 1) break;
    const scope = competitionScopes.get(league);
    const key = `af:competition:${league}/af:season:${league}:${scope.season}`;
    if (hoursSince(state.standings?.[key]?.lastFetchedAt, nowMs)
      < policy.limits.standingsMinimumIntervalHours) continue;
    standingsFetches.push({
      league, season: scope.season,
      competitionId: `af:competition:${league}`,
      seasonId: `af:season:${league}:${scope.season}`,
    });
    requestCapacity -= 1;
  }
  const activeDetails = enabled ? detailFetches : [];
  const activeStandings = enabled ? standingsFetches : [];
  const estimatedProviderRequests = discoveryRequestCount + activeDetails.length * 5 + activeStandings.length;
  return {
    schemaVersion: PLAN_VERSION,
    mode: policy.scheduledSynchronizationEnabled ? 'enabled' : preview ? 'preview' : 'disabled',
    generatedAt: nowDate.toISOString(),
    discoveryDates: dates,
    nextDiscoveryDate: dates.at(-1) < discoveryDates(policy, nowDate).at(-1)
      ? shiftDate(dates.at(-1), 1) : null,
    discoveredFixtureCount: discoveredFixtures.length,
    retainedFixtureCount: fixtures.length - discoveredFixtures.length,
    excludedFixtureCount,
    dueDetailFixtureCount: candidates.length,
    pendingFixtures: discoveredFixtures.filter(fixture => FINAL_STATUSES.has(fixture.status)),
    detailFetches: activeDetails,
    standingsFetches: activeStandings,
    quota: {
      dailyRemaining: remaining,
      reserve: policy.limits.dailyRequestReserve,
      estimatedProviderRequests,
      requestCapacityRemaining: Math.max(0, requestCapacity),
      fixturePublishesRemaining: publishCapacity,
    },
  };
}

function checkpointAutomationDiscovery(state, plan) {
  state = validateState(state);
  if (plan?.schemaVersion !== PLAN_VERSION || !Array.isArray(plan.pendingFixtures)) {
    throw new Error('Automation discovery checkpoint plan is invalid.');
  }
  const next = structuredClone(state);
  if (plan.nextDiscoveryDate !== null && !realDate(plan.nextDiscoveryDate)) {
    throw new Error('Automation discovery continuation date is invalid.');
  }
  next.pendingDiscoveryDate = plan.nextDiscoveryDate;
  for (const fixture of plan.pendingFixtures) {
    if (next.fixtures[fixture.fixtureId]) continue;
    if (!FINAL_STATUSES.has(fixture.status)
      || fixture.fixtureId !== `af:fixture:${fixture.providerFixtureId}`
      || fixture.competitionId !== `af:competition:${fixture.league}`
      || fixture.seasonId !== `af:season:${fixture.league}:${fixture.season}`
      || !Number.isFinite(Date.parse(fixture.kickoffUtc))) {
      throw new Error(`Discovered fixture has invalid checkpoint metadata: ${fixture.fixtureId}.`);
    }
    next.fixtures[fixture.fixtureId] = {
      providerFixtureId: fixture.providerFixtureId,
      fixtureId: fixture.fixtureId,
      competitionId: fixture.competitionId,
      seasonId: fixture.seasonId,
      league: fixture.league,
      season: fixture.season,
      kickoffUtc: fixture.kickoffUtc,
      lastStatus: fixture.status,
      completedStages: [],
      lastDetailFetchedAt: null,
    };
  }
  return validateState(next);
}

function advanceAutomationState(state, plan, completedAt) {
  state = validateState(state);
  if (plan?.schemaVersion !== PLAN_VERSION) throw new Error(`Automation plan schemaVersion must be ${PLAN_VERSION}.`);
  const timestamp = new Date(completedAt || Date.now()).toISOString();
  const next = structuredClone(state);
  for (const item of plan.detailFetches || []) {
    const prior = next.fixtures[item.fixtureId] || { completedStages: [] };
    next.fixtures[item.fixtureId] = {
      providerFixtureId: item.providerFixtureId,
      fixtureId: item.fixtureId,
      competitionId: item.competitionId,
      seasonId: item.seasonId,
      league: item.league,
      season: item.season,
      kickoffUtc: item.kickoffUtc,
      lastStatus: item.status,
      completedStages: [...new Set([...(prior.completedStages || []), item.recheckStage])],
      lastDetailFetchedAt: timestamp,
    };
  }
  for (const item of plan.standingsFetches || []) {
    const key = `${item.competitionId}/${item.seasonId}`;
    next.standings[key] = { lastFetchedAt: timestamp };
  }
  next.lastSuccessfulRunAt = timestamp;
  return validateState(next);
}

module.exports = {
  PLAN_VERSION,
  POLICY_VERSION,
  STATE_VERSION,
  advanceAutomationState,
  checkpointAutomationDiscovery,
  canonicalFixture,
  dateJst,
  discoveryDates,
  plannedDiscoveryDates,
  emptyAutomationState,
  planAutomation,
  shiftDate,
  startAutomationDiscovery,
  validatePolicy,
  validateState,
};
