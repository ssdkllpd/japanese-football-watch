const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHarness() {
  const elements = new Map();

  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.children = [];
      this._html = '';
      this.dataset = {};
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
      if (this._html.includes('id="clubsRoot"') && !elements.has('clubsRoot')) {
        const root = new Element();
        root.id = 'clubsRoot';
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

    querySelectorAll() {
      return [];
    }
  }

  for (const id of ['v-home', 'v-favorites']) {
    const element = new Element();
    element.id = id;
  }

  const players = [
    { name: '石渡ネルソン', club: 'STVV', league: 'ベルギー', stats: { goals: 1, assists: 1 } },
    { name: '小久保玲央ブライアン', club: 'STVV', league: 'ベルギー', stats: { goals: 0, assists: 0 } },
    { name: '上田綺世', club: 'フェイエノールト', league: 'エールディヴィジ', stats: { goals: 2, assists: null } }
  ];
  const favoriteData = { players: [], clubs: [{ name: 'STVV' }] };
  const head = new Element('head');
  const body = new Element('body');
  const context = {
    console,
    document: {
      head,
      body,
      createElement: tag => new Element(tag),
      getElementById: id => elements.get(id) || null,
      querySelector: selector => {
        if (selector === 'link[data-jfw-theme]') {
          return head.children.find(child => child.tagName === 'link' && child.dataset?.jfwTheme === 'true') || null;
        }
        if (selector === 'script[data-jfw-theme]') {
          return body.children.find(child => child.tagName === 'script' && child.dataset?.jfwTheme === 'true') || null;
        }
        return null;
      }
    },
    window: {
      JFWFavorites: {
        read: () => favoriteData,
        toggle() {}
      }
    },
    pages: [['home', 'トップ'], ['favorites', 'お気に入り'], ['featured', '注目試合']],
    R: {},
    D: { players, matches: [] },
    selectedSeason: '2026-27',
    order: ['すべて', 'エールディヴィジ', 'ベルギー'],
    E: value => String(value ?? ''),
    relevantClubMatches: club => club === 'STVV' ? [{ round: '第1節', ko: '2026-08-10 20:00' }] : [],
    bindEntities() {},
    renderAll() {}
  };

  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'clubs.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'clubs.js' });
  return { api: context.window.JFWClubs, context, elements };
}

test('club hub is added after favorites and aggregates tracked clubs', () => {
  const { api, context } = createHarness();
  assert.ok(api);
  assert.equal(context.pages[2][0], 'clubs');

  const rows = api.rows();
  assert.equal(rows.length, 2);
  const stvv = rows.find(row => row.name === 'STVV');
  assert.equal(stvv.players.length, 2);
  assert.equal(stvv.goals.value, 1);
  assert.equal(stvv.assists.value, 1);
  assert.equal(stvv.matches.length, 1);
});

test('league and favorite filters update the dedicated club view', () => {
  const { api, elements } = createHarness();
  const root = elements.get('clubsRoot');

  api.setFilters({ league: 'ベルギー', favorites: 'すべて' });
  assert.match(root.innerHTML, /STVV/);
  assert.doesNotMatch(root.innerHTML, /フェイエノールト/);

  api.setFilters({ league: 'すべて', favorites: 'お気に入り' });
  assert.match(root.innerHTML, /STVV/);
  assert.doesNotMatch(root.innerHTML, /フェイエノールト/);
  assert.match(root.innerHTML, /★ お気に入り/);
});
