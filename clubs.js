(() => {
  'use strict';

  let selectedLeague = 'すべて';
  let favoriteMode = 'すべて';

  function esc(value) {
    return typeof E === 'function'
      ? E(value)
      : String(value ?? '').replace(/[&<>"']/g, char => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        })[char]);
  }

  function currentData() {
    try { return D || null; } catch { return null; }
  }

  function trackingApi() {
    try { return window.JFWTracking || null; } catch { return null; }
  }

  function favoriteState() {
    try { return window.JFWFavorites?.read() || { players: [], clubs: [] }; }
    catch { return { players: [], clubs: [] }; }
  }

  function favoriteClubNames(state = favoriteState()) {
    return new Set((state.clubs || []).map(club => club.name));
  }

  function currentTrackedPlayer(player) {
    const api = trackingApi();
    if (!api) return player?.trackingStatus !== 'out_of_scope' && player?.trackingStatus !== 'unattached';
    return player?.trackingStatus === 'active' || api.isTrackedLeague?.(player?.league);
  }

  function playerClubStats(player, club) {
    const api = trackingApi();
    if (api?.statsForClub) return api.statsForClub(player, club) || {};
    return player?.stats || {};
  }

  function knownStat(players, key, club) {
    const values = players
      .map(player => playerClubStats(player, club)?.[key])
      .filter(value => value != null && Number.isFinite(Number(value)))
      .map(Number);
    return {
      value: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      coverage: values.length,
      total: players.length
    };
  }

  function matchesForClub(name, players) {
    const api = trackingApi();
    try {
      if (api?.matchesForClub) return api.matchesForClub(name);
      if (typeof relevantClubMatches === 'function') return relevantClubMatches(name);
    } catch {}
    const names = players.map(player => player.name);
    return (currentData()?.matches || []).filter(match =>
      String(match.match || '').includes(name) ||
      names.some(playerName => String(match.players || '').includes(playerName))
    );
  }

  function clubRows() {
    const clubs = new Map();
    for (const player of currentData()?.players || []) {
      if (!player.club || !currentTrackedPlayer(player)) continue;
      if (!clubs.has(player.club)) {
        clubs.set(player.club, {
          name: player.club,
          league: player.league || 'リーグ未取得',
          players: []
        });
      }
      clubs.get(player.club).players.push(player);
    }

    return [...clubs.values()].map(club => ({
      ...club,
      goals: knownStat(club.players, 'goals', club.name),
      assists: knownStat(club.players, 'assists', club.name),
      matches: matchesForClub(club.name, club.players)
    })).sort((a, b) => {
      const orderList = typeof order !== 'undefined' ? order : [];
      const ai = orderList.indexOf(a.league);
      const bi = orderList.indexOf(b.league);
      const leagueDiff = (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return leagueDiff || a.name.localeCompare(b.name, 'ja');
    });
  }

  function leagueOptions(rows) {
    const present = new Set(rows.map(row => row.league));
    const ordered = (typeof order !== 'undefined' ? order : ['すべて']).filter(
      league => league === 'すべて' || present.has(league)
    );
    for (const league of present) if (!ordered.includes(league)) ordered.push(league);
    return ordered;
  }

  function monogram(name) {
    const letters = Array.from(String(name || '').replace(/[\s・･＝=_\-]/g, ''));
    return letters.slice(0, 2).join('') || 'CL';
  }

  function formatStat(stat) {
    return stat.value == null ? '—' : String(stat.value);
  }

  function matchNote(row) {
    if (!row.matches.length) return '個別試合はまだ未登録';
    const latest = [...row.matches].sort((a, b) => String(b.ko || '').localeCompare(String(a.ko || '')))[0];
    const date = String(latest?.ko || '').slice(0, 10).replaceAll('-', '/');
    return `${row.matches.length}試合登録${latest?.round ? ` ・ ${latest.round}` : ''}${date ? ` ・ ${date}` : ''}`;
  }

  function favoriteControl(row, selected) {
    const label = selected ? `${row.name}のお気に入りを解除` : `${row.name}をお気に入り登録`;
    return `<button type="button" class="favoritebtn favoritebtn--icon clubFavoriteButton ${selected ? 'on' : ''}" data-club-favorite="${esc(row.name)}" aria-pressed="${selected}" aria-label="${esc(label)}" title="${esc(label)}"><span class="favoriteStar" aria-hidden="true">${selected ? '★' : '☆'}</span></button>`;
  }

  function clubCard(row, favoriteNames) {
    const selected = favoriteNames.has(row.name);
    const names = row.players.map(player => player.name).join('、');
    const partial = row.goals.coverage < row.goals.total || row.assists.coverage < row.assists.total;
    return `<div class="card clickable clubDirectoryCard" data-open-club="${esc(row.name)}">
      ${favoriteControl(row, selected)}
      <div class="clubCardHead">
        <div class="clubMonogram" aria-hidden="true">${esc(monogram(row.name))}</div>
        <div class="grow"><div class="name">${esc(row.name)}</div><div class="sub">${esc(row.league)}</div></div>
      </div>
      <div class="clubPills"><span class="pill">現在所属 日本人 ${row.players.length}人</span>${selected ? '<span class="pill clubFavoritePill">★ お気に入り</span>' : ''}${partial ? '<span class="pill part">一部未取得</span>' : ''}</div>
      <div class="clubPlayerNames">${esc(names)}</div>
      <div class="clubMiniStats">
        <div><b>${formatStat(row.goals)}</b><span>このクラブで今季得点</span></div>
        <div><b>${formatStat(row.assists)}</b><span>このクラブで今季アシスト</span></div>
        <div><b>${row.matches.length}</b><span>登録試合</span></div>
      </div>
      <div class="sub clubMatchNote">${esc(matchNote(row))}</div>
    </div>`;
  }

  function filterButton(label, selected, dataName) {
    return `<button type="button" class="btn ${selected ? 'on' : ''}" ${dataName}>${esc(label)}</button>`;
  }

  function bindControls(root) {
    root.querySelectorAll('[data-club-league]').forEach(button => {
      button.onclick = () => {
        selectedLeague = button.dataset.clubLeague;
        renderClubs();
      };
    });
    root.querySelectorAll('[data-club-favorite-mode]').forEach(button => {
      button.onclick = () => {
        favoriteMode = button.dataset.clubFavoriteMode;
        renderClubs();
      };
    });
    root.querySelectorAll('[data-club-favorite]').forEach(button => {
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        window.JFWFavorites?.toggle('club', button.dataset.clubFavorite, button.dataset.clubFavorite);
      };
    });
  }

  function renderClubs() {
    const root = document.getElementById('clubsRoot');
    if (!root) return;
    const data = currentData();
    if (!data) {
      root.innerHTML = '<section><div class="empty">クラブデータを読み込み中…</div></section>';
      return;
    }

    const allRows = clubRows();
    const favorites = favoriteClubNames();
    const leagues = leagueOptions(allRows);
    if (!leagues.includes(selectedLeague)) selectedLeague = 'すべて';
    const filtered = allRows.filter(row =>
      (selectedLeague === 'すべて' || row.league === selectedLeague) &&
      (favoriteMode === 'すべて' || favorites.has(row.name))
    );
    filtered.sort((a, b) =>
      Number(favorites.has(b.name)) - Number(favorites.has(a.name)) ||
      a.name.localeCompare(b.name, 'ja')
    );

    const trackedPlayers = allRows.reduce((sum, row) => sum + row.players.length, 0);
    const favoriteCount = allRows.filter(row => favorites.has(row.name)).length;

    root.innerHTML = `<section>
      <div class="sectionTitleRow"><div><h2>クラブ</h2><div class="lead">現在追跡中の日本人所属クラブ。移籍前の成績は新クラブへ付け替えません。</div></div><span class="pill">${esc(selectedSeason)}</span></div>
      <div class="summary clubSummary">
        <div class="sum"><div class="num">${allRows.length}</div><div class="muted">追跡クラブ</div></div>
        <div class="sum"><div class="num">${trackedPlayers}</div><div class="muted">現在所属日本人</div></div>
        <div class="sum"><div class="num">${favoriteCount}</div><div class="muted">お気に入り</div></div>
      </div>
    </section>
    <section>
      <h2>絞り込み</h2>
      <div class="scroll clubFilterRow">${['すべて', 'お気に入り'].map(mode => filterButton(mode, favoriteMode === mode, `data-club-favorite-mode="${esc(mode)}"`)).join('')}</div>
      <div class="scroll clubFilterRow">${leagues.map(league => filterButton(league, selectedLeague === league, `data-club-league="${esc(league)}"`)).join('')}</div>
      <div class="lead clubResultLead">${filtered.length}クラブを表示</div>
      <div class="grid clubDirectoryGrid">${filtered.map(row => clubCard(row, favorites)).join('') || '<div class="card favoriteEmpty"><div class="favoriteEmptyStar" aria-hidden="true">☆</div><div><div class="name">該当するクラブはありません</div><div class="reason">別のリーグを選ぶか、クラブ詳細からお気に入り登録してください。</div></div></div>'}</div>
    </section>`;

    bindControls(root);
    try { bindEntities(root); } catch {}
  }

  function installStyle() {
    if (document.getElementById('club-directory-style')) return;
    const style = document.createElement('style');
    style.id = 'club-directory-style';
    style.textContent = `
      .clubSummary{margin-top:12px}.clubFilterRow{margin-bottom:8px}.clubResultLead{margin:11px 0 9px}
      .clubDirectoryCard{position:relative;padding-right:66px;overflow:hidden}
      .clubCardHead{display:flex;align-items:center;gap:11px;min-height:48px}
      .clubMonogram{width:46px;height:46px;flex:0 0 46px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(145deg,#243653,#162137);border:1px solid #3b4d6b;color:var(--a);font-size:13px;font-weight:950;letter-spacing:-1px}
      .clubPills{margin-top:4px}.clubFavoritePill{color:var(--y);border-color:#fbbf2455}
      .clubPlayerNames{font-size:12px;line-height:1.55;color:#d8e1ed;margin-top:9px;min-height:38px}
      .clubMiniStats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:10px}
      .clubMiniStats>div{background:var(--p2);border:1px solid var(--l);border-radius:10px;padding:8px;text-align:center;min-width:0}
      .clubMiniStats b,.clubMiniStats span{display:block}.clubMiniStats b{font-size:18px;color:var(--a)}.clubMiniStats span{font-size:9px;color:var(--m);margin-top:2px}
      .clubMatchNote{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:8px}
      @media(min-width:720px){.clubDirectoryGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }

  function installView() {
    if (!pages.some(([key]) => key === 'clubs')) {
      const favoriteIndex = pages.findIndex(([key]) => key === 'favorites');
      pages.splice(favoriteIndex >= 0 ? favoriteIndex + 1 : 1, 0, ['clubs', 'クラブ']);
    }
    if (!document.getElementById('v-clubs')) {
      const view = document.createElement('div');
      view.id = 'v-clubs';
      view.className = 'view';
      view.innerHTML = '<div id="clubsRoot"></div>';
      const anchor = document.getElementById('v-favorites') || document.getElementById('v-home');
      anchor?.insertAdjacentElement('afterend', view);
    }
    R.clubsRoot = document.getElementById('clubsRoot');
  }

  function patchRenderAll() {
    const baseRenderAll = renderAll;
    renderAll = function() {
      baseRenderAll();
      renderClubs();
    };
  }

  function setFilters({ league = selectedLeague, favorites = favoriteMode } = {}) {
    selectedLeague = league;
    favoriteMode = favorites;
    renderClubs();
  }

  function start() {
    installStyle();
    installView();
    patchRenderAll();
    renderClubs();
    window.JFWClubs = { render: renderClubs, rows: clubRows, setFilters };
  }

  start();
})();
