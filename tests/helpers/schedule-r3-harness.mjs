export * from './schedule-r2-harness.mjs';
export const queueRows=ctx=>ctx.db.prepare('SELECT date_jst FROM date_index_repair_queue ORDER BY date_jst').all().map(row=>row.date_jst);
