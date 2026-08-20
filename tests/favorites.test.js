const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function createHarness() {
  const elements = new Map();

  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.dataset = {};
      this.className = '';
      this.children = [];
      this._html = '';
      this.classList = { add() {}, remove() {}, toggle() {} };
    }

    set id(value) {
      this._id = value;
      elements.set(value, this);
    }

    get id() {
      return this._id;
    }

    set innerHTML(value) {
      this._html = String(value);
      if (this._html.includes('id="favoritesRoot"') && !elements.has('favoritesRoot')) {
        const root = new Element();
        root.id = 'favoritesRoot';
      }
    }

    get innerHTML() {
      return this._html;
    }

    appendChild(element) {
      this.children.push(element);
      return element;
    }

    insertAdjacentElement(_position, element) {
      return this.appendChild(element);
    }

    querySelector() {
      return null;
    }

    querySelectorAll() {
      return [];
    }
  }

  for (const id of ['v-home', 'playerDetail', 'clubDetail']) {
    const element = new Element();
    element.id = id;
  }

  const main = new Element('main');
  const localStorage = new MemoryStorage();
  const player = {
    playerId: 'player-1',
    name: '石渡ネルソン',
    club: 'シント＝トロイデン',
    league: 'ベルギー',
    stats: { goals: 1, assists: 2 }
  };

  const context = {
    console: { log: console.log, error: console.error, warn() {} },
    localStorage,
    queueMicrotask,
    MutationObserver: class { observe() {} },
    document: {
      head: new Element('head'),
      createElement: tag => new Element(tag),
      getElementById: id => elements.get(id) || null,
      querySelector: selector => selector === 'main' ? main : null,
      querySelectorAll: () => []
    },
    window: { addEventListener() {} },
    pages: [['home', 'トップ']],
    R: {
      playerDetail: elements.get('playerDetail'),
      clubDetail: elements.get('clubDetail'),
      searchBox: { value: '' }
    },
    D: { players: [player] },
    page: 'home',
    activePlayer: null,
    activeClub: null,
    E: value => String(value ?? ''),
    playerRef: value => value.playerId || value.name,
    playerByRef: ref => String(ref) === player.playerId || String(ref) === player.name ? player : null,
    pcard: value => `<div class="card" data-open-player="${value.playerId}">${value.name}</div>`,
    renderAll() {},
    renderPlayerDetail() {},
    renderClubDetail() {},
    renderSearch() {},
    bindEntities() {}
  };

  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'favorites.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'favorites.js' });
  return { api: context.window.JFWFavorites, context, elements, localStorage, player };
}

test('players and clubs can be added, rendered, persisted, and removed', () => {
  const { api, context, elements, player } = createHarness();

  assert.ok(api);
  assert.equal(context.pages[1][0], 'favorites');

  api.toggle('player', player.playerId, player.name);
  api.toggle('club', player.club, player.club);

  let state = api.read();
  assert.equal(state.players.length, 1);
  assert.equal(state.players[0].club, player.club);
  assert.equal(state.clubs.length, 1);
  assert.equal(state.clubs[0].league, player.league);

  const rendered = elements.get('favoritesRoot').innerHTML;
  assert.match(rendered, new RegExp(player.name));
  assert.match(rendered, new RegExp(player.club));
  assert.match(rendered, /端末保存/);

  api.toggle('player', player.playerId, player.name);
  api.toggle('club', player.club, player.club);
  state = api.read();
  assert.equal(state.players.length, 0);
  assert.equal(state.clubs.length, 0);
});

test('legacy duplicates are normalized and corrupt storage falls back safely', () => {
  const { api, localStorage, player } = createHarness();

  localStorage.setItem('jfw-favorites-v1', JSON.stringify({
    players: [player.playerId, player.playerId],
    clubs: [player.club, player.club]
  }));
  let state = api.read();
  assert.equal(state.players.length, 1);
  assert.equal(state.clubs.length, 1);

  localStorage.setItem('jfw-favorites-v1', '{broken');
  state = api.read();
  assert.equal(state.players.length, 0);
  assert.equal(state.clubs.length, 0);
});
