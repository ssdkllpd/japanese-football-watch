(() => {
  'use strict';
  const DISC = ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals'];
  const AGG_FIELDS = ['apps','starts','minutes','goals','assists','cleanSheets','yellowCards'];
  const NON_OFFICIAL_RE = /friendly|pre[- ]?season|親善|プレシーズン/i;
  let loading = null;

  async function getJson(path){const sep=path.includes('?')?'&':'?';const r=await fetch(path+sep+'v='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error(`${path} ${r.status}`);return r.json();}
  function matchKeyOf(m){return[m?.league,m?.ko,m?.match].join('|')}
  function cleanMatchUpdate(u){const{matchKey,addIfMissing,addToTopMatches,...rest}=u||{};return rest}
  function matchFinder(list,u){return list.find(x=>(u.matchId&&x.matchId===u.matchId)||(u.matchKey&&matchKeyOf(x)===u.matchKey))}
  function mergeMatchUpdates(rows){D.matches=D.matches||[];D.topMatches=D.topMatches||[];for(const u of rows||[]){const clean=cleanMatchUpdate(u);let m=matchFinder(D.matches,u);if(m)Object.assign(m,clean);else if(u.addIfMissing!==false)D.matches.push({...clean});let top=matchFinder(D.topMatches,u);if(top)Object.assign(top,clean);else if(u.addToTopMatches)D.topMatches.push({...clean})}}
  function mergePlayerUpdates(rows){D.players=D.players||[];for(const u of rows||[]){let p=D.players.find(x=>(u.playerId&&x.playerId===u.playerId)||x.name===u.name);if(!p){const stats={...(u.stats||{})};D.players.push({...u,stats});continue}const stats={...(p.stats||{}),...(u.stats||{})};Object.assign(p,u,{stats})}}
  function normalizeRecord(r,sources){const out={...r},sourceIds=r.sourceIds||[],defaultSource=sourceIds[0];out.ratingSources=sourceIds.map(id=>sources[id]).filter(Boolean);const inputs={};for(const[field,value]of Object.entries(r.values||{}))inputs[field]={state:'value',value,sourceId:(r.fieldSources||{})[field]||defaultSource};if(r.disciplineClean)for(const field of DISC)if(!inputs[field])inputs[field]={state:'value',value:0,sourceId:defaultSource};for(const field of r.missingFields||[])if(!inputs[field])inputs[field]={state:'missing'};out.ratingInputs=inputs;for(const field of['minutes','goals','assists'])if(inputs[field]?.state==='value')out[field]=inputs[field].value;delete out.values;delete out.sourceIds;delete out.fieldSources;delete out.disciplineClean;return out}
  function ratingInputsSignature(record){try{return JSON.stringify(record?.ratingInputs||{})}catch{return''}}
  function clearCachedRating(record){const out={...record};for(const key of['jfwRating','ratingVersion','ratingCoverage','ratingBreakdown','ratingStatus','ratingReason','ratingOpsVersion'])delete out[key];return out}
  function upsertPlayerMatchStats(rows,sources){D.playerMatchStats=D.playerMatchStats||[];for(const raw of rows||[]){const r=normalizeRecord(raw,sources),i=D.playerMatchStats.findIndex(x=>(r.recordId&&x.recordId===r.recordId)||(x.matchId===r.matchId&&(x.playerId||x.player||x.playerName)===(r.playerId||r.player||r.playerName)));if(i>=0){const prev=D.playerMatchStats[i],merged={...prev,...r};D.playerMatchStats[i]=ratingInputsSignature(prev)!==ratingInputsSignature(merged)?clearCachedRating(merged):merged}else D.playerMatchStats.push(r)}}
  function mergeGA(rows){D.gaResults=D.gaResults||[];for(const x of rows||[]){const i=D.gaResults.findIndex(y=>(x.matchId&&y.matchId===x.matchId&&y.player===x.player)||(y.player===x.player&&y.ko===x.ko&&y.match===x.match));if(i<0)D.gaResults.push(x);else D.gaResults[i]={...D.gaResults[i],...x}}}
  function removeGA(rows){if(!rows?.length||!D.gaResults)return;D.gaResults=D.gaResults.filter(y=>!(rows||[]).some(x=>(x.matchId&&y.matchId===x.matchId&&(!x.player||y.player===x.player))||(!x.matchId&&x.player===y.player&&x.ko===y.ko&&(!x.match||x.match===y.match))))}
  function valueOfRecord(r,field){if(r?.ratingInputs?.[field]?.state==='value')return Number(r.ratingInputs[field].value);if(r?.[field]!==undefined&&r?.[field]!==null&&Number.isFinite(Number(r[field])))return Number(r[field]);return null}
  function recordPlayerName(r){return r?.playerName||r?.player||r?.name||null}
  function matchForRecord(r){return(D.matches||[]).find(m=>(r.matchId&&m.matchId===r.matchId)||(r.match&&r.ko&&m.match===r.match&&m.ko===r.ko))}
  function isOfficialNonLeagueRecord(r,p){const m=matchForRecord(r),competition=String(r.competition||r.league||m?.league||'');if(!competition||NON_OFFICIAL_RE.test(competition)||NON_OFFICIAL_RE.test(String(m?.round||'')))return false;return competition!==String(p.league||'')}
  function rebuildPlayerSeasonAggregates(){
    D.players=D.players||[];const records=D.playerMatchStats||[];
    for(const p of D.players){
      if(!p._leagueStats)p._leagueStats={...(p.stats||{})};
      const leagueStats={...p._leagueStats},extra={apps:0,starts:0,minutes:0,goals:0,assists:0,cleanSheets:0,yellowCards:0},coverage={apps:true,starts:true,minutes:true,goals:true,assists:true,cleanSheets:true,yellowCards:true};
      const mine=records.filter(r=>recordPlayerName(r)===p.name&&isOfficialNonLeagueRecord(r,p));
      for(const r of mine){
        if(r.appearance===true)extra.apps+=1;else if(r.appearance==null)coverage.apps=false;
        if(r.start===true)extra.starts+=1;else if(r.start==null)coverage.starts=false;
        for(const field of['minutes','goals','assists','cleanSheets','yellowCards']){const v=valueOfRecord(r,field);if(v==null){coverage[field]=false;continue}extra[field]+=v}
      }
      const all={...leagueStats};
      for(const field of AGG_FIELDS){const base=Number(leagueStats[field]),hasBase=Number.isFinite(base);if(mine.length&&!coverage[field])all[field]=null;else if(hasBase)all[field]=base+(extra[field]||0);else if(extra[field]!==0||coverage[field])all[field]=extra[field]||0}
      p.leagueStats=leagueStats;p.allCompetitionsStats=all;p.competitionStats={};if(p.league)p.competitionStats[p.league]=leagueStats;
      for(const r of mine){const m=matchForRecord(r),competition=String(r.competition||r.league||m?.league||'その他公式戦'),s=p.competitionStats[competition]||{};if(r.appearance===true)s.apps=(Number(s.apps)||0)+1;else if(r.appearance==null)s.apps=null;if(r.start===true)s.starts=(Number(s.starts)||0)+1;else if(r.start==null)s.starts=null;for(const field of['minutes','goals','assists','cleanSheets','yellowCards']){const v=valueOfRecord(r,field);if(v!=null&&s[field]!==null)s[field]=(Number(s[field])||0)+v;else if(v==null)s[field]=null}p.competitionStats[competition]=s}
      p.stats=all;p.statsScope='all_official_competitions';if(mine.length)p.statsAsOf=`${p.statsAsOf||selectedSeason} / 全公式戦集計`;
    }
  }
  function applyFragments(parts){const sources={};for(const p of parts)Object.assign(sources,p.sources||{});for(const p of parts){mergeMatchUpdates(p.matchUpdates);mergePlayerUpdates(p.playerUpdates);upsertPlayerMatchStats(p.playerMatchStats,sources);mergeGA(p.gaResultsAdd);removeGA(p.gaResultsRemove)}rebuildPlayerSeasonAggregates();const newest=parts.map(x=>x.updated).filter(Boolean).sort().at(-1);if(newest)D.updated=newest;D._playerMatchBackfill={season:selectedSeason,updated:newest,fragments:parts.length,records:(D.playerMatchStats||[]).length}}
  async function applyCurrentBackfill(){const season=String(selectedSeason||'');if(!season)return false;try{const base=`data/${encodeURIComponent(season)}/backfill/`,manifest=await getJson(base+'index.json'),parts=await Promise.all((manifest.fragments||[]).map(f=>getJson(base+f)));applyFragments(parts);try{R.updated.textContent=`${season} ・ 最終更新: ${D.updated||'未取得'}`}catch{}return true}catch(e){if(!String(e).includes('404'))console.warn('player match backfill load failed',e);return false}}
  async function refreshViews(){try{renderAll()}catch{}try{if(page==='player')renderPlayerDetail();if(page==='club')renderClubDetail()}catch{}try{if(page==='match'&&window.renderMatchDetail)window.renderMatchDetail()}catch{}}
  async function boot(){if(loading)return loading;loading=(async()=>{await applyCurrentBackfill();await refreshViews()})();await loading;loading=null}
  const baseLoad=loadSeason;loadSeason=async function(id,opts={}){await baseLoad(id,opts);await applyCurrentBackfill();await refreshViews()};
  window.JFWBackfill={applyCurrentBackfill,boot,rebuildPlayerSeasonAggregates};
  boot().finally(()=>{if(document.querySelector('script[data-jfw-match-detail]'))return;const s=document.createElement('script');s.src=`match-detail.js?v=${Date.now()}`;s.dataset.jfwMatchDetail='1';document.body.appendChild(s)});
})();