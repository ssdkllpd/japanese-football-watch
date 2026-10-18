import fixtureContract from '../scripts/v2/fixture-contract.js';
import {providerFixture} from './live-contract.mjs';

const {normalizeFixtureBundle} = fixtureContract;
export const DETAIL_SECTIONS = Object.freeze({lineups:'lineups',events:'events',statistics:'teamStats',players:'playerStats'});

export function providerDetail(raw, allowed, now) {
  const summary = providerFixture(raw, allowed);
  if (!summary) return null;
  for (const key of Object.keys(DETAIL_SECTIONS)) {
    if (Object.hasOwn(raw,key) && !Array.isArray(raw[key])) throw new Error('invalid_live_detail_section');
  }
  const teams = new Set([raw.teams.home.id,raw.teams.away.id]);
  for (const key of ['lineups','statistics','players']) {
    if ((raw[key] || []).some(row => !teams.has(row?.team?.id))) throw new Error('live_detail_team_mismatch');
  }
  if ((raw.events || []).some(row => row?.team?.id != null && !teams.has(row.team.id))) throw new Error('live_detail_team_mismatch');
  const bundle = normalizeFixtureBundle(raw,{fetchedAt:new Date(now).toISOString(),finalized:false});
  bundle.fixture.provenance.issues.push('live_provisional');
  if (JSON.stringify(bundle).length>750000) throw new Error('live_detail_payload_limit');
  return bundle;
}
