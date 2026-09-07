/* History metadata belongs to an entry, including repeated visits to the same URL. */
(function(root) {
  'use strict';
  root.FootballV2History = function createHistory() {
    const field = 'footballV2';
    const fresh = (depth = 0, returnHash = null) => ({ key: crypto.randomUUID(), depth, returnHash, scrollY: 0 });
    function entry() {
      if (!history.state?.[field]) history.replaceState({ ...history.state, [field]: fresh() }, '');
      return history.state[field];
    }
    let active = entry();
    let target = active.scrollY;
    let restoring = false;
    history.scrollRestoration = 'manual';
    function save() {
      if (entry().key !== active.key || restoring) return;
      active = { ...active, scrollY: window.scrollY || 0 };
      history.replaceState({ ...history.state, [field]: active }, '');
    }
    function go(hash, { replace = false } = {}) {
      save();
      const next = replace ? active : fresh(active.depth + 1, location.hash);
      history[replace ? 'replaceState' : 'pushState']({ ...history.state, [field]: next }, '', `${location.pathname}${location.search}${hash}`);
      active = next;
      target = next.scrollY;
    }
    function activate() { active = entry(); target = active.scrollY; }
    function rendered() {
      if (target === null) return;
      const key = active.key;
      requestAnimationFrame(() => {
        if (entry().key !== key || target === null) return;
        restoring = true;
        window.scrollTo({ top: target, behavior: 'instant' });
        requestAnimationFrame(() => { restoring = false; });
      });
    }
    window.addEventListener('scroll', save, { passive: true });
    for (const event of ['wheel','touchstart','pointerdown','keydown']) window.addEventListener(event, () => { target = null; }, { passive: true });
    window.addEventListener('pagehide', save);
    return { go, activate, rendered, entry, back(fallback, apply) {
      if (entry().depth > 0) history.back();
      else { go(entry().returnHash || fallback, { replace: true }); apply(); }
    }};
  };
})(window);
