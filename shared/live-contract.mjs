export const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','LIVE','INT','SUSP']);
export const CLOSED_STATUSES = new Set(['FT','AET','PEN','PST','CANC','ABD','AWD','WO']);
export const MINUTE = 60000;
export function jstDate(time) { return new Date(time + 9 * 3600000).toISOString().slice(0,10); }
export function allowedLeagues(env) {
  const ids = String(env.LIVE_COMPETITION_IDS || '').split(',').filter(Boolean).map(Number);
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('invalid_league_scope');
  return new Set(ids);
}
export function providerFixture(row, allowed) {
  const id=row?.fixture?.id, league=row?.league?.id, season=row?.league?.season;
  const kickoff=Date.parse(row?.fixture?.date);
  if (!allowed.has(league)) return null;
  if (![id,league,season,row?.teams?.home?.id,row?.teams?.away?.id].every(n => Number.isSafeInteger(n)&&n>0)
      || !Number.isFinite(kickoff) || typeof row?.fixture?.status?.short !== 'string') throw new Error('invalid_provider_fixture');
  const number = n => n === null || n === undefined ? null : (Number.isFinite(n) ? n : null);
  return { fixtureId:`af:fixture:${id}`, competitionId:`af:competition:${league}`, seasonId:`af:season:${league}:${season}`,
    kickoffUtc:new Date(kickoff).toISOString(), dateJst:jstDate(kickoff),
    status:{short:row.fixture.status.short,long:row.fixture.status.long||null,elapsed:number(row.fixture.status.elapsed)},
    home:{teamId:`af:team:${row.teams.home.id}`,name:row.teams.home.name||null,logo:row.teams.home.logo||null,score:number(row.goals?.home)},
    away:{teamId:`af:team:${row.teams.away.id}`,name:row.teams.away.name||null,logo:row.teams.away.logo||null,score:number(row.goals?.away)} };
}
export function isCandidate(row, now) {
  return (row.status==='NS' || LIVE_STATUSES.has(row.status)) && row.kickoff_ms>=now-6*3600000;
}
export function precheckStage(row, now) {
  if (!isCandidate(row,now) || LIVE_STATUSES.has(row.status)) return null;
  if (row.kickoff_ms>now+2*3600000) return null;
  if (!row.check_2h_ms) return '2h';
  if (row.kickoff_ms<=now+3600000 && !row.check_1h_ms) return '1h';
  return null;
}
export function liveEligible(row, now) {
  return Boolean(isCandidate(row,now) && row.kickoff_ms<=now+3600000
    && (LIVE_STATUSES.has(row.status) || (row.check_2h_ms && row.check_1h_ms)));
}
