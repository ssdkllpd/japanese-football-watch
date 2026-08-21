(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const apiInput = $('apiBase');
  const dateInput = $('dateInput');
  const loadBtn = $('loadBtn');
  const message = $('message');
  const listView = $('listView');
  const detailView = $('detailView');

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    }[char]));
  }

  function todayJst() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function baseUrl() {
    return String(apiInput.value || '').trim().replace(/\/+$/, '');
  }

  function formatKickoff(value) {
    if (!value) return '時刻未取得';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '時刻未取得';
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  async function fetchJson(path) {
    const base = baseUrl();
    if (!base) throw new Error('Worker base URLを入力してください。');
    const response = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    return payload;
  }

  function statusClass(status) {
    return ['1H', 'HT', '2H', 'ET', 'LIVE', 'INT'].includes(String(status || '').toUpperCase()) ? ' live' : '';
  }

  function fixtureRow(row) {
    const home = row?.teams?.home || {};
    const away = row?.teams?.away || {};
    const homeScore = row?.score?.goals?.home;
    const awayScore = row?.score?.goals?.away;
    return `<div class="fixture" data-fixture-id="${esc(row.fixtureId)}">
      <div class="time">${esc(formatKickoff(row.kickoffUtc))}</div>
      <div class="teams">
        <div class="team"><span>${esc(home.name || home.id || 'Home')}</span><span class="score">${homeScore ?? '—'}</span></div>
        <div class="team"><span>${esc(away.name || away.id || 'Away')}</span><span class="score">${awayScore ?? '—'}</span></div>
      </div>
      <span class="status${statusClass(row?.status?.short)}">${esc(row?.status?.short || row?.ingestionState || '—')}</span>
    </div>`;
  }

  function renderIndex(index) {
    const rows = Array.isArray(index?.fixtures) ? index.fixtures : [];
    if (!rows.length) {
      listView.innerHTML = '<div class="notice">このJST日付のfixtureはまだR2 indexにありません。</div>';
      return;
    }
    const groups = new Map();
    for (const row of rows) {
      const key = row.competitionId || 'competition:unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    listView.innerHTML = [...groups.entries()].map(([competitionId, fixtures]) => `
      <section class="competition">
        <h2>${esc(competitionId)}</h2>
        <div class="card">${fixtures.map(fixtureRow).join('')}</div>
      </section>`).join('');
    listView.querySelectorAll('[data-fixture-id]').forEach(row => {
      row.addEventListener('click', () => openFixture(row.dataset.fixtureId));
    });
  }

  function pitchHtml(lineup) {
    const starters = Array.isArray(lineup?.startXI) ? lineup.startXI : [];
    if (!starters.length) return '<div class="notice">先発未取得</div>';
    const api = window.JFWFormation;
    const laidOut = api?.layoutPlayers ? api.layoutPlayers(starters, lineup?.formation) : starters;
    const meta = laidOut?.layoutMeta || { confidence: 'none' };
    const badge = meta.confidence === 'high' ? '' : '<span class="estimate">配置は推定</span>';
    return `<div class="card"><b>${esc(lineup?.formation || 'Formation未取得')}</b>${badge}
      <div class="pitch">${laidOut.map(player => `<div class="player" style="left:${Number(player.x) || 50}%;top:${Number(player.y) || 50}%"><span class="disc">${esc(player.number ?? '—')}</span><span>${esc(player.name || '選手')}</span></div>`).join('')}</div>
    </div>`;
  }

  function renderFixture(bundle) {
    const fixture = bundle?.fixture || {};
    const home = fixture?.teams?.home || {};
    const away = fixture?.teams?.away || {};
    const events = Array.isArray(bundle?.events) ? bundle.events : [];
    const lineups = Array.isArray(bundle?.lineups) ? bundle.lineups : [];
    detailView.innerHTML = `
      <div class="detailHead"><button class="back" type="button" id="backBtn">← 日付一覧</button><span class="status${statusClass(fixture?.status?.short)}">${esc(fixture?.status?.short || fixture?.ingestionState || '—')}</span></div>
      <div class="card">
        <div class="team"><b>${esc(home.name || home.id || 'Home')}</b><span class="score">${fixture?.score?.goals?.home ?? '—'}</span></div>
        <div class="team"><b>${esc(away.name || away.id || 'Away')}</b><span class="score">${fixture?.score?.goals?.away ?? '—'}</span></div>
        <div class="sub">${esc(fixture?.competitionId || '')} / ${esc(fixture?.seasonId || '')} / ${esc(formatKickoff(fixture?.kickoffUtc))} JST</div>
      </div>
      <section><h2>フォーメーション</h2>${lineups.map(pitchHtml).join('') || '<div class="notice">lineups未取得</div>'}</section>
      <section><h2>イベント</h2><div class="card events">${events.map(event => `<div class="event"><b>${event.elapsed ?? '—'}′</b><span>${esc(event.type)} ${esc(event.detail || '')}</span><span class="muted">${esc(event.playerId || '')}</span></div>`).join('') || 'events未取得'}</div></section>
      <section><h2>Core player stats</h2><div class="notice">${Array.isArray(bundle?.playerStats) ? bundle.playerStats.length : 0}件。日本人registryでフィルタしていません。</div></section>`;
    $('backBtn').addEventListener('click', () => {
      detailView.classList.add('hidden');
      listView.classList.remove('hidden');
    });
  }

  async function openFixture(fixtureId) {
    try {
      message.textContent = `${fixtureId} を読み込み中…`;
      const bundle = await fetchJson(`/api/v2/fixtures/${encodeURIComponent(fixtureId)}`);
      renderFixture(bundle);
      listView.classList.add('hidden');
      detailView.classList.remove('hidden');
      message.textContent = `R2 canonical bundle: ${fixtureId}`;
    } catch (error) {
      message.textContent = `取得失敗: ${error.message}`;
    }
  }

  async function loadDate() {
    const date = dateInput.value || todayJst();
    dateInput.value = date;
    const base = baseUrl();
    if (base) localStorage.setItem('jfw-v2-api-base', base);
    const url = new URL(location.href);
    if (base) url.searchParams.set('api', base);
    url.searchParams.set('date', date);
    history.replaceState(null, '', url.pathname + url.search);
    try {
      message.textContent = `${date} JST を読み込み中…`;
      const index = await fetchJson(`/api/v2/dates/${encodeURIComponent(date)}`);
      renderIndex(index);
      detailView.classList.add('hidden');
      listView.classList.remove('hidden');
      message.textContent = `${date} JST / ${index.fixtures?.length || 0}試合`;
    } catch (error) {
      listView.innerHTML = '';
      message.textContent = `取得失敗: ${error.message}`;
    }
  }

  const params = new URL(location.href).searchParams;
  apiInput.value = params.get('api') || localStorage.getItem('jfw-v2-api-base') || '';
  dateInput.value = params.get('date') || todayJst();
  loadBtn.addEventListener('click', loadDate);
  if (apiInput.value) loadDate();
})();
