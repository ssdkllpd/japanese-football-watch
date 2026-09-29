'use strict';

const FREE_DAILY_DETAIL_CAP = 20;
const PAID_BOUNDED_DETAIL_CAP = 120;

function resolveDetailDailyCap(value = FREE_DAILY_DETAIL_CAP) {
  const cap = Number(value);
  if (![FREE_DAILY_DETAIL_CAP, PAID_BOUNDED_DETAIL_CAP].includes(cap)) {
    throw new Error('Manual fixture detail daily cap must be 20 or 120.');
  }
  return cap;
}

module.exports = { resolveDetailDailyCap };
