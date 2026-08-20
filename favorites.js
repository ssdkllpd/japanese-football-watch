(() => {
  'use strict';

  const STORAGE_KEY = 'jfw-favorites-v1';
  const EMPTY_STATE = Object.freeze({ players: [], clubs: [] });
  let decorateQueued = false;

  function esc(value) {
    return typeof E === 'function'
      ? E(value)
      : String(value ?? '').replace(/[&<>"']/g, char => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        })[char]);
  }

  function normalizePlayer(entry) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      return { id: String(entry), name: String(entry), club: '', league: '' };
    }
    if (!entry || (!entry.id && !entry.name)) return null;
    return {
      id: String(entry.id || entry.name),
      name: String(entry.name || entry.id),
      club: String(entry.club || ''),
      league: String(entry.league || ''),
      addedAt: entry.addedAt || null
    };
  }

  function normalizeClub(entry) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      return { name: String(entry), league: '' };
    }
    if (!entry || !entry.name) return null;
    return {
      name: String(entry.name),
      league: String(entry.league || ''),
      addedAt: entry.addedAt || null
    };
  }

  function uniqueBy(rows, keyOf) {
    const seen = new Set();
    return rows.filter(row => {
      const key = keyOf(row);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function readFavorites() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const players = uniqueBy((raw.players || []).map(normalizePlayer).filter(Boolean), p => p.id || p.name);
      const clubs = uniqueBy((raw.clubs || []).map(normalizeClub).filter(Boolean), c => c.name);
      return { players, clubs };
    } catch (error) {
      console.warn('お気に入りの読み込みに失敗しました', error);
      return { players: [...EMPTY_STATE.players], clubs: [...EMPTY_STATE.clubs] };
    }
  }

  function saveFavorites(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        players: state.players,
        clubs: state.clubs
      }));
      return true;
    } catch (error) {
      console.error('お気に入りの保存に失敗しました', error);
      return false;
    }
  }

  function currentPlayers() {
    try { return D?.players || []; } catch { return []; }
  }

  function resolvePlayer(entry) {
    try {
      return playerByRef(entry.id) || currentPlayers().find(player => player.name === entry.name) || null;
    } catch {
      return currentPlayers().find(player => player.name === entry.name) || null;
    }
  }

  function playerSnapshot(player) {
    return {
      id: String(playerRef(player)),
      name: player.name,
      club: player.club || '',
      league: player.league || '',
      addedAt: new Date().toISOString()
    };
  }

  function clubSnapshot(name) {
    const players = currentPlayers().filter(player => player.club === name);
    return {
      name,
      league: players[0]?.league || '',
      addedAt: new Date().toISOString()
    };
  }

  function favoritePlayerEntry(playerOrId, name = '') {
    const state = readFavorites();
    const id = typeof playerOrId === 'object' ? String(playerRef(playerOrId)) : String(playerOrId);
    const playerName = typeof playerOrId === 'object' ? playerOrId.name : name;
    return state.players.find(entry => entry.id === id || (playerName && entry.name === playerName)) || null;
  }

  function favoriteClubEntry(name) {
    return readFavorites().clubs.find(entry => entry.name === name) || null;
  }

  function controlMarkup(type, id, label, selected, variant = 'icon', name = '') {
    const addLabel = type === 'player' ? `${label}をお気に入り登録` : `${label}をお気に入り登録`;
    const removeLabel = type === 'player' ? `${label}のお気に入りを解除` : `${label}のお気に入りを解除`;
    const visible = variant === 'wide'
      ? `<span>${selected ? 'お気に入り済み' : 'お気に入り登録'}</span>`
      : '';
    return `<button type="button" class="favoritebtn favoritebtn--${variant} ${selected ? 'on' : ''}" data-favorite-type="${esc(type)}" data-favorite-id="${esc(id)}" data-favorite-name="${esc(name || label)}" aria-pressed="${selected}" aria-label="${esc(selected ? removeLabel : addLabel)}" title="${esc(selected ? removeLabel : addLabel)}"><span class="favoriteStar" aria-hidden="true">${selected ? '★' : '☆'}</span>${visible}</button>`;
  }

  function refreshCurrentView() {
    try { renderAll(); } catch (error) { console.error(error); }
    try {
      if (page === 'player') renderPlayerDetail();
      else if (page === 'club') renderClubDetail();
      else if (page === 'search' && R.searchBox.value.trim()) renderSearch();
      else if (page === 'match' && typeof window.renderMatchDetail === 'function') window.renderMatchDetail();
    } catch (error) {
      console.error(error);
    }
    decorateApp();
  }

  function toggleFavorite(type, id, savedName) {
    const state = readFavorites();

    if (type === 'player') {
      let player = null;
      try { player = playerByRef(id) || currentPlayers().find(p => p.name === savedName); } catch {}
      const name = player?.name || savedName;
      const index = state.players.findIndex(entry => entry.id === String(id) || (name && entry.name === name));
      if (index >= 0) state.players.splice(index, 1);
      else if (player) state.players.unshift(playerSnapshot(player));
      else return;
    } else if (type === 'club') {
      const name = savedName || id;
      const index = state.clubs.findIndex(entry => entry.name === name);
      if (index >= 0) state.clubs.splice(index, 1);
      else state.clubs.unshift(clubSnapshot(name));
    } else {
      return;
    }

    if (saveFavorites(state)) refreshCurrentView();
  }

  function bindFavoriteControls(root = document) {
    root.querySelectorAll('[data-favorite-type]:not([data-favorite-bound])').forEach(button => {
      button.dataset.favoriteBound = 'true';
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(button.dataset.favoriteType, button.dataset.favoriteId, button.dataset.favoriteName);
      });
    });
  }

  function currentClubDetails(name) {
    const players = currentPlayers().filter(player => player.club === name);
    return {
      available: players.length > 0,
      players,
      league: players[0]?.league || '',
      goals: players.reduce((total, player) => total + (player.stats?.goals || 0), 0),
      assists: players.reduce((total, player) => total + (player.stats?.assists || 0), 0)
    };
  }

  function favoriteClubCard(entry) {
    const details = currentClubDetails(entry.name);
    const league = details.league || entry.league || 'リーグ未取得';
    const content = details.available
      ? `<div class="sub">${esc(league)} ・ 日本人所属 ${details.players.length}人</div><div class="stats">今季 G ${details.goals} / A ${details.assists}</div>`
      : `<div class="sub">${esc(league)}</div><div class="stats part">このシーズンのクラブデータはありません</div>`;
    return `<div class="card favoriteClubCard ${details.available ? 'clickable' : 'favoriteUnavailable'}" ${details.available ? `data-open-club="${esc(entry.name)}"` : ''}><div class="row"><div class="rank favoriteRank" aria-hidden="true">★</div><div class="grow"><div class="name">${esc(entry.name)}</div>${content}</div></div>${controlMarkup('club', entry.name, entry.name, true, 'icon', entry.name)}</div>`;
  }

  function unavailablePlayerCard(entry) {
    return `<div class="card favoriteUnavailable"><div class="row"><div class="rank favoriteRank" aria-hidden="true">★</div><div class="grow"><div class="name">${esc(entry.name)}</div><div class="sub">${esc(entry.club || '所属クラブ未取得')}${entry.league ? ` ・ ${esc(entry.league)}` : ''}</div><div class="stats part">このシーズンの選手データはありません</div></div></div>${controlMarkup('player', entry.id, entry.name, true, 'icon', entry.name)}</div>`;
  }

  function renderFavorites() {
    const root = document.getElementById('favoritesRoot');
    if (!root) return;
    const state = readFavorites();
    const playerRows = state.players.map(entry => ({ entry, player: resolvePlayer(entry) }));
    const currentPlayerCards = playerRows.map(({ entry, player }) => player ? pcard(player) : unavailablePlayerCard(entry)).join('');
    const clubCards = state.clubs.map(favoriteClubCard).join('');
    const nothing = !state.players.length && !state.clubs.length;

    root.innerHTML = `<section>
      <div class="favoriteTitleRow"><div><h2>お気に入り</h2><div class="lead">登録した選手とクラブをまとめて確認。内容はこの端末のブラウザに保存されます。</div></div><span class="pill favoriteSavedPill">端末保存</span></div>
      <div class="favoriteSummary">
        <div class="sum"><div class="num">${state.clubs.length}</div><div class="muted">クラブ</div></div>
        <div class="sum"><div class="num">${state.players.length}</div><div class="muted">選手</div></div>
      </div>
      ${nothing ? '<div class="card favoriteEmpty"><div class="favoriteEmptyStar" aria-hidden="true">☆</div><div><div class="name">お気に入りはまだありません</div><div class="reason">選手カード、選手詳細、クラブ詳細にある☆から登録できます。</div></div></div>' : ''}
    </section>
    <section><div class="favoriteSectionHead"><h2>クラブ</h2><span class="muted">${state.clubs.length}件</span></div><div class="grid">${clubCards || '<div class="empty">お気に入りクラブは未登録です。</div>'}</div></section>
    <section><div class="favoriteSectionHead"><h2>選手</h2><span class="muted">${state.players.length}件</span></div><div class="grid">${currentPlayerCards || '<div class="empty">お気に入り選手は未登録です。</div>'}</div></section>`;

    bindFavoriteControls(root);
    try { bindEntities(root); } catch {}
    decoratePlayerCards(root);
  }

  function decoratePlayerCards(root = document) {
    root.querySelectorAll('.card[data-open-player]').forEach(card => {
      const ref = card.dataset.openPlayer;
      let player = null;
      try { player = playerByRef(ref); } catch {}
      if (!player) return;

      card.classList.add('favoriteDecorated');
      const existing = card.querySelector(':scope > [data-favorite-type="player"]');
      if (existing) return;
      card.insertAdjacentHTML('beforeend', controlMarkup('player', playerRef(player), player.name, !!favoritePlayerEntry(player), 'icon', player.name));
    });
    bindFavoriteControls(root);
  }

  function decorateDetails() {
    const playerHead = document.querySelector('#playerDetail .detailHead');
    if (playerHead && !playerHead.querySelector(':scope > .favoriteDetailControl')) {
      let player = null;
      try { player = playerByRef(activePlayer); } catch {}
      if (player) {
        const box = document.createElement('div');
        box.className = 'favoriteDetailControl';
        box.innerHTML = controlMarkup('player', playerRef(player), player.name, !!favoritePlayerEntry(player), 'wide', player.name);
        playerHead.appendChild(box);
      }
    }

    const clubHead = document.querySelector('#clubDetail .detailHead');
    if (clubHead && !clubHead.querySelector(':scope > .favoriteDetailControl')) {
      let club = '';
      try { club = activeClub || ''; } catch {}
      if (club) {
        const box = document.createElement('div');
        box.className = 'favoriteDetailControl';
        box.innerHTML = controlMarkup('club', club, club, !!favoriteClubEntry(club), 'wide', club);
        clubHead.appendChild(box);
      }
    }
    bindFavoriteControls(document);
  }

  function decorateApp() {
    const main = document.querySelector('main');
    if (!main) return;
    decoratePlayerCards(main);
    decorateDetails();
  }

  function queueDecoration() {
    if (decorateQueued) return;
    decorateQueued = true;
    queueMicrotask(() => {
      decorateQueued = false;
      decorateApp();
    });
  }

  function installStyle() {
    if (document.getElementById('favorite-style')) return;
    const style = document.createElement('style');
    style.id = 'favorite-style';
    style.textContent = `
      .favoriteTitleRow,.favoriteSectionHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .favoriteSummary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-width:430px;margin-top:12px}
      .favoriteSavedPill{margin:0;color:var(--a);border-color:#5eead455}
      .favoritebtn{min-height:42px;border:1px solid #3a4761;background:#141d31;color:#dce5f2;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-weight:850;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease,transform .15s ease}
      .favoritebtn:hover{border-color:var(--y);transform:translateY(-1px)}
      .favoritebtn:focus-visible{outline:3px solid #60a5fa88;outline-offset:2px}
      .favoritebtn.on{border-color:#fbbf2477;background:#34280f;color:#fde68a}
      .favoritebtn--icon{position:absolute;right:12px;top:12px;width:42px;padding:0;font-size:21px;z-index:2}
      .favoritebtn--wide{position:static;padding:9px 13px;white-space:nowrap}
      .favoriteStar{line-height:1;font-size:20px}
      .favoriteDecorated,.favoriteClubCard,.favoriteUnavailable{position:relative;padding-right:66px}
      .favoriteDetailControl{margin-left:auto}
      .favoriteRank{color:var(--y)}
      .favoriteUnavailable{opacity:.78}
      .favoriteEmpty{display:flex;gap:13px;align-items:center;margin-top:12px;border-style:dashed}
      .favoriteEmptyStar{min-width:44px;height:44px;border-radius:12px;background:var(--p2);display:grid;place-items:center;color:var(--y);font-size:25px}
      @media(max-width:540px){
        .favoriteDetailControl{width:100%;margin-left:0}
        .favoriteDetailControl .favoritebtn{width:100%}
        .favoriteTitleRow{align-items:center}
      }
    `;
    document.head.appendChild(style);
  }

  function installView() {
    if (!pages.some(([key]) => key === 'favorites')) pages.splice(1, 0, ['favorites', 'お気に入り']);
    if (!document.getElementById('v-favorites')) {
      const view = document.createElement('div');
      view.id = 'v-favorites';
      view.className = 'view';
      view.innerHTML = '<div id="favoritesRoot"></div>';
      const home = document.getElementById('v-home');
      home?.insertAdjacentElement('afterend', view);
    }
    R.favoritesRoot = document.getElementById('favoritesRoot');
  }

  function patchRenders() {
    const baseRenderAll = renderAll;
    renderAll = function() {
      baseRenderAll();
      renderFavorites();
      decorateApp();
    };

    const basePlayerDetail = renderPlayerDetail;
    renderPlayerDetail = function() {
      basePlayerDetail();
      decorateDetails();
      decoratePlayerCards(R.playerDetail);
    };

    const baseClubDetail = renderClubDetail;
    renderClubDetail = function() {
      baseClubDetail();
      decorateDetails();
      decoratePlayerCards(R.clubDetail);
    };
  }

  function start() {
    installStyle();
    installView();
    patchRenders();
    renderFavorites();
    decorateApp();

    const main = document.querySelector('main');
    if (main) new MutationObserver(queueDecoration).observe(main, { childList: true, subtree: true });
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY) refreshCurrentView();
    });
    window.JFWFavorites = { read: readFavorites, toggle: toggleFavorite };
  }

  start();
})();
