const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRatingContext() {
  const context = {
    console,
    window: { addEventListener() {} },
    document: {},
    setTimeout,
    clearTimeout
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'jfw-rating.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'jfw-rating.js' });
  return context;
}

function loadRating() {
  return loadRatingContext().window.JFWRating;
}

function value(value) { return { state: 'value', value }; }
function missing() { return { state: 'missing' }; }

function cleanDiscipline() {
  return {
    yellowCards: value(0),
    secondYellowRed: value(0),
    straightRed: value(0),
    penaltiesConceded: value(0),
    ownGoals: value(0)
  };
}

test('unrated match is excluded instead of being coerced from null to zero', () => {
  const rating = loadRating();
  const shortAppearance = {
    ko: '2026-08-15 03:45',
    ratingPosition: 'DF',
    ratingInputs: {
      minutes: value(3), goals: value(0), assists: value(0), gaOnPitch: value(1),
      ...cleanDiscipline()
    }
  };
  const unratedFullMatch = {
    ko: '2026-08-20 20:00',
    ratingPosition: 'DF',
    ratingInputs: {
      minutes: value(90), goals: value(1), assists: missing(), gaOnPitch: value(0),
      yellowCards: missing(), secondYellowRed: missing(), straightRed: missing(),
      penaltiesConceded: missing(), ownGoals: missing()
    }
  };

  const first = rating.withComputedRating(shortAppearance);
  const second = rating.withComputedRating(unratedFullMatch);
  assert.ok(first.jfwRating >= 3 && first.jfwRating <= 10);
  assert.equal(second.jfwRating, undefined);
  assert.equal(second.reason, 'minimum_inputs_missing');

  const summary = rating.seasonSummary([shortAppearance, unratedFullMatch]);
  assert.equal(summary.appearances, 2);
  assert.equal(summary.ratedGames, 1);
  assert.ok(summary.average >= 3 && summary.average <= 10);
  assert.ok(summary.recentAverage >= 3 && summary.recentAverage <= 10);
});

test('same-version out-of-range cached rating is rejected and recomputed', () => {
  const rating = loadRating();
  const stale = {
    ratingVersion: '1.0',
    jfwRating: 0.2,
    ratingPosition: 'DF',
    ratingInputs: {
      minutes: value(90), goals: value(0), assists: value(0), gaOnPitch: value(0),
      ...cleanDiscipline()
    }
  };
  const fixed = rating.withComputedRating(stale);
  assert.notEqual(fixed.jfwRating, 0.2);
  assert.ok(fixed.jfwRating >= 3 && fixed.jfwRating <= 10);
});

test('rating validity guard accepts only the documented 3.0 to 10.0 range', () => {
  const rating = loadRating();
  assert.equal(rating.isRatingValue(null), false);
  assert.equal(rating.isRatingValue(undefined), false);
  assert.equal(rating.isRatingValue(0), false);
  assert.equal(rating.isRatingValue(0.2), false);
  assert.equal(rating.isRatingValue(2.99), false);
  assert.equal(rating.isRatingValue(3), true);
  assert.equal(rating.isRatingValue(10), true);
  assert.equal(rating.isRatingValue(10.01), false);
});

test('API-Football provider rating is read without converting missing data to zero', () => {
  const rating = loadRating();
  assert.equal(rating.providerRatingValue({ providerRatings: { apiFootball: { value: '7.6' } } }), 7.6);
  assert.equal(rating.providerRatingValue({ apiFootballRating: 6.8 }), 6.8);
  assert.equal(rating.providerRatingValue({ providerRatings: { apiFootball: { value: null } } }), null);
  assert.equal(rating.providerRatingValue({}), null);
});

test('player rating comparison renders JFW and API-Football side by side', () => {
  const rating = loadRating();
  const html = rating.playerRatingComparisonHtml({
    jfwRating: 7.4,
    providerRatings: { apiFootball: { value: 7.1 } }
  });
  assert.match(html, />JFW</);
  assert.match(html, />7\.4</);
  assert.match(html, />API-Football</);
  assert.match(html, />7\.1</);

  const missingApi = rating.playerRatingComparisonHtml({ jfwRating: 6.9 });
  assert.match(missingApi, />API-Football</);
  assert.match(missingApi, />—</);
});

test('player detail card renderer is wrapped once to expose provider rating', () => {
  const context = loadRatingContext();
  const rating = context.window.JFWRating;
  context.window.playerRecordCard = record =>
    `<div class="card"><div class="metricValue">${record.jfwRating ?? '—'}</div></div>`;

  assert.equal(rating.installProviderRatingUi(), true);
  assert.equal(rating.installProviderRatingUi(), false);

  const html = context.window.playerRecordCard({
    ratingVersion: '1.0',
    jfwRating: 7.4,
    providerRatings: { apiFootball: { value: 7.1 } }
  });
  assert.match(html, />JFW</);
  assert.match(html, />7\.4</);
  assert.match(html, />API-Football</);
  assert.match(html, />7\.1</);
});
