'use strict';

class LocalD1PreparedStatement {
  constructor(statement) {
    this.statement = statement;
    this.params = [];
  }

  bind(...params) {
    const bound = new LocalD1PreparedStatement(this.statement);
    bound.params = params;
    return bound;
  }

  async first(column) {
    const row = this.statement.get(...this.params) || null;
    if (row === null || column === undefined) return row;
    return row[column] ?? null;
  }

  async all() {
    return {
      success: true,
      results: this.statement.all(...this.params),
      meta: {},
    };
  }

  async run() {
    const result = this.statement.run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: Number(result.lastInsertRowid || 0),
      },
    };
  }
}

function createLocalD1(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A node:sqlite DatabaseSync instance is required.');
  }
  return {
    prepare(sql) {
      return new LocalD1PreparedStatement(database.prepare(sql));
    },
    async batch(statements) {
      const results = [];
      database.exec('BEGIN');
      try {
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

module.exports = { createLocalD1 };
