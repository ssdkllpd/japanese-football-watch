(() => {
  'use strict';

  const FIELD_LABELS = {
    minutes:'出場時間', goals:'得点', assists:'アシスト', shots:'シュート', shotsOnTarget:'枠内シュート',
    keyPasses:'キーパス', dribbles:'ドリブル成功', bigChancesMissed:'決定機逸', duelsWon:'デュエル勝利',
    duelsTotal:'デュエル総数', duelWinRate:'デュエル勝率', passesCompleted:'パス成功', passesAttempted:'パス試行',
    passCompletionRate:'パス成功率', tackles:'タックル成功', interceptions:'インターセプト', clearances:'クリア',
    blocks:'ブロック', aerialDuelsWon:'空中戦勝利', aerialDuelsTotal:'空中戦総数', aerialWinRate:'空中戦勝率',
    dribbledPast:'被ドリブル', possessionsLost:'ボールロスト', gaOnPitch:'在場中失点', saves:'セーブ',
    shotsOnTargetFaced:'被枠内シュート', saveRate:'セーブ率', penaltiesSaved:'PKストップ', highClaims:'ハイボール処理成功',
    errorsLeadingToGoal:'失点直結ミス', yellowCards:'イエロー', secondYellowRed:'2枚目警告退場', straightRed:'一発レッド',
    penaltiesConceded:'PK献上', ownGoals:'オウンゴール'
  };
  const RATE_FIELDS = new Set(['duelWinRate','passCompletionRate','aerialWinRate','saveRate']);
  let activeMatchRef = null;

  function esc(v){ return typeof E === 'function' ? E(v) : String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
  function currentData(){ try { return D || {}; } catch { return {}; } }
  function matchKey(m){ try { return key(m); } catch { return [m?.league,m?.ko,m?.match].join('|'); } }
  function matchRef(m){ return String(m?.matchId || matchKey(m)); }
  function allMatches(){ const d=currentData(); return [...(d.matches||[]), ...(d.topMatches||[])]; }
  function sameMatch(a,b){
    if(!a||!b) return false;
    if(a.matchId && b.matchId) return String(a.matchId)===String(b.matchId);
    return String(a.league||'')===String(b.league||'') && String(a.ko||'')===String(b.ko||'') && String(a.match||'')===String(b.match||'');
  }
  function canonicalMatch(m){
    const d=currentData();
    const base=(d.matches||[]).find(x=>sameMatch(x,m));
    const top=(d.topMatches||[]).find(x=>sameMatch(x,m));
    if(base && top) return {...top,...base,reason:top.reason||base.reason||base.note};
    return base || top || m;
  }
  function matchByRef(ref){
    if(!ref) return null;
    const found=allMatches().find(m=>matchRef(m)===String(ref));
    return found ? canonicalMatch(found) : null;
  }
  function recordMatches(r,m){
    if(!r||!m) return false;
    if(r.matchId && m.matchId) return String(r.matchId)===String(m.matchId);
    if(r.match && String(r.match)===String(m.match)) {
      if(!r.league || !m.league || String(r.league)===String(m.league)) return true;
    }
    return !!r.ko && String(r.ko)===String(m.ko) && (!r.league || !m.league || String(r.league)===String(m.league));
  }
  function recordsForMatch(m){
    const d=currentData();
    return (d.playerMatchStats||[]).filter(r=>recordMatches(r,m)).map(r=>window.JFWRating?window.JFWRating.withComputedRating(r):r);
  }
  function trackedPlayersFromMatch(m,recs){
    const d=currentData(), names=new Set();
    for(const r of recs){ const n=r.playerName||r.player; if(n) names.add(n); }
    const text=String(m.players||'');
    for(const p of d.players||[]) if(text.includes(p.name)) names.add(p.name);
    return [...names];
  }
  function sourceCount(recs,m){
    const ids=new Set();
    for(const s of m.ratingSources||[]) ids.add(s.url||s.id||s.name);
    for(const r of recs) for(const s of r.ratingSources||[]) ids.add(s.url||s.id||s.name);
    return ids.size;
  }
  function sourceHtml(s){
    const url=/^https?:\/\//i.test(String(s?.url||''))?String(s.url):'';
    const name=esc(s?.name||s?.type||s?.id||'出典');
    const stamp=s?.retrievedAt?`<span class="mdSourceTime">${esc(s.retrievedAt)}</span>`:'';
    return `<div class="mdSource">${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${name}</a>`:`<span>${name}</span>`}${stamp}</div>`;
  }
  function stateHtml(key,input){
    if(!input || !input.state) return '<span class="mdMissing">未登録</span>';
    if(input.state==='missing') return '<span class="mdMissing">未取得</span>';
    if(input.state==='notApplicable') return '<span class="mdNA">対象外</span>';
    let v=input.value;
    if(RATE_FIELDS.has(key) && Number.isFinite(Number(v))) v=`${Math.round(Number(v)*100)}%`;
    return `<b>${esc(v)}</b>${input.sourceId?`<span class="mdSourceId">${esc(input.sourceId)}</span>`:''}`;
  }
  function inputGrid(inputs){
    const entries=Object.entries(inputs||{});
    if(!entries.length) return '<div class="empty">Rating入力データはまだありません。</div>';
    return `<div class="mdStatGrid">${entries.map(([k,v])=>`<div class="mdStat"><span>${esc(FIELD_LABELS[k]||k)}</span><div>${stateHtml(k,v)}</div></div>`).join('')}</div>`;
  }
  function breakdownHtml(r){
    const rows=r.ratingBreakdown||[];
    if(!rows.length) return '';
    return `<div class="mdBreakdown"><b>Rating内訳</b>${rows.map(x=>`<div><span>${esc(FIELD_LABELS[x.key]||x.key)} ${esc(x.value)}</span><strong class="${Number(x.points)>=0?'ok':'no'}">${Number(x.points)>=0?'+':''}${Number(x.points).toFixed(2)}</strong></div>`).join('')}</div>`;
  }
  function playerRecordHtml(r){
    const d=currentData();
    const player=(d.players||[]).find(p=>String(p.playerId||p.name)===String(r.playerId||r.player||r.playerName)||p.name===r.player||p.name===r.playerName);
    const name=r.playerName||r.player||player?.name||'選手';
    const rating=Number.isFinite(Number(r.jfwRating))?Number(r.jfwRating):null;
    const reason=rating==null?(r.reason==='discipline_inputs_missing'?'規律データ未取得':r.reason==='minimum_inputs_missing'?'最低算出条件未達':r.reason==='unknown_position'?'評価ポジション未確定':'未算出'):'';
    const cov=r.ratingCoverage==null?'—':`${Math.round(Number(r.ratingCoverage)*100)}%`;
    const sources=r.ratingSources||[];
    const conflicts=r.ratingConflicts||[];
    return `<div class="card mdPlayerCard">
      <div class="mdPlayerHead">
        <div>
          <div class="name ${player?'entityLink':''}" ${player?`data-open-player="${esc(player.playerId||player.name)}"`:''}>${esc(name)}</div>
          <div class="sub">${esc(r.club||player?.club||'')} ${r.ratingPosition?`・ Rating ${esc(r.ratingPosition)}`:''}${r.ratingPositionSource?` ・ ${esc(r.ratingPositionSource)}`:''}</div>
        </div>
        <div class="mdRating"><span>JFW</span><b>${rating==null?'—':rating.toFixed(1)}</b><small>${rating==null?esc(reason):`充足率 ${esc(cov)}`}</small></div>
      </div>
      ${r.gaOnPitchAmbiguous?'<span class="pill part">在場中失点の時系列に曖昧さあり</span>':''}
      ${conflicts.length?`<span class="pill part">データ競合 ${conflicts.length}件</span>`:''}
      <div class="mdBlockTitle">試合スタッツ</div>
      ${inputGrid(r.ratingInputs)}
      ${breakdownHtml(r)}
      <div class="mdBlockTitle">出典</div>
      ${sources.length?sources.map(sourceHtml).join(''):'<div class="muted">この個人記録には出典情報がまだ登録されていません。</div>'}
    </div>`;
  }
  function relatedClubButtons(m){
    const d=currentData();
    const clubs=[...new Set((d.players||[]).map(p=>p.club).filter(c=>c && String(m.match||'').includes(c)))];
    return clubs.map(c=>`<button class="linkbtn" data-open-club="${esc(c)}">${esc(c)}画面</button>`).join('');
  }
  function renderMatchDetail(){
    const root=document.getElementById('matchDetail');
    if(!root) return;
    const m=matchByRef(activeMatchRef);
    if(!m){ root.innerHTML='<section><div class="empty">このシーズンに該当試合のデータがありません。</div></section>'; return; }
    const recs=recordsForMatch(m), names=trackedPlayersFromMatch(m,recs), rated=recs.filter(r=>Number.isFinite(Number(r.jfwRating))).length, sources=sourceCount(recs,m), status=typeof st==='function'?st(m.status):['',''];
    const ko=String(m.ko||'');
    root.innerHTML=`
      <section>
        <div class="backRow"><button class="linkbtn" data-md-back>← 一覧へ戻る</button></div>
        <div class="detailHead"><div><div class="crumb">${esc(m.league||'')} / ${esc(m.round||'節数未取得')}</div><div class="detailTitle">${esc(m.match||'試合')}</div><div class="sub">${esc(ko.slice(0,10).replaceAll('-','/'))}${ko.slice(11)?` ・ ${esc(ko.slice(11))} JST`:''}</div></div><div class="mdClubLinks">${relatedClubButtons(m)}</div></div>
      </section>
      <section>
        <h2>試合サマリー</h2>
        <div class="card">
          <span class="pill ${status[1]||''}">${esc(status[0]||m.status||'')}</span>${typeof isWatched==='function'?(isWatched(m)?'<span class="pill ok">視聴済み</span>':'<span class="pill">未視聴</span>'):''}
          <div class="reason"><b>${esc(m.players||names.join(' / ')||'日本人選手情報未取得')}</b><br>${esc(m.appearance||'')}<br>${esc(m.reason||m.note||'')}</div>
          <div class="sub">視聴: ${esc(m.watch||'確認中')}</div>
          <button class="watchbtn ${typeof isWatched==='function'&&isWatched(m)?'done':''}" data-k="${esc(matchKey(m))}">${typeof isWatched==='function'&&isWatched(m)?'✓ 視聴済み（戻す）':'視聴済みにする'}</button>
        </div>
        <div class="detailKpis mdKpis">
          <div class="sum"><div class="miniN">${names.length||'—'}</div><div class="muted">日本人選手</div></div>
          <div class="sum"><div class="miniN">${recs.length}</div><div class="muted">詳細記録</div></div>
          <div class="sum"><div class="miniN">${rated}</div><div class="muted">Rating算出</div></div>
          <div class="sum"><div class="miniN">${sources}</div><div class="muted">登録出典</div></div>
        </div>
      </section>
      <section>
        <h2>日本人選手別データ</h2>
        <div class="lead">試合ごとの生スタッツ、取得/未取得状態、JFW Rating内訳、出典を確認できます。</div>
        ${recs.length?recs.map(playerRecordHtml).join(''):`<div class="card"><div class="name">詳細個人データはまだ未取得</div><div class="reason">この試合は試合ログとしては確認済みですが、<code>playerMatchStats</code> がまだ登録されていません。今後の取得で追加された項目から順にここへ表示します。未取得値を0として補完することはありません。</div></div>`}
      </section>`;
    const back=root.querySelector('[data-md-back]'); if(back) back.onclick=()=>{ activeMatchRef=null; clearDetailParams(); showPage(lastPage); };
    try { bindEntities(root); } catch {}
    try { bindWatch(root,currentData().matches||[]); } catch {}
  }
  function showMatchPage(opts={}){
    page='match';
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('v-match')?.classList.add('active');
    try { nav(); } catch {}
    if(opts.scroll!==false) window.scrollTo({top:0,behavior:'smooth'});
  }
  function openMatch(ref,{push=true,scroll=true}={}){
    const m=matchByRef(ref); if(!m) return false;
    activeMatchRef=matchRef(m);
    try { activePlayer=null; activeClub=null; } catch {}
    if(push){
      const u=new URL(location.href); u.searchParams.set('season',selectedSeason); u.searchParams.delete('player'); u.searchParams.delete('club'); u.searchParams.set('match',activeMatchRef); history.pushState(null,'',u.pathname+u.search+u.hash);
    }
    try { R.searchBox.value=''; clearSuggestions(); } catch {}
    renderMatchDetail(); showMatchPage({scroll}); return true;
  }

  function installDom(){
    if(!document.getElementById('v-match')){
      const view=document.createElement('div'); view.id='v-match'; view.className='view'; view.innerHTML='<div id="matchDetail"></div>';
      document.querySelector('main')?.appendChild(view);
    }
    if(!document.getElementById('match-detail-style')){
      const style=document.createElement('style'); style.id='match-detail-style'; style.textContent=`
        .matchdetailbtn{margin-top:8px;width:100%;border:1px solid #36506f;background:#12213a;color:var(--t);border-radius:10px;padding:9px;font-size:12px;font-weight:800;cursor:pointer}
        .matchdetailbtn:hover{border-color:var(--a)}.mdKpis{margin-top:10px}.mdClubLinks{display:flex;gap:7px;flex-wrap:wrap}.mdPlayerCard{overflow:hidden}.mdPlayerHead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.mdRating{text-align:right;min-width:76px}.mdRating span,.mdRating small{display:block;color:var(--m);font-size:10px}.mdRating b{display:block;color:var(--a);font-size:30px;line-height:1}.mdBlockTitle{font-size:12px;font-weight:850;margin:14px 0 7px;color:#cbd5e1}.mdStatGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.mdStat{background:var(--p2);border:1px solid var(--l);border-radius:9px;padding:8px;min-width:0}.mdStat>span{display:block;color:var(--m);font-size:10px;margin-bottom:3px}.mdStat>div{font-size:12px;word-break:break-word}.mdMissing{color:var(--y)}.mdNA{color:var(--m)}.mdSourceId{color:var(--m);font-size:9px;margin-left:5px}.mdBreakdown{margin-top:12px;border-top:1px solid var(--l);padding-top:9px}.mdBreakdown>div{display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:3px 0}.mdSource{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid #ffffff0d;font-size:11px}.mdSource a{color:#93c5fd}.mdSourceTime{color:var(--m);font-size:9px;text-align:right}@media(min-width:720px){.mdStatGrid{grid-template-columns:repeat(4,minmax(0,1fr))}}
      `; document.head.appendChild(style);
    }
  }
  function installRouting(){
    const baseSet=setDetailParams;
    setDetailParams=function(type,value){
      const u=new URL(location.href); u.searchParams.set('season',selectedSeason); ['player','club','match'].forEach(k=>u.searchParams.delete(k)); if(value)u.searchParams.set(type,value); history.pushState(null,'',u.pathname+u.search+u.hash);
    };
    clearDetailParams=function(replace=false){
      activeMatchRef=null; const u=new URL(location.href); ['player','club','match'].forEach(k=>u.searchParams.delete(k)); (replace?history.replaceState:history.pushState).call(history,null,'',u.pathname+u.search+u.hash);
    };
    const baseShow=showPage;
    showPage=function(p,opts={}){ if(p==='match'){ showMatchPage(opts); return; } return baseShow(p,opts); };
    const baseLoad=loadSeason;
    loadSeason=async function(id,opts={}){
      const wanted=new URL(location.href).searchParams.get('match');
      await baseLoad(id,opts);
      if(wanted){ if(!openMatch(wanted,{push:false,scroll:false})){ const u=new URL(location.href);u.searchParams.delete('match');history.replaceState(null,'',u.pathname+u.search+u.hash); } }
    };
    const baseToggle=toggle;
    toggle=function(m){ baseToggle(m); if(page==='match') renderMatchDetail(); };
    void baseSet;
  }
  function installCards(){
    const baseMcard=mcard;
    mcard=function(m,r=null){
      const cm=canonicalMatch(m), ref=matchRef(cm); let html=baseMcard(m,r);
      html=html.replace(/^<div class="card([^\"]*)"/,(_,rest)=>`<div class="card clickable${rest}" data-open-match="${esc(ref)}"`);
      html=html.replace(/<button class="watchbtn/,`<button class="matchdetailbtn" type="button" data-open-match-btn="${esc(ref)}">試合詳細を見る</button><button class="watchbtn`);
      return html;
    };
    if(typeof playerRecordCard==='function'){
      const basePlayerRecord=playerRecordCard;
      playerRecordCard=function(r){
        let html=basePlayerRecord(r), m=(currentData().matches||[]).find(x=>recordMatches(r,x));
        if(!m) return html; const ref=matchRef(m);
        return html.replace(/^<div class="card"/,`<div class="card clickable" data-open-match="${esc(ref)}"`);
      };
    }
  }
  function installEvents(){
    document.addEventListener('click',e=>{
      const btn=e.target.closest('[data-open-match-btn]');
      if(btn){ e.preventDefault(); e.stopPropagation(); openMatch(btn.dataset.openMatchBtn); return; }
      const card=e.target.closest('[data-open-match]');
      if(!card || e.target.closest('[data-k],[data-open-player],[data-open-club],a,button')) return;
      openMatch(card.dataset.openMatch);
    });
    window.addEventListener('popstate',()=>{
      const ref=new URL(location.href).searchParams.get('match');
      if(ref) setTimeout(()=>openMatch(ref,{push:false,scroll:false}),0);
    });
  }
  function start(){
    try {
      installDom(); installRouting(); installCards(); installEvents();
      try { renderAll(); if(page==='player') renderPlayerDetail(); if(page==='club') renderClubDetail(); } catch {}
      const ref=new URL(location.href).searchParams.get('match'); if(ref) openMatch(ref,{push:false,scroll:false});
      window.openMatchDetail=openMatch;
    } catch(err){ console.error('match-detail init failed',err); }
  }

  start();
})();
