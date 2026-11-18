import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { QueryResultRow } from 'pg';
import { PGlite } from '@electric-sql/pglite';

interface AggregatorQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

class AggregatorDatabase {
  private pool: Pool | null = null;
  private embedded: PGlite | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (process.env.DATABASE_URL) {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required in production.');
    } else {
      const dataDirectory = resolve(process.cwd(), '.data');
      mkdirSync(dataDirectory, { recursive: true });
      this.embedded = new PGlite(resolve(dataDirectory, 'aggregator'));
    }

    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    try {
      if (this.pool) {
        await this.pool.query(schema);
      } else if (this.embedded) {
        await this.embedded.exec(schema);
      }
      this.initialized = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<AggregatorQueryResult<T>> {
    if (!this.initialized) {
      throw new Error('Aggregator database has not been initialized.');
    }
    return this.execute<T>(text, values);
  }

  async close(): Promise<void> {
    const pool = this.pool;
    const embedded = this.embedded;
    this.pool = null;
    this.embedded = null;
    this.initialized = false;
    if (pool) await pool.end();
    if (embedded) await embedded.close();
  }

  private async execute<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<AggregatorQueryResult<T>> {
    if (this.pool) return this.pool.query<T>(text, values);
    if (this.embedded) {
      const result = await this.embedded.query<T>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? null };
    }
    throw new Error('Aggregator database connection is unavailable.');
  }
}

export const aggregatorDb = new AggregatorDatabase();
