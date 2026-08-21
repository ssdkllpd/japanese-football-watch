(() => {
  'use strict';

  const VERSION = '1.0';
  const BASE = 6.0;
  const DISCIPLINE_FIELDS = ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals'];
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
  const isValue = x => x && x.state === 'value' && Number.isFinite(Number(x.value));
  const n = x => isValue(x) ? Number(x.value) : null;
  const isRatingValue = value => {
    if (value === null || value === undefined || value === '') return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 3.0 && numeric <= 10.0;
  };

  const CONFIG = {
    FW: {
      fields: [
        ['goals', 1.05, v => 1.05 * v],
        ['assists', 0.75, v => 0.75 * v],
        ['shotsOnTarget', 0.36, v => Math.min(0.12 * v, 0.36)],
        ['shots', 0.16, v => Math.min(0.04 * v, 0.16)],
        ['keyPasses', 0.36, v => Math.min(0.09 * v, 0.36)],
        ['dribbles', 0.28, v => Math.min(0.07 * v, 0.28)],
        ['duelWinRate', 0.25, v => clamp((v - 0.45) * 1.0, -0.25, 0.25)],
        ['bigChancesMissed', 0.30, v => Math.max(-0.25 * v, -0.50)]
      ]
    },
    MF: {
      fields: [
        ['goals', 0.90, v => 0.90 * v],
        ['assists', 0.80, v => 0.80 * v],
        ['keyPasses', 0.44, v => Math.min(0.11 * v, 0.44)],
        ['passCompletionRate', 0.30, v => clamp((v - 0.80) * 2.0, -0.30, 0.30)],
        ['tackles', 0.36, v => Math.min(0.09 * v, 0.36)],
        ['interceptions', 0.27, v => Math.min(0.09 * v, 0.27)],
        ['duelWinRate', 0.30, v => clamp((v - 0.50) * 1.2, -0.30, 0.30)],
        ['dribbles', 0.18, v => Math.min(0.06 * v, 0.18)],
        ['possessionsLost', 0.25, v => Math.max(-0.02 * Math.max(0, v - 12), -0.25)]
      ]
    },
    DF: {
      fields: [
        ['gaOnPitch', 0.90, v => Math.max(0.55 - 0.35 * v, -0.90)],
        ['tackles', 0.52, v => Math.min(0.13 * v, 0.52)],
        ['interceptions', 0.52, v => Math.min(0.13 * v, 0.52)],
        ['clearances', 0.35, v => Math.min(0.05 * v, 0.35)],
        ['blocks', 0.30, v => Math.min(0.10 * v, 0.30)],
        ['aerialWinRate', 0.35, v => clamp((v - 0.50) * 1.4, -0.35, 0.35)],
        ['duelWinRate', 0.30, v => clamp((v - 0.50) * 1.2, -0.30, 0.30)],
        ['dribbledPast', 0.36, v => Math.max(-0.12 * v, -0.36)],
        ['goals', 0.90, v => 0.90 * v],
        ['assists', 0.70, v => 0.70 * v]
      ]
    },
    GK: {
      fields: [
        ['gaOnPitch', 1.00, v => Math.max(0.60 - 0.40 * v, -1.00)],
        ['saves', 0.80, v => Math.min(0.16 * v, 0.80)],
        ['saveRate', 0.45, v => clamp((v - 0.70) * 1.5, -0.45, 0.45)],
        ['penaltiesSaved', 0.70, v => 0.70 * v],
        ['highClaims', 0.24, v => Math.min(0.06 * v, 0.24)],
        ['passCompletionRate', 0.20, v => clamp((v - 0.70) * 0.8, -0.20, 0.20)],
        ['errorsLeadingToGoal', 0.70, v => -0.70 * v]
      ]
    }
  };

  function derivedState(inputs, key) {
    if (inputs?.[key]?.state) return inputs[key];
    const rate = (wonKey, totalKey, threshold) => {
      const won = inputs?.[wonKey], total = inputs?.[totalKey];
      if (!isValue(total)) return { state: 'missing' };
      if (n(total) < threshold) return { state: 'notApplicable' };
      if (!isValue(won)) return { state: 'missing' };
      return { state: 'value', value: n(total) === 0 ? 0 : n(won) / n(total) };
    };
    if (key === 'duelWinRate') return rate('duelsWon', 'duelsTotal', 5);
    if (key === 'aerialWinRate') return rate('aerialDuelsWon', 'aerialDuelsTotal', 5);
    if (key === 'passCompletionRate') return rate('passesCompleted', 'passesAttempted', 20);
    if (key === 'saveRate') return rate('saves', 'shotsOnTargetFaced', 3);
    return inputs?.[key] || { state: 'missing' };
  }

  function fieldState(inputs, position, key) {
    if (key === 'passCompletionRate' && position === 'MF') {
      if (inputs?.passCompletionRate?.state) return inputs.passCompletionRate;
      const total = inputs?.passesAttempted;
      if (!isValue(total)) return { state: 'missing' };
      if (n(total) < 30) return { state: 'notApplicable' };
      const made = inputs?.passesCompleted;
      if (!isValue(made)) return { state: 'missing' };
      return { state: 'value', value: n(made) / n(total) };
    }
    return derivedState(inputs, key);
  }

  function discipline(inputs) {
    return -0.20 * n(inputs.yellowCards)
      -0.70 * n(inputs.secondYellowRed)
      -1.20 * n(inputs.straightRed)
      -0.50 * n(inputs.penaltiesConceded)
      -0.80 * n(inputs.ownGoals);
  }

  function confidence(c) {
    return c >= 0.75 ? 'high' : c >= 0.40 ? 'medium' : 'low';
  }

  function compute(inputs, position) {
    const pos = String(position || '').toUpperCase();
    const cfg = CONFIG[pos];
    if (!cfg) return { jfwRating: null, reason: 'unknown_position', ratingVersion: VERSION };
    if (!['minutes', 'goals', 'assists'].every(k => isValue(inputs?.[k]))) {
      return { jfwRating: null, reason: 'minimum_inputs_missing', ratingVersion: VERSION, ratingPosition: pos };
    }
    if (!DISCIPLINE_FIELDS.every(k => isValue(inputs?.[k]))) {
      return { jfwRating: null, reason: 'discipline_inputs_missing', ratingVersion: VERSION, ratingPosition: pos };
    }
    const minutes = n(inputs.minutes);
    if (!(minutes > 0)) return { jfwRating: null, reason: 'not_appeared', ratingVersion: VERSION, ratingPosition: pos };

    let numerator = 0, denominator = 0, perf = 0;
    const breakdown = [];
    for (const [key, weight, fn] of cfg.fields) {
      const state = fieldState(inputs, pos, key);
      if (state.state === 'notApplicable') continue;
      denominator += weight;
      if (state.state === 'value' && Number.isFinite(Number(state.value))) {
        numerator += weight;
        const value = Number(state.value);
        const points = fn(value);
        perf += points;
        breakdown.push({ key, value, points: round2(points) });
      }
    }
    const coverage = denominator > 0 ? numerator / denominator : 0;
    const kCov = 1.30 * coverage / (coverage + 0.30);
    const m = Math.min(90, Math.max(0, minutes));
    const kMin = 1.2222 * m / (m + 20);
    const disc = discipline(inputs);
    const rating = clamp(BASE + perf * kCov * kMin + disc, 3.0, 10.0);
    return {
      jfwRating: round2(rating),
      ratingVersion: VERSION,
      ratingPosition: pos,
      ratingCoverage: Math.round(coverage * 1000) / 1000,
      ratingConfidence: confidence(coverage),
      ratingFactors: { coverage: Math.round(kCov * 1000) / 1000, minutes: Math.round(kMin * 1000) / 1000 },
      deltaPerformance: round2(perf),
      deltaDiscipline: round2(disc),
      ratingBreakdown: breakdown
    };
  }

  function withComputedRating(record) {
    if (!record) return record;
    if (record.ratingVersion === VERSION && isRatingValue(record.jfwRating)) return record;
    if (!record.ratingInputs || !record.ratingPosition) return { ...record, jfwRating: undefined };
    const computed = compute(record.ratingInputs, record.ratingPosition);
    return {
      ...record,
      ...computed,
      jfwRating: isRatingValue(computed.jfwRating) ? Number(computed.jfwRating) : undefined
    };
  }

  function seasonSummary(records) {
    const all = (records || []).filter(r => Number(r?.minutes ?? r?.ratingInputs?.minutes?.value) > 0);
    const rated = all.map(withComputedRating).filter(r => r.ratingVersion === VERSION && isRatingValue(r.jfwRating));
    const weighted = rows => {
      let total = 0, mins = 0;
      for (const r of rows) {
        const m = Number(r.minutes ?? r.ratingInputs?.minutes?.value ?? 0);
        if (m > 0 && isRatingValue(r.jfwRating)) {
          total += Number(r.jfwRating) * m;
          mins += m;
        }
      }
      return mins ? round2(total / mins) : null;
    };
    const recentWindow = [...all].sort((a,b) => String(b.ko || '').localeCompare(String(a.ko || ''))).slice(0, 5);
    const recentRated = recentWindow.map(withComputedRating).filter(r => r.ratingVersion === VERSION && isRatingValue(r.jfwRating));
    const avgCoverage = rated.length ? rated.reduce((s,r) => s + Number(r.ratingCoverage || 0), 0) / rated.length : null;
    const avgMinutes = all.length ? all.reduce((s,r) => s + Number(r.minutes ?? r.ratingInputs?.minutes?.value ?? 0), 0) / all.length : null;
    return {
      average: weighted(rated),
      recentAverage: weighted(recentRated),
      ratedGames: rated.length,
      appearances: all.length,
      recentRatedGames: recentRated.length,
      recentAppearances: recentWindow.length,
      averageCoverage: avgCoverage == null ? null : Math.round(avgCoverage * 1000) / 1000,
      averageMinutes: avgMinutes == null ? null : Math.round(avgMinutes)
    };
  }

  function providerRatingValue(record, provider = 'apiFootball') {
    const direct = provider === 'apiFootball' ? record?.apiFootballRating : null;
    const value = record?.providerRatings?.[provider]?.value ?? direct;
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 10 ? numeric : null;
  }

  function playerRatingComparisonHtml(record) {
    const jfw = isRatingValue(record?.jfwRating) ? Number(record.jfwRating).toFixed(1) : '—';
    const api = providerRatingValue(record, 'apiFootball');
    const apiText = api == null ? '—' : api.toFixed(1);
    return `<div style="display:flex;gap:12px;align-items:flex-end;justify-content:flex-end;flex-wrap:wrap"><div><div class="sub">JFW</div><div class="metricValue">${jfw}</div></div><div><div class="sub">API-Football</div><div class="metricValue" style="color:var(--b)">${apiText}</div></div></div>`;
  }

  function installProviderRatingUi() {
    const original = window.playerRecordCard;
    if (typeof original !== 'function' || original.__jfwProviderRatings) return false;
    const wrapped = record => {
      const computed = withComputedRating(record);
      const html = original(computed);
      return html.replace(/<div class="metricValue">[\s\S]*?<\/div>/, playerRatingComparisonHtml(computed));
    };
    wrapped.__jfwProviderRatings = true;
    window.playerRecordCard = wrapped;
    try {
      if (typeof renderPlayerDetail === 'function' && typeof activePlayer !== 'undefined' && activePlayer) {
        renderPlayerDetail();
      }
    } catch {}
    return true;
  }

  window.JFWRating = {
    VERSION,
    compute,
    withComputedRating,
    seasonSummary,
    isRatingValue,
    providerRatingValue,
    playerRatingComparisonHtml,
    installProviderRatingUi
  };
})();

window.addEventListener('load', () => {
  try { window.JFWRating?.installProviderRatingUi?.(); } catch (error) {
    console.warn('provider rating UI install failed', error);
  }
  let tries = 0;
  const bootBackfill = () => {
    let ready = false;
    try { ready = typeof D !== 'undefined' && !!D && typeof loadSeason === 'function'; } catch {}
    if (!ready && tries++ < 100) { setTimeout(bootBackfill, 100); return; }
    if (document.querySelector('script[data-jfw-backfill]')) return;
    const script = document.createElement('script');
    script.src = `backfill-loader.js?v=${Date.now()}`;
    script.dataset.jfwBackfill = '1';
    script.onload = () => {
      try { window.JFWRating?.installProviderRatingUi?.(); } catch (error) {
        console.warn('provider rating UI reinstall after backfill failed', error);
      }
    };
    document.body.appendChild(script);
  };
  bootBackfill();
});
