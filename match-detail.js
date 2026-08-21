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
  let formationRatingMode = 'apiFootball';

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
  function providerRatingOf(r){
    const value=r?.providerRatings?.apiFootball?.value ?? r?.apiFootballRating;
    if(value===null||value===undefined||value==='') return null;
    const parsed=Number(value); return Number.isFinite(parsed)?parsed:null;
  }
  function validJfwRating(value){
    if(window.JFWRating?.isRatingValue) return window.JFWRating.isRatingValue(value);
    const parsed=Number(value); return value!==null&&value!==undefined&&value!==''&&Number.isFinite(parsed)&&parsed>=3&&parsed<=10;
  }
  function individualRatingsHtml(r,reason,cov){
    const apiRating=providerRatingOf(r);
    const jfwRating=validJfwRating(r.jfwRating)?Number(r.jfwRating):null;
    return `<div class="mdRatingCompare" aria-label="選手評価の比較">
      <div class="mdRating mdRatingApi"><span>API-Football</span><b>${apiRating==null?'—':apiRating.toFixed(1)}</b><small>${apiRating==null?'未取得':'試合評価'}</small></div>
      <div class="mdRating mdRatingJfw"><span>JFW独自</span><b>${jfwRating==null?'—':jfwRating.toFixed(1)}</b><small>${jfwRating==null?esc(reason):`充足率 ${esc(cov)}`}</small></div>
    </div>`;
  }
  function safePhotoUrl(value){
    if(window.JFWFormation?.safeImageUrl) return window.JFWFormation.safeImageUrl(value);
    if(value===null||value===undefined||value==='') return null;
    try{ const url=new URL(String(value)); return /https?:/.test(url.protocol)?url.toString():null; }catch{ return null; }
  }
  function personInitials(value){
    if(window.JFWFormation?.personInitials) return window.JFWFormation.personInitials(value);
    return Array.from(String(value||'—').trim()).slice(0,2).join('')||'—';
  }
  function personPhotoHtml(photo,name,className='mdPersonPhoto'){
    const url=safePhotoUrl(photo), missing=url?'':' is-photo-missing';
    return `<span class="mdPhotoWrap ${esc(className)}${missing}" data-photo-wrap>${url?`<img src="${esc(url)}" alt="${esc(name||'人物')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-jfw-photo>`:''}<span class="mdPhotoFallback" aria-hidden="true">${esc(personInitials(name))}</span></span>`;
  }
  function playerRecordHtml(r){
    const d=currentData();
    const player=(d.players||[]).find(p=>String(p.playerId||p.name)===String(r.playerId||r.player||r.playerName)||p.name===r.player||p.name===r.playerName);
    const name=r.playerName||r.player||player?.name||'選手';
    const rating=validJfwRating(r.jfwRating)?Number(r.jfwRating):null;
    const reason=rating==null?(r.reason==='discipline_inputs_missing'?'規律データ未取得':r.reason==='minimum_inputs_missing'?'最低算出条件未達':r.reason==='unknown_position'?'評価ポジション未確定':'未算出'):'';
    const cov=r.ratingCoverage==null?'—':`${Math.round(Number(r.ratingCoverage)*100)}%`;
    const sources=r.ratingSources||[];
    const conflicts=r.ratingConflicts||[];
    return `<div class="card mdPlayerCard">
      <div class="mdPlayerHead">
        <div class="mdPlayerIdentity">
          ${personPhotoHtml(r.photo||player?.photo,name,'mdRecordPhoto')}
          <div>
            <div class="name ${player?'entityLink':''}" ${player?`data-open-player="${esc(player.playerId||player.name)}"`:''}>${esc(name)}</div>
            <div class="sub">${esc(r.club||player?.club||'')} ${r.ratingPosition?`・ Rating ${esc(r.ratingPosition)}`:''}${r.ratingPositionSource?` ・ ${esc(r.ratingPositionSource)}`:''}</div>
          </div>
        </div>
        ${individualRatingsHtml(r,reason,cov)}
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
  function formationApi(){ return window.JFWFormation || null; }
  function pitchRating(player,recs){
    const api=formationApi();
    if(api?.ratingForPlayer) return api.ratingForPlayer(player,formationRatingMode,recs);
    const record=recs.find(r=>player?.playerId&&String(r.playerId)===String(player.playerId));
    return formationRatingMode==='jfw'?(validJfwRating(record?.jfwRating)?Number(record.jfwRating):null):providerRatingOf(record);
  }
  function minuteText(substitution){
    const api=formationApi();
    if(api?.formatMinute) return api.formatMinute(substitution);
    const elapsed=Number(substitution?.elapsed??substitution?.minute);
    return Number.isFinite(elapsed)?`${Math.trunc(elapsed)}′`:'時刻未取得';
  }
  function pitchPlayerHtml(player,recs){
    const rating=pitchRating(player,recs), sub=player?.substitution, isOut=sub?.direction==='out';
    const minute=isOut?minuteText(sub):'', replacement=isOut&&sub?.replacementName?` → ${sub.replacementName}`:'';
    const tracked=!!player?.playerId, name=player?.name||'選手', number=player?.number??'—', photo=safePhotoUrl(player?.photo);
    return `<div class="mdPitchPlayer ${isOut?'is-subbed-out':''} ${tracked?'is-tracked':''}" style="left:${Number(player.x)||50}%;top:${Number(player.y)||50}%" ${tracked?`data-open-player="${esc(player.playerId)}"`:''} title="${esc(name+(isOut?` ${minute} OUT${replacement}`:''))}">
      <span class="mdPlayerDisc ${photo?'has-photo':'is-photo-missing'}">${photo?`<img class="mdPitchPhoto" src="${esc(photo)}" alt="${esc(name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-jfw-photo>`:''}<span class="mdShirtNo">${esc(number)}</span><span class="mdPitchRating ${formationRatingMode==='jfw'?'is-jfw':'is-api'}">${rating==null?'—':Number(rating).toFixed(1)}</span></span>
      <span class="mdPitchName">${esc(name)}</span>
      ${isOut?`<span class="mdSubFlag is-out">↘ OUT ${esc(minute)}</span>`:''}
    </div>`;
  }
  function benchPlayerHtml(player,recs){
    const rating=pitchRating(player,recs), sub=player?.substitution, isIn=sub?.direction==='in', tracked=!!player?.playerId;
    const counterpart=isIn&&sub?.replacedName?`<small>← ${esc(sub.replacedName)}</small>`:'';
    return `<div class="mdBenchPlayer ${isIn?'is-subbed-in':''} ${tracked?'is-tracked':''}" ${tracked?`data-open-player="${esc(player.playerId)}"`:''}>
      ${personPhotoHtml(player?.photo,player?.name||'選手','mdBenchPhoto')}
      <span class="mdBenchState ${isIn?'is-in':''}">${isIn?`↗ IN ${esc(minuteText(sub))}`:'ベンチ'}</span>
      <span class="mdBenchIdentity"><b>${esc(player?.number??'—')} ${esc(player?.name||'選手')}</b>${counterpart}</span>
      <span class="mdBenchRating ${formationRatingMode==='jfw'?'is-jfw':'is-api'}">${rating==null?'—':Number(rating).toFixed(1)}</span>
    </div>`;
  }
  function coachHtml(coach){
    const name=coach?.name||'監督情報未取得';
    return `<div class="mdCoachRow">${personPhotoHtml(coach?.photo,name,'mdCoachPhoto')}<div><span>監督</span><b>${esc(name)}</b>${coach&&!coach.photo?'<small>写真未取得</small>':''}</div></div>`;
  }
  function teamFormationHtml(team,recs){
    const api=formationApi();
    const starters=team?.startXI||[];
    const laidOut=api?.layoutPlayers?api.layoutPlayers(starters):starters.map((p,i)=>({...p,x:50,y:88-i*7}));
    const side=team?.side==='home'?'HOME':'AWAY', formation=team?.formation||'配置未取得';
    return `<article class="mdFormationTeam">
      <div class="mdFormationHead"><div><span class="mdSideTag">${side}</span><b>${esc(team?.teamName||'クラブ名未取得')}</b></div><div class="mdFormationName">${esc(formation)}<small>${starters.length?`${starters.length}人`:'先発未取得'}</small></div></div>
      ${coachHtml(team?.coach)}
      ${starters.length?`<div class="mdPitch" aria-label="${esc(team?.teamName||'チーム')} ${esc(formation)}"><div class="mdHalfwayLine"></div><div class="mdCenterCircle"></div>${laidOut.map(player=>pitchPlayerHtml(player,recs)).join('')}</div>`:'<div class="mdFormationEmpty">このチームの先発配置は未取得です。</div>'}
      <div class="mdBench"><div class="mdBenchTitle">交代・ベンチ <span>緑=IN / 橙=OUT</span></div>${(team?.substitutes||[]).length?(team.substitutes||[]).map(player=>benchPlayerHtml(player,recs)).join(''):'<div class="mdFormationEmpty">ベンチ情報は未取得です。</div>'}</div>
    </article>`;
  }
  function formationHtml(m,recs){
    const data=m?.formationData, teams=data?.teams||[];
    if(!teams.length) return `<div class="card mdFormationNotice"><div class="name">フォーメーションはまだ未取得</div><div class="reason">API-Footballのラインナップが取得できた試合から、両チームの先発配置・交代・ベンチを表示します。未取得の配置や評価を推測で補いません。</div></div>`;
    const modeNote=formationRatingMode==='jfw'
      ? 'JFW独自評価は追跡対象の日本人選手だけに表示します。未算出・対象外の選手は「—」です。'
      : 'API-Footballの試合評価を表示します。提供されていない選手は「—」です。';
    return `<div class="mdFormationToolbar"><div><b>表示レーティング</b><span>${esc(modeNote)}</span></div><div class="mdRatingSwitch" role="group" aria-label="フォーメーションの表示評価">
      <button type="button" class="${formationRatingMode==='apiFootball'?'on':''}" data-formation-rating="apiFootball" aria-pressed="${formationRatingMode==='apiFootball'}">API-Football</button>
      <button type="button" class="${formationRatingMode==='jfw'?'on':''}" data-formation-rating="jfw" aria-pressed="${formationRatingMode==='jfw'}">JFW独自</button>
    </div></div><div class="mdFormationGrid">${teams.map(team=>teamFormationHtml(team,recs)).join('')}</div>`;
  }
  function markPhotoMissing(image){
    const holder=image?.closest?.('[data-photo-wrap],.mdPlayerDisc');
    if(holder) holder.classList.add('is-photo-missing');
  }
  function bindPhotoFallback(root=document){
    root.querySelectorAll?.('img[data-jfw-photo]').forEach(image=>{
      if(image.dataset.jfwPhotoBound!=='1'){
        image.dataset.jfwPhotoBound='1';
        image.addEventListener('error',()=>markPhotoMissing(image),{once:true});
      }
      if(image.complete&&image.naturalWidth===0) markPhotoMissing(image);
    });
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
    const recs=recordsForMatch(m), names=trackedPlayersFromMatch(m,recs), rated=recs.filter(r=>validJfwRating(r.jfwRating)).length, sources=sourceCount(recs,m), status=typeof st==='function'?st(m.status):['',''];
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
        <h2>スタメン・フォーメーション</h2>
        <div class="lead">両チームの先発配置、交代IN/OUT、ベンチと試合評価を同じ画面で確認できます。</div>
        ${formationHtml(m,recs)}
      </section>
      <section>
        <h2>日本人選手別データ</h2>
        <div class="lead">API-Football試合評価とJFW独自評価を並べ、入力スタッツ、取得/未取得状態、JFW内訳、出典を確認できます。</div>
        ${recs.length?recs.map(playerRecordHtml).join(''):`<div class="card"><div class="name">詳細個人データはまだ未取得</div><div class="reason">この試合は試合ログとしては確認済みですが、<code>playerMatchStats</code> がまだ登録されていません。今後の取得で追加された項目から順にここへ表示します。未取得値を0として補完することはありません。</div></div>`}
      </section>`;
    const back=root.querySelector('[data-md-back]'); if(back) back.onclick=()=>{ activeMatchRef=null; clearDetailParams(); showPage(lastPage); };
    root.querySelectorAll('[data-formation-rating]').forEach(button=>button.onclick=()=>{
      formationRatingMode=button.dataset.formationRating==='jfw'?'jfw':'apiFootball';
      renderMatchDetail();
    });
    bindPhotoFallback(root);
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
        .matchdetailbtn:hover{border-color:var(--a)}
        .mdKpis{margin-top:10px}.mdClubLinks{display:flex;gap:7px;flex-wrap:wrap}.mdPlayerCard{overflow:hidden}.mdPlayerHead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.mdPlayerIdentity,.mdPlayerHero{display:flex;align-items:center;gap:11px;min-width:0}.mdPlayerIdentity>div,.mdPlayerHero>div{min-width:0}
        .mdPhotoWrap{position:relative;display:grid;flex:0 0 auto;place-items:center;overflow:hidden;border:1px solid #ffffff33;border-radius:50%;background:linear-gradient(145deg,#24405f,#101827);color:#dbeafe;font-weight:900}.mdPhotoWrap img{width:100%;height:100%;object-fit:cover;object-position:center top}.mdPhotoFallback{display:grid;width:100%;height:100%;place-items:center}.mdPhotoWrap:not(.is-photo-missing) .mdPhotoFallback{display:none}.mdPhotoWrap.is-photo-missing img{display:none}.mdRecordPhoto{width:54px;height:54px;font-size:14px}.mdProfilePhoto{width:82px;height:82px;border:2px solid #5eead477;font-size:20px;box-shadow:0 8px 24px #0007}.mdBenchPhoto{width:30px;height:30px;font-size:8px}.mdCoachPhoto{width:36px;height:36px;font-size:9px}
        .mdRatingCompare{display:flex;gap:7px;flex:0 0 auto}.mdRating{text-align:center;min-width:82px;background:var(--p2);border:1px solid var(--l);border-radius:10px;padding:7px 8px}.mdRating span,.mdRating small{display:block;color:var(--m);font-size:9px;white-space:nowrap}.mdRating b{display:block;font-size:28px;line-height:1.05}.mdRatingApi b{color:#fbbf24}.mdRatingJfw b{color:var(--a)}
        .mdFormationNotice{margin-top:10px}.mdFormationToolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:10px 0;padding:10px 12px;background:var(--p2);border:1px solid var(--l);border-radius:12px}.mdFormationToolbar b,.mdFormationToolbar span{display:block}.mdFormationToolbar b{font-size:12px}.mdFormationToolbar span{margin-top:3px;color:var(--m);font-size:10px;max-width:620px}.mdRatingSwitch{display:flex;flex:0 0 auto;background:#07111f;border:1px solid var(--l);border-radius:10px;padding:3px}.mdRatingSwitch button{border:0;background:transparent;color:var(--m);border-radius:7px;padding:7px 10px;font-size:10px;font-weight:850;cursor:pointer}.mdRatingSwitch button.on{background:#24405f;color:#fff;box-shadow:0 1px 5px #0006}
        .mdFormationGrid{display:grid;gap:12px}.mdFormationTeam{overflow:hidden;background:#0b1728;border:1px solid var(--l);border-radius:15px}.mdFormationHead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px 8px}.mdFormationHead>div:first-child{display:flex;align-items:center;gap:7px;min-width:0}.mdFormationHead b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mdSideTag{color:#93c5fd;font-size:9px;font-weight:900;letter-spacing:.08em}.mdFormationName{font-size:18px;font-weight:900;text-align:right;white-space:nowrap}.mdFormationName small{display:block;color:var(--m);font-size:9px;font-weight:600}.mdCoachRow{display:flex;align-items:center;gap:8px;margin:0 12px 10px;padding:7px 8px;border:1px solid #ffffff14;border-radius:10px;background:#ffffff08}.mdCoachRow>div{min-width:0}.mdCoachRow span,.mdCoachRow small{display:block;color:var(--m);font-size:8px}.mdCoachRow b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
        .mdPitch{position:relative;height:clamp(430px,70vw,590px);margin:0 10px 10px;overflow:hidden;border:2px solid #dfffee99;border-radius:10px;background:repeating-linear-gradient(0deg,#187747 0,#187747 11.11%,#147040 11.11%,#147040 22.22%);box-shadow:inset 0 0 30px #031b1177}.mdPitch:before{content:'';position:absolute;inset:4%;border:1px solid #e9fff899;border-radius:2px;pointer-events:none}.mdHalfwayLine{position:absolute;left:4%;right:4%;top:50%;height:1px;background:#e9fff899}.mdCenterCircle{position:absolute;left:50%;top:50%;width:72px;height:72px;border:1px solid #e9fff899;border-radius:50%;transform:translate(-50%,-50%)}
        .mdPitchPlayer{position:absolute;z-index:2;width:84px;transform:translate(-50%,-50%);text-align:center;color:#fff}.mdPitchPlayer.is-tracked{cursor:pointer}.mdPlayerDisc{position:relative;display:block;width:46px;height:46px;margin:0 auto;overflow:visible;border:2px solid #dfffee;background:#102b45;border-radius:50%;box-shadow:0 3px 9px #001b}.mdPitchPhoto{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center top;border-radius:50%}.mdPlayerDisc.is-photo-missing .mdPitchPhoto{display:none}.mdPitchPlayer.is-tracked .mdPlayerDisc{box-shadow:0 0 0 2px #38bdf8,0 3px 9px #001b}.mdPitchPlayer.is-subbed-out .mdPlayerDisc{border-color:#fb923c}.mdShirtNo{display:block;padding-top:7px;font-size:15px;font-weight:950;line-height:1}.mdPlayerDisc.has-photo:not(.is-photo-missing) .mdShirtNo{position:absolute;left:-4px;bottom:-4px;z-index:2;min-width:18px;border:2px solid #0b1728;border-radius:9px;background:#102b45;padding:2px 4px;font-size:8px}.mdPitchRating{position:absolute;z-index:3;right:-8px;bottom:-5px;min-width:29px;border:2px solid #0b1728;border-radius:10px;background:#111827;padding:2px 4px;font-size:10px;font-weight:950}.mdPitchRating.is-api,.mdBenchRating.is-api{color:#fbbf24}.mdPitchRating.is-jfw,.mdBenchRating.is-jfw{color:#67e8f9}.mdPitchName{display:block;margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:850;text-shadow:0 1px 3px #001}.mdSubFlag{display:inline-block;margin-top:2px;border-radius:8px;padding:2px 5px;font-size:8px;font-weight:950}.mdSubFlag.is-out{background:#7c2d12;color:#fed7aa}
        .mdBench{padding:0 10px 10px}.mdBenchTitle{display:flex;justify-content:space-between;padding:2px 2px 7px;color:#cbd5e1;font-size:11px;font-weight:850}.mdBenchTitle span{color:var(--m);font-size:9px;font-weight:600}.mdBenchPlayer{display:grid;grid-template-columns:30px 68px minmax(0,1fr) 35px;align-items:center;gap:7px;margin-top:5px;border-left:3px solid #334155;border-radius:8px;background:var(--p2);padding:7px 8px;font-size:10px}.mdBenchPlayer.is-subbed-in{border-left-color:#22c55e}.mdBenchPlayer.is-tracked{cursor:pointer}.mdBenchState{color:var(--m);font-size:9px;font-weight:850}.mdBenchState.is-in{color:#86efac}.mdBenchIdentity{min-width:0}.mdBenchIdentity b,.mdBenchIdentity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mdBenchIdentity small{margin-top:2px;color:var(--m);font-size:8px}.mdBenchRating{text-align:right;font-size:11px;font-weight:950}.mdFormationEmpty{padding:22px;color:var(--m);font-size:11px;text-align:center}
        .mdBlockTitle{font-size:12px;font-weight:850;margin:14px 0 7px;color:#cbd5e1}.mdStatGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.mdStat{background:var(--p2);border:1px solid var(--l);border-radius:9px;padding:8px;min-width:0}.mdStat>span{display:block;color:var(--m);font-size:10px;margin-bottom:3px}.mdStat>div{font-size:12px;word-break:break-word}.mdMissing{color:var(--y)}.mdNA{color:var(--m)}.mdSourceId{color:var(--m);font-size:9px;margin-left:5px}.mdBreakdown{margin-top:12px;border-top:1px solid var(--l);padding-top:9px}.mdBreakdown>div{display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:3px 0}.mdSource{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid #ffffff0d;font-size:11px}.mdSource a{color:#93c5fd}.mdSourceTime{color:var(--m);font-size:9px;text-align:right}
        @media(max-width:620px){.mdPlayerHead{display:block}.mdRatingCompare{margin-top:10px}.mdRating{flex:1}.mdFormationToolbar{align-items:stretch;flex-direction:column}.mdRatingSwitch{align-self:flex-start}.mdPitchPlayer{width:70px}.mdPitchName{font-size:9px}}
        @media(min-width:720px){.mdStatGrid{grid-template-columns:repeat(4,minmax(0,1fr))}}
        @media(min-width:980px){.mdFormationGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.mdPitch{height:500px}}
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
    document.addEventListener('error',e=>{ if(e.target?.matches?.('img[data-jfw-photo]')) markPhotoMissing(e.target); },true);
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
      window.bindJFWPhotos=bindPhotoFallback;
      bindPhotoFallback(document);
    } catch(err){ console.error('match-detail init failed',err); }
  }

  start();
})();
