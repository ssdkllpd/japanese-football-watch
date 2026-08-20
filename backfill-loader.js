(() => {
  'use strict';
  const DISC = ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals'];
  let loading = null;

  async function getJson(path){
    const sep=path.includes('?')?'&':'?';
    const r=await fetch(path+sep+'v='+Date.now(),{cache:'no-store'});
    if(!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }
  function matchKeyOf(m){ return [m?.league,m?.ko,m?.match].join('|'); }
  function mergeMatchUpdates(rows){
    for(const u of rows||[]){
      for(const list of [D.matches||[],D.topMatches||[]]){
        const m=list.find(x=>(u.matchId&&x.matchId===u.matchId)||matchKeyOf(x)===u.matchKey);
        if(m) Object.assign(m,u);
      }
    }
  }
  function mergePlayerUpdates(rows){
    for(const u of rows||[]){
      const p=(D.players||[]).find(x=>(u.playerId&&x.playerId===u.playerId)||x.name===u.name);
      if(!p) continue;
      const stats={...(p.stats||{}),...(u.stats||{})};
      Object.assign(p,u,{stats});
    }
  }
  function normalizeRecord(r,sources){
    const out={...r};
    const sourceIds=r.sourceIds||[];
    const defaultSource=sourceIds[0];
    out.ratingSources=sourceIds.map(id=>sources[id]).filter(Boolean);
    const inputs={};
    for(const [field,value] of Object.entries(r.values||{})){
      inputs[field]={state:'value',value,sourceId:(r.fieldSources||{})[field]||defaultSource};
    }
    if(r.disciplineClean){
      for(const field of DISC) if(!inputs[field]) inputs[field]={state:'value',value:0,sourceId:defaultSource};
    }
    for(const field of r.missingFields||[]) if(!inputs[field]) inputs[field]={state:'missing'};
    out.ratingInputs=inputs;
    for(const field of ['minutes','goals','assists']) if(inputs[field]?.state==='value') out[field]=inputs[field].value;
    delete out.values; delete out.sourceIds; delete out.fieldSources; delete out.disciplineClean;
    return out;
  }
  function upsertPlayerMatchStats(rows,sources){
    D.playerMatchStats=D.playerMatchStats||[];
    for(const raw of rows||[]){
      const r=normalizeRecord(raw,sources);
      const i=D.playerMatchStats.findIndex(x=>(r.recordId&&x.recordId===r.recordId)||(x.matchId===r.matchId&&(x.playerId||x.player||x.playerName)===(r.playerId||r.player||r.playerName)));
      if(i>=0) D.playerMatchStats[i]={...D.playerMatchStats[i],...r}; else D.playerMatchStats.push(r);
    }
  }
  function mergeGA(rows){
    D.gaResults=D.gaResults||[];
    for(const x of rows||[]){
      const exists=D.gaResults.some(y=>(x.matchId&&y.matchId===x.matchId&&y.player===x.player)||(y.player===x.player&&y.ko===x.ko&&y.match===x.match));
      if(!exists) D.gaResults.push(x);
    }
  }
  function applyFragments(parts){
    const sources={};
    for(const p of parts) Object.assign(sources,p.sources||{});
    for(const p of parts){
      mergeMatchUpdates(p.matchUpdates);
      mergePlayerUpdates(p.playerUpdates);
      upsertPlayerMatchStats(p.playerMatchStats,sources);
      mergeGA(p.gaResultsAdd);
    }
    const newest=parts.map(x=>x.updated).filter(Boolean).sort().at(-1);
    if(newest) D.updated=newest;
    D._playerMatchBackfill={season:selectedSeason,updated:newest,fragments:parts.length,records:(D.playerMatchStats||[]).length};
  }
  async function applyCurrentBackfill(){
    const season=String(selectedSeason||'');
    if(!season) return false;
    try{
      const base=`data/${encodeURIComponent(season)}/backfill/`;
      const manifest=await getJson(base+'index.json');
      const parts=await Promise.all((manifest.fragments||[]).map(f=>getJson(base+f)));
      applyFragments(parts);
      try{ R.updated.textContent=`${season} ・ 最終更新: ${D.updated||'未取得'}`; }catch{}
      return true;
    }catch(e){
      if(!String(e).includes('404')) console.warn('player match backfill load failed',e);
      return false;
    }
  }
  async function refreshViews(){
    try{ renderAll(); }catch{}
    try{ if(page==='player') renderPlayerDetail(); if(page==='club') renderClubDetail(); }catch{}
    try{ if(page==='match'&&window.renderMatchDetail) window.renderMatchDetail(); }catch{}
  }
  async function boot(){
    if(loading) return loading;
    loading=(async()=>{ await applyCurrentBackfill(); await refreshViews(); })();
    await loading; loading=null;
  }
  const baseLoad=loadSeason;
  loadSeason=async function(id,opts={}){
    await baseLoad(id,opts);
    await applyCurrentBackfill();
    await refreshViews();
  };
  window.JFWBackfill={applyCurrentBackfill,boot};
  boot().finally(()=>{
    if(document.querySelector('script[data-jfw-match-detail]')) return;
    const s=document.createElement('script');
    s.src=`match-detail.js?v=${Date.now()}`;
    s.dataset.jfwMatchDetail='1';
    document.body.appendChild(s);
  });
})();