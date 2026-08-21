(() => {
  'use strict';

  const STORAGE_KEY = 'jfw-theme-v1';
  const THEMES = new Set(['light', 'dark']);
  const THEME_COLORS = { light: '#f8fafc', dark: '#0b1020' };

  function readTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return THEMES.has(saved) ? saved : 'dark';
    } catch {
      return 'dark';
    }
  }

  function currentTheme() {
    const value = document.documentElement.dataset.theme;
    return THEMES.has(value) ? value : readTheme();
  }

  function updateThemeColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  }

  function paintControl(theme) {
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      const selected = button.dataset.themeChoice === theme;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  function applyTheme(theme, { persist = true } = {}) {
    const next = THEMES.has(theme) ? theme : 'dark';
    document.documentElement.dataset.theme = next;
    updateThemeColor(next);
    paintControl(next);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, next); } catch {}
    }
    return next;
  }

  function installControl() {
    const host = document.querySelector('.heroMeta');
    if (!host || document.getElementById('themeControl')) return;

    const box = document.createElement('div');
    box.id = 'themeControl';
    box.className = 'themeBox';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '表示テーマ');
    box.innerHTML = `
      <span class="themeLabel">表示</span>
      <span class="themeToggle">
        <button type="button" class="themeOption" data-theme-choice="light" aria-pressed="false" title="通常モード">☀ 通常</button>
        <button type="button" class="themeOption" data-theme-choice="dark" aria-pressed="false" title="ダークモード">🌙 ダーク</button>
      </span>`;

    host.appendChild(box);
    box.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
    });
    paintControl(currentTheme());
  }

  function start() {
    applyTheme(readTheme(), { persist: false });
    installControl();
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY) applyTheme(THEMES.has(event.newValue) ? event.newValue : 'dark', { persist: false });
    });
    window.JFWTheme = {
      get: currentTheme,
      set: theme => applyTheme(theme),
      storageKey: STORAGE_KEY
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
