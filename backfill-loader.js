(() => {
  'use strict';

  const mergeCore = window.JFWBackfillMerge;
  if (!mergeCore) throw new Error('backfill-merge.js must load before backfill-loader.js');

  const OUT_OF_SCOPE_BUCKET = mergeCore.OUT_OF_SCOPE_BUCKET;
  let loading = null;
  let uiPolicyInstalled = false;

  async function getJson(path) {
    const sep = path.includes('?') ? '&' : '?';
    const response = await fetch(path + sep + 'v=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
  }

  function trackingApi() {
    return mergeCore.trackingApi(D, { season: selectedSeason });
  }

  function stablePlayerId(name) { return mergeCore.stablePlayerId(name); }
  function isTrackedLeague(league) { return mergeCore.isTrackedLeague(league); }
  function membershipAt(player, when) { return mergeCore.membershipAt(player, when); }
  function playerForRecord(record) { return trackingApi().playerForRecord(record); }
  function clubForRecord(record, player) { return trackingApi().clubForRecord(record, player); }
  function competitionOfRecord(record) { return trackingApi().competitionOfRecord(record); }
  function competitionScopes() { return trackingApi().competitionScopes(); }
  function statsForScope(player, scopeName) { return mergeCore.statsForScope(player, scopeName); }
  function statsForClub(player, club) { return mergeCore.statsForClub(player, club); }
  function currentLeagueBucket(player) { return mergeCore.currentLeagueBucket(player); }
  function currentTrackedPlayers() { return trackingApi().currentTrackedPlayers(); }
  function matchesForClub(club) { return trackingApi().matchesForClub(club); }
  function rebuildPlayerSeasonAggregates() {
    D = mergeCore.rebuildAggregates(D, { season: selectedSeason });
    return D;
  }

  function installUiScopePolicy() {
    if (uiPolicyInstalled) return;
    uiPolicyInstalled = true;

    try {
      const i = order.indexOf('J1');
      if (i >= 0) order.splice(i, 1);
      if (!order.includes(OUT_OF_SCOPE_BUCKET)) order.push(OUT_OF_SCOPE_BUCKET);
    } catch {}

    try {
      clubPlayers = function(club) {
        return (D.players || []).filter(p => p.club === club && p.trackingStatus === 'active');
      };
      relevantClubMatches = matchesForClub;
      clubMatchCard = function(m, club) {
        const recs = (D.playerMatchStats || [])
          .filter(r => {
            const same = (r.matchId && m.matchId && r.matchId === m.matchId) ||
              (r.match === m.match) || (r.ko && r.ko === m.ko);
            return same && clubForRecord(r, playerForRecord(r)) === club;
          })
          .map(r => window.JFWRating ? JFWRating.withComputedRating(r) : r);
        const extra = recs.length
          ? `<div class="stats">${recs.map(r => `${E(r.player || r.playerName || '選手')}: ${Number.isFinite(Number(r.jfwRating)) ? 'JFW ' + Number(r.jfwRating).toFixed(1) : 'Rating未算出'} / ${fmt(r.minutes ?? r.ratingInputs?.minutes?.value)}分 / G ${fmt(r.goals ?? r.ratingInputs?.goals?.value)} A ${fmt(r.assists ?? r.ratingInputs?.assists?.value)}`).join('<br>')}</div>`
          : '';
        return mcard(m) + extra;
      };
    } catch (e) {
      console.warn('club transfer-safe patch failed', e);
    }

    try {
      leagues = function() {
        const present = [];
        for (const p of D.players || []) {
          const bucket = currentLeagueBucket(p);
          if (bucket && !present.includes(bucket)) present.push(bucket);
        }
        const out = ['すべて'];
        for (const x of order || []) if (x !== 'すべて' && present.includes(x) && !out.includes(x)) out.push(x);
        for (const x of present) if (!out.includes(x)) out.push(x);
        return out;
      };
      renderAttention = function() {
        btns(R.leagueBtns, leagues(), attLeague, x => { attLeague = x; renderAttention(); });
        const rows = (D.players || [])
          .filter(p => attLeague === 'すべて' || currentLeagueBucket(p) === attLeague)
          .sort((a, b) => (a.rank || 99) - (b.rank || 99));
        R.leagueTitle.textContent = attLeague === 'すべて' ? 'リーグ別 注目度ランキング' : attLeague + ' 注目度ランキング';
        R.players.innerHTML = rows.map(pcard).join('') || '<div class="empty">該当なし</div>';
        bindEntities(R.players);
      };
    } catch (e) {
      console.warn('tracking bucket patch failed', e);
    }

    try {
      playerRecordCard = function(r) {
        const rating = Number.isFinite(Number(r.jfwRating)) ? Number(r.jfwRating) : null;
        const mins = r.minutes ?? r.ratingInputs?.minutes?.value;
        const goals = r.goals ?? r.ratingInputs?.goals?.value;
        const assists = r.assists ?? r.ratingInputs?.assists?.value;
        const cov = r.ratingCoverage;
        const meta = [r.club, r.competition || r.league, r.round, r.ko].filter(Boolean).join(' ・ ');
        return `<div class="card">
          <div class="ratingRow"><div><div class="match">${E(r.match || r.opponent || '試合')}</div><div class="sub">${E(meta)}</div></div><div class="metricValue">${rating == null ? '—' : rating.toFixed(1)}</div></div>
          <div class="stats">${fmt(mins)}分 / G ${fmt(goals)} / A ${fmt(assists)}${cov != null ? ` / 充足率 ${Math.round(cov * 100)}%` : ''}</div>
          ${r.gaOnPitchAmbiguous ? '<span class="pill part">在場中失点の時系列に曖昧さあり</span>' : ''}
        </div>`;
      };
    } catch (e) {
      console.warn('player match provenance patch failed', e);
    }

    try {
      renderStats = function() {
        const scopes = competitionScopes();
        if (!scopes.includes(scope)) scope = 'すべて';
        btns(R.scopeBtns, scopes, scope, x => { scope = x; renderStats(); });
        R.metricBtns.innerHTML = Object.entries(metrics)
          .map(([k, v]) => `<button class="btn ${k === metric ? 'on' : ''}" data-k="${k}">${v}</button>`)
          .join('');
        R.metricBtns.querySelectorAll('button').forEach(b => b.onclick = () => {
          metric = b.dataset.k;
          renderStats();
        });
        const val = (p, k) => {
          const s = statsForScope(p, scope);
          if (k === 'ga') return s.goals == null || s.assists == null ? null : s.goals + s.assists;
          return s[k] ?? null;
        };
        const rows = (D.players || [])
          .filter(p => p.rankingEligible !== false)
          .filter(p => scope === 'すべて' || p.competitionStats?.[scope])
          .filter(p => eligible(p, metric))
          .map(p => [p, val(p, metric)])
          .filter(x => x[1] != null)
          .sort((a, b) => b[1] - a[1] || (b[0].rating || 0) - (a[0].rating || 0));

        R.statRank.innerHTML = rows.map(([p, v], i) =>
          `<div class="card clickable" data-open-player="${E(playerRef(p))}">
            <div class="row">
              <div class="rank">${i + 1}</div>
              <div class="grow">
                <div class="name">${E(p.name)}</div>
                <div class="sub"><span class="entityLink" data-open-club="${E(p.club)}">${E(p.club || '所属なし')}</span> ・ ${E(scope === 'すべて' ? 'シーズン通算' : scope)} ・ ${E(p.statsAsOf || '')}</div>
                ${p.trackingStatus !== 'active' ? `<span class="pill part">${E(OUT_OF_SCOPE_BUCKET)}・移籍時点まで</span>` : ''}
              </div>
              <div class="metricValue">${E(v)}</div>
            </div>
          </div>`
        ).join('') || '<div class="empty">この指標は現在取得できていません。</div>';
        bindEntities(R.statRank);
      };
    } catch (e) {
      console.warn('competition stats filter patch failed', e);
    }

    try {
      const baseRenderPlayerDetail = renderPlayerDetail;
      renderPlayerDetail = function() {
        baseRenderPlayerDetail();
        const p = playerByRef(activePlayer);
        if (!p || !R.playerDetail) return;

        const detailHead = R.playerDetail.querySelector('.detailHead');
        const identity = detailHead?.firstElementChild;
        if (identity && !identity.dataset?.playerProfilePhoto && typeof profilePhotoHtml === 'function') {
          identity.className = 'mdPlayerHero';
          identity.dataset.playerProfilePhoto = '1';
          identity.innerHTML = `${profilePhotoHtml(p)}<div>${identity.innerHTML}</div>`;
          try { window.bindJFWPhotos?.(identity); } catch {}
        }

        if (p.trackingStatus !== 'active' && !R.playerDetail.querySelector('[data-tracking-state-note]')) {
          const note = document.createElement('section');
          note.dataset.trackingStateNote = '1';
          note.innerHTML = `<div class="card part"><div class="name">${E(OUT_OF_SCOPE_BUCKET)}</div><div class="reason">現在の移籍先は追跡対象外です。選手レコードと今季の追跡済み個人成績は保持し、ランキングにも残します。移籍後の追跡対象外リーグの新規試合成績は自動加算しません。</div></div>`;
          const first = R.playerDetail.querySelector('section');
          first?.insertAdjacentElement('afterend', note);
        }

        if (!R.playerDetail.querySelector('[data-competition-breakdown]')) {
          const entries = Object.entries(p.competitionStats || {});
          if (entries.length) {
            const cards = entries.map(([name, s]) =>
              `<div class="card"><div class="name">${E(name)}</div><div class="stats">出場 ${fmt(s.apps)} / 先発 ${fmt(s.starts)} / G ${fmt(s.goals)} / A ${fmt(s.assists)} / 分 ${fmt(s.minutes)}</div></div>`
            ).join('');
            const sec = document.createElement('section');
            sec.dataset.competitionBreakdown = '1';
            sec.innerHTML = `<h2>大会別成績</h2><div class="lead">シーズン通算と大会別を分離。各記録は playerMatchStats の試合IDとの紐付けを維持します。</div><div class="grid">${cards}</div>`;
            const sections = R.playerDetail.querySelectorAll('section');
            if (sections[1]) sections[1].insertAdjacentElement('afterend', sec);
            else R.playerDetail.appendChild(sec);
          }
        }

        if (!R.playerDetail.querySelector('[data-club-breakdown]')) {
          const memberships = p.membershipHistory || [];
          if (memberships.length) {
            const cards = memberships.map((m, i) => {
              const s = statsForClub(p, m.club);
              const period = `${m.from || 'シーズン開始'} 〜 ${m.to || '現在'}`;
              const state = m.tracked === false ? '追跡対象外' : '追跡対象';
              return `<div class="card">
                <div class="name">${E(m.club || '所属なし')}</div>
                <div class="sub">${E(m.league || 'リーグ未取得')} ・ ${E(period)} ・ ${E(state)}</div>
                <div class="stats">出場 ${fmt(s.apps)} / 先発 ${fmt(s.starts)} / G ${fmt(s.goals)} / A ${fmt(s.assists)} / 分 ${fmt(s.minutes)}</div>
                ${i === memberships.length - 1 && p.previousClub ? `<div class="sourceNote">前所属: ${E(p.previousClub)}</div>` : ''}
              </div>`;
            }).join('');
            const sec = document.createElement('section');
            sec.dataset.clubBreakdown = '1';
            sec.innerHTML = `<h2>所属履歴・クラブ別成績</h2><div class="lead">移籍しても同じ playerId を継続し、旧所属クラブの成績を新所属クラブへ付け替えません。</div><div class="grid">${cards}</div>`;
            R.playerDetail.appendChild(sec);
          }
        }
      };
    } catch (e) {
      console.warn('player transfer history patch failed', e);
    }

    try {
      renderClubDetail = function() {
        const club = activeClub;
        const ps = clubPlayers(club);
        if (!ps.length) {
          R.clubDetail.innerHTML = '<section><div class="empty">現在このクラブに追跡対象の日本人選手はいません。</div></section>';
          return;
        }
        const matches = relevantClubMatches(club);
        const rounds = [...new Set(matches.map(m => roundNo(m.round)).filter(Number.isFinite))].sort((a, b) => a - b);
        if (clubRoundFrom == null) clubRoundFrom = rounds[0] ?? null;
        if (clubRoundTo == null) clubRoundTo = rounds.at(-1) ?? null;
        const filtered = matches.filter(m => {
          const r = roundNo(m.round);
          return r == null || (r >= clubRoundFrom && r <= clubRoundTo);
        });
        const knownSum = key => {
          const values = ps.map(p => statsForClub(p, club)?.[key]).filter(v => v != null && Number.isFinite(Number(v))).map(Number);
          return values.length ? values.reduce((a, b) => a + b, 0) : null;
        };
        const g = knownSum('goals');
        const a = knownSum('assists');
        const league = ps[0]?.league || '';
        const opts = rounds.map(r => `<option value="${r}">第${r}節</option>`).join('');
        const playerCards = ps.map(p => {
          const clone = { ...p, stats: statsForClub(p, club), statsAsOf: `${club}在籍時` };
          return pcard(clone);
        }).join('');

        R.clubDetail.innerHTML = `<section>
          <div class="backRow"><button class="linkbtn" data-back>← 一覧へ戻る</button></div>
          <div class="detailHead"><div><div class="crumb">${E(league)} / ${E(selectedSeason)}</div><div class="detailTitle">${E(club)}</div><div class="sub">現在所属の追跡日本人 ${ps.length}人</div></div></div>
        </section>
        <section><h2>日本人選手サマリー</h2>
          <div class="summary">
            <div class="sum"><div class="num">${ps.length}</div><div class="muted">現在所属</div></div>
            <div class="sum"><div class="num">${g == null ? '—' : g}</div><div class="muted">このクラブでの今季得点</div></div>
            <div class="sum"><div class="num">${a == null ? '—' : a}</div><div class="muted">このクラブでの今季アシスト</div></div>
          </div>
          <div class="grid" style="margin-top:10px">${playerCards}</div>
        </section>
        <section>
          <div class="sectionTitleRow">
            <div><h2>節ごとの試合</h2><div class="lead">このクラブ所属時の playerMatchStats とクラブ名で紐付け。</div></div>
            ${rounds.length ? `<div class="rangeBox"><select id="clubRoundFrom" class="rangeSelect">${opts}</select><span class="muted">〜</span><select id="clubRoundTo" class="rangeSelect">${opts}</select></div>` : ''}
          </div>
          <div id="clubMatches" class="grid">${filtered.map(m => clubMatchCard(m, club)).join('') || '<div class="empty">該当する試合がありません。</div>'}</div>
        </section>`;

        const back = R.clubDetail.querySelector('[data-back]');
        if (back) back.onclick = () => { activeClub = null; clearDetailParams(); showPage(lastPage); };
        const f = $('clubRoundFrom'), t = $('clubRoundTo');
        if (f && t) {
          f.value = clubRoundFrom;
          t.value = clubRoundTo;
          const change = () => {
            clubRoundFrom = Number(f.value);
            clubRoundTo = Number(t.value);
            if (clubRoundFrom > clubRoundTo) [clubRoundFrom, clubRoundTo] = [clubRoundTo, clubRoundFrom];
            renderClubDetail();
          };
          f.onchange = change;
          t.onchange = change;
        }
        bindEntities(R.clubDetail);
        bindWatch(R.clubDetail, D.matches || []);
      };
    } catch (e) {
      console.warn('club detail stats patch failed', e);
    }
  }

  function applyFragments(parts) {
    D = mergeCore.mergeBackfillData(D, parts, { season: selectedSeason });
    installUiScopePolicy();
  }

  async function applyCurrentBackfill() {
    const season = String(selectedSeason || '');
    if (!season) return false;
    try {
      const base = `data/${encodeURIComponent(season)}/backfill/`;
      const manifest = await getJson(base + 'index.json');
      const parts = await Promise.all((manifest.fragments || []).map(file => getJson(base + file)));
      applyFragments(parts);
      try { R.updated.textContent = `${season} ・ 最終更新: ${D.updated || '未取得'}`; } catch {}
      return true;
    } catch (e) {
      if (!String(e).includes('404')) console.warn('player match backfill load failed', e);
      return false;
    }
  }

  async function refreshViews() {
    try { renderAll(); } catch {}
    try {
      if (page === 'player') renderPlayerDetail();
      if (page === 'club') renderClubDetail();
    } catch {}
    try {
      if (page === 'match' && window.renderMatchDetail) window.renderMatchDetail();
    } catch {}
  }

  async function boot() {
    if (loading) return loading;
    loading = (async () => {
      await applyCurrentBackfill();
      await refreshViews();
    })();
    await loading;
    loading = null;
  }

  const baseLoad = loadSeason;
  loadSeason = async function(id, opts = {}) {
    await baseLoad(id, opts);
    await applyCurrentBackfill();
    await refreshViews();
  };

  window.JFWTracking = {
    VERSION: '1.0',
    OUT_OF_SCOPE_BUCKET,
    stablePlayerId,
    isTrackedLeague,
    membershipAt,
    clubForRecord,
    competitionOfRecord,
    statsForScope,
    statsForClub,
    currentTrackedPlayers,
    matchesForClub,
    currentLeagueBucket,
    rebuildPlayerSeasonAggregates
  };
  window.JFWBackfill = {
    applyCurrentBackfill,
    boot,
    rebuildPlayerSeasonAggregates,
    competitionScopes,
    statsForScope,
    mergeData: mergeCore.mergeBackfillData
  };

  const initialLoad = boot();
  window.JFWBackfill.initialLoad = initialLoad;
  initialLoad.finally(() => {
    if (document.querySelector('script[data-jfw-match-detail]')) return;
    const script = document.createElement('script');
    script.src = `match-detail.js?v=${Date.now()}`;
    script.dataset.jfwMatchDetail = '1';
    document.body.appendChild(script);
  });
})();
