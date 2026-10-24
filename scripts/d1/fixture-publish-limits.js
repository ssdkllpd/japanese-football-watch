'use strict';

const FIXTURE_PUBLISH_LIMITS = Object.freeze({
  events: 100,
  lineups: 2,
  appearances: 80,
  lineupEntries: 80,
  playerStats: 80,
  teamStats: 2,
  // Up to 29 per-player missing/not-applicable metrics plus lineup states.
  // These rows use json_each with one bound JSON value, not one SQL query per row.
  fieldStates: 80 * 32 + 2,
});

module.exports = { FIXTURE_PUBLISH_LIMITS };
