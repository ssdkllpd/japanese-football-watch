import config from '../config/cup-competitions.json' with {type:'json'};
import {assertValidDateIndexPayload,compareDateIndexFixtures} from './date-index-contract.mjs';
import {assertValidStandingsPayload} from './standings-contract.mjs';
export const CUP_CATALOG_KEY='football/v2/cups/catalog.json';
export const CUP_COMPETITIONS=config.competitions;
export const cupConfig=id=>CUP_COMPETITIONS.find(c=>c.id===id);
export const cupSnapshotKey=hash=>`football/v2/cups/snapshots/${hash}.json`;
export function assertCupSnapshot(value,expectedId,expectedSeason) {
  if(value?.schemaVersion!=='jfw-cup-public-snapshot/1'||!cupConfig(expectedId)
    ||value.competition?.id!==expectedId||value.season?.id!==expectedSeason
    ||expectedSeason!==`af:season:${cupConfig(expectedId).providerId}:${config.providerSeason}`
    ||value.competition.providerId!==cupConfig(expectedId).providerId
    ||!Array.isArray(value.fixtures)||value.fixtures.length>2000
    ||!Number.isFinite(Date.parse(value.generatedAt)))throw new Error('Cup snapshot identity is invalid');
  const dates=new Map(),ids=new Set();
  for(const fixture of value.fixtures){
    if(ids.has(fixture.fixtureId)||fixture.seasonId!==expectedSeason
      ||fixture.round!==null&&typeof fixture.round!=='string')throw new Error('Cup fixture identity is invalid');
    ids.add(fixture.fixtureId);
    const {round,...index}=fixture;
    if(!dates.has(index.dateJst))dates.set(index.dateJst,[]);
    dates.get(index.dateJst).push(index);
  }
  for(const [date,fixtures]of dates)assertValidDateIndexPayload({contractVersion:'2.0.0',timeZone:'Asia/Tokyo',
    date,competition:value.competition,fixtures:fixtures.sort(compareDateIndexFixtures),generatedAt:value.generatedAt},
    {expectedDate:date,expectedCompetitionId:expectedId});
  if(value.standings!==null)assertValidStandingsPayload(value.standings,{expectedCompetitionId:expectedId,expectedSeasonId:expectedSeason});
  return value;
}
export function cupDirectoryEntry(value) {
  const teams=new Set(value.fixtures.flatMap(f=>[f.teams.home.id,f.teams.away.id]));
  return {...value.competition,category:cupConfig(value.competition.id).category,
    seasons:[{...value.season,summary:{teamCount:teams.size,fixtureCount:value.fixtures.length,
      completedFixtureCount:value.fixtures.filter(f=>['FT','AET','PEN'].includes(f.status.short)).length,
      publishedDetailCount:0,standingsUpdatedAt:value.standings?.generatedAt??null,detailUpdatedAt:null}}]};
}
