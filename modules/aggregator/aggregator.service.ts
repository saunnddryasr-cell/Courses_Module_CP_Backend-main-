import type { QueryResultRow } from 'pg';
import { AppError } from '../../shared/errors/app-error.js';
import { aggregatorDb } from './database.js';
import { decryptSourceAuth, encryptSourceAuth } from './crypto.js';
import {
  fetchSourceRecords,
  FieldMapping,
  normalizeManualRecords,
  NormalizedRecord,
  previewSourceRecord,
  SourceConfig,
  SourceType,
} from './connectors.js';
import { AggregatorPlatform, formatPost } from './formatter.js';

type PublishMode = 'manual_approval' | 'auto_publish';
type PostStatus = 'pending' | 'approved' | 'rejected' | 'published';

interface SourceRow extends QueryResultRow {
  id: number;
  source_key: string;
  category: string;
  type: SourceType;
  base_url: string | null;
  auth_config: string | null;
  field_mapping: FieldMapping;
  poll_frequency_minutes: number;
  enabled: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  last_alerted_at: string | null;
  created_at: string;
}

interface SourceInput {
  source_key: string;
  category: string;
  type: SourceType;
  base_url?: string | null;
  auth_config?: Record<string, unknown> | null;
  field_mapping: FieldMapping;
  poll_frequency_minutes?: number;
  enabled?: boolean;
}

interface PostRow extends QueryResultRow {
  id: number;
  raw_record_id: number;
  platform: AggregatorPlatform;
  body_text: string;
  status: PostStatus;
  category: string;
  title: string;
  org: string | null;
  description: string | null;
  deadline: string | null;
  link: string;
  location: string | null;
  eligibility: string | null;
  tags: string[];
}

interface ContractPostRow extends QueryResultRow {
  post_id: number;
  raw_id: number;
  source_id: number;
  category: string;
  title: string;
  org: string | null;
  description: string | null;
  deadline: string | null;
  link: string;
  location: string | null;
  eligibility: string | null;
  tags: string[];
  content_hash: string;
  scraped_at: string;
  platform: AggregatorPlatform;
  body_text: string;
  status: PostStatus;
  edited_by: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

interface ManualEntryInput {
  category: string;
  title: string;
  org?: string | null;
  description?: string | null;
  deadline?: string | null;
  link: string;
  location?: string | null;
  eligibility?: string | null;
}

function publicSource(source: SourceRow): Pick<
  SourceRow,
  | 'id'
  | 'source_key'
  | 'category'
  | 'type'
  | 'base_url'
  | 'field_mapping'
  | 'poll_frequency_minutes'
  | 'enabled'
  | 'last_run_at'
  | 'last_success_at'
  | 'consecutive_failures'
  | 'last_error'
  | 'last_alerted_at'
  | 'created_at'
> & { has_auth: boolean } {
  const { auth_config, ...rest } = source;
  return { ...rest, has_auth: Boolean(auth_config) };
}

function validateSource(input: SourceInput): void {
  if (typeof input.source_key !== 'string') throw new AppError('source_key is required.');
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(input.source_key)) {
    throw new AppError('source_key must be 2-64 letters, digits, underscores, or hyphens.');
  }
  if (typeof input.category !== 'string' || !input.category.trim()) throw new AppError('category is required.');
  if (!['api', 'rss', 'scrape', 'manual'].includes(input.type)) throw new AppError('Unsupported source type.');
  if (input.base_url !== undefined && input.base_url !== null && typeof input.base_url !== 'string') {
    throw new AppError('base_url must be a string or null.');
  }
  if (input.type !== 'manual' && !input.base_url?.trim()) {
    throw new AppError('base_url is required for API, RSS, and scrape sources.');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new AppError('enabled must be a boolean.');
  }
  if (input.type === 'scrape' && input.enabled) {
    throw new AppError('Scrape sources cannot be enabled until a site-specific connector and Terms of Service review are in place.');
  }
  if (!input.field_mapping || typeof input.field_mapping !== 'object' || Array.isArray(input.field_mapping)) {
    throw new AppError('field_mapping must be a JSON object.');
  }
  for (const [field, rule] of Object.entries(input.field_mapping)) {
    if (typeof rule === 'string') {
      if (!rule.trim()) throw new AppError(`field_mapping.${field} path cannot be empty.`);
      continue;
    }
    if (!rule || typeof rule !== 'object' || typeof rule.path !== 'string' || !rule.path.trim()) {
      throw new AppError(`field_mapping.${field} must be a path string or a rule with a path.`);
    }
    if (rule.transform !== undefined && !['strip_html', 'date', 'split_csv'].includes(rule.transform)) {
      throw new AppError(`field_mapping.${field} has an unsupported transform.`);
    }
    if (rule.value_map !== undefined
      && (!rule.value_map || typeof rule.value_map !== 'object' || Array.isArray(rule.value_map))) {
      throw new AppError(`field_mapping.${field}.value_map must be an object.`);
    }
  }
  for (const requiredField of ['title', 'link']) {
    if (!input.field_mapping[requiredField]) {
      throw new AppError(`field_mapping.${requiredField} is required.`);
    }
  }
  if (input.poll_frequency_minutes !== undefined
    && (!Number.isInteger(input.poll_frequency_minutes) || input.poll_frequency_minutes < 5 || input.poll_frequency_minutes > 10080)) {
    throw new AppError('poll_frequency_minutes must be an integer from 5 to 10080.');
  }
  if (input.auth_config !== undefined && input.auth_config !== null
    && (typeof input.auth_config !== 'object' || Array.isArray(input.auth_config))) {
    throw new AppError('auth_config must be a JSON object.');
  }
}

function connectorConfig(source: SourceRow): SourceConfig {
  return {
    id: source.id,
    source_key: source.source_key,
    category: source.category,
    type: source.type,
    base_url: source.base_url,
    field_mapping: source.field_mapping,
    auth_config: decryptSourceAuth(source.auth_config),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown connector error.';
}

function contractPost(row: ContractPostRow) {
  return {
    id: row.post_id,
    raw_record: {
      id: row.raw_id,
      source_id: row.source_id,
      category: row.category,
      title: row.title,
      org: row.org,
      description: row.description,
      deadline: row.deadline,
      link: row.link,
      location: row.location,
      eligibility: row.eligibility,
      tags: row.tags,
      content_hash: row.content_hash,
      scraped_at: row.scraped_at,
    },
    platform: row.platform,
    body_text: row.body_text,
    status: row.status,
    edited_by: row.edited_by,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewed_by,
  };
}

export class AggregatorService {
  private static pageLimit(limit: number): number {
    return Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  }

  private static pageOffset(offset: number): number {
    return Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0;
  }

  static async listSourcesPage(limit: number, offset: number) {
    const safeLimit = this.pageLimit(limit);
    const safeOffset = this.pageOffset(offset);
    const [sources, count] = await Promise.all([
      aggregatorDb.query<SourceRow>('SELECT * FROM sources ORDER BY id LIMIT $1 OFFSET $2', [safeLimit, safeOffset]),
      aggregatorDb.query<{ total: string } & QueryResultRow>('SELECT count(*)::text AS total FROM sources'),
    ]);
    return { sources: sources.rows.map(publicSource), total: Number(count.rows[0].total) };
  }

  static async listCategorySettings(limit: number, offset: number) {
    const safeLimit = this.pageLimit(limit);
    const safeOffset = this.pageOffset(offset);
    const count = await aggregatorDb.query<{ total: string } & QueryResultRow>(
      `SELECT count(*)::text AS total FROM (
         SELECT category FROM sources UNION SELECT category FROM category_publish_settings
       ) categories`
    );
    const result = await aggregatorDb.query(
      `SELECT categories.category,
          COALESCE(settings.publish_mode, 'manual_approval') AS publish_mode
       FROM (
         SELECT category FROM sources UNION SELECT category FROM category_publish_settings
       ) categories
       LEFT JOIN category_publish_settings settings ON settings.category = categories.category
       ORDER BY categories.category LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset]
    );
    return { categories: result.rows, total: Number(count.rows[0].total) };
  }

  static async listSources() {
    const result = await aggregatorDb.query<SourceRow>('SELECT * FROM sources ORDER BY id');
    return result.rows.map(publicSource);
  }

  static async getSource(id: number) {
    const source = await this.findSource(id);
    return publicSource(source);
  }

  static async createSource(input: SourceInput) {
    validateSource(input);
    const auth = encryptSourceAuth(input.auth_config);
    const result = await aggregatorDb.query<SourceRow>(
      `INSERT INTO sources
        (source_key, category, type, base_url, auth_config, field_mapping, poll_frequency_minutes, enabled)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
      [
        input.source_key,
        input.category.trim(),
        input.type,
        input.base_url?.trim() || null,
        auth,
        JSON.stringify(input.field_mapping),
        input.poll_frequency_minutes ?? 240,
        input.enabled ?? false,
      ]
    );
    return publicSource(result.rows[0]);
  }

  static async updateSource(id: number, patch: Partial<SourceInput>) {
    const current = await this.findSource(id);
    const next: SourceInput = {
      source_key: patch.source_key ?? current.source_key,
      category: patch.category ?? current.category,
      type: patch.type ?? current.type,
      base_url: patch.base_url === undefined ? current.base_url : patch.base_url,
      field_mapping: patch.field_mapping ?? current.field_mapping,
      poll_frequency_minutes: patch.poll_frequency_minutes ?? current.poll_frequency_minutes,
      enabled: patch.enabled ?? current.enabled,
    };
    validateSource(next);

    const auth = patch.auth_config === undefined
      ? current.auth_config
      : encryptSourceAuth(patch.auth_config);
    const result = await aggregatorDb.query<SourceRow>(
      `UPDATE sources SET
        source_key = $2, category = $3, type = $4, base_url = $5, auth_config = $6,
        field_mapping = $7::jsonb, poll_frequency_minutes = $8, enabled = $9
       WHERE id = $1 RETURNING *`,
      [
        id,
        next.source_key,
        next.category.trim(),
        next.type,
        next.base_url?.trim() || null,
        auth,
        JSON.stringify(next.field_mapping),
        next.poll_frequency_minutes ?? 240,
        next.enabled ?? false,
      ]
    );
    return publicSource(result.rows[0]);
  }

  static async deleteSource(id: number) {
    const result = await aggregatorDb.query<SourceRow>(
      'UPDATE sources SET enabled = FALSE WHERE id = $1 RETURNING *',
      [id]
    );
    if (!result.rows[0]) throw new AppError('Source not found.', 404);
    return publicSource(result.rows[0]);
  }

  static async previewSource(input: SourceInput, manualRecords?: unknown[]) {
    validateSource(input);
    const source: SourceConfig = {
      source_key: input.source_key,
      category: input.category,
      type: input.type,
      base_url: input.base_url ?? null,
      field_mapping: input.field_mapping,
      auth_config: input.auth_config,
    };
    const records = input.type === 'manual'
      ? normalizeManualRecords(source, manualRecords ?? [])
      : await fetchSourceRecords(source);
    return records.slice(0, 3);
  }

  static async previewSavedSource(id: number) {
    const source = await this.findSource(id);
    if (source.type === 'manual') {
      throw new AppError('Manual sources do not fetch records to preview.', 400);
    }
    return previewSourceRecord(connectorConfig(source));
  }

  static async runSource(id: number, manualRecords?: unknown[]) {
    const source = await this.findSource(id);
    await aggregatorDb.query('UPDATE sources SET last_run_at = now() WHERE id = $1', [id]);
    const run = await aggregatorDb.query<{ id: number } & QueryResultRow>(
      'INSERT INTO source_runs (source_id) VALUES ($1) RETURNING id',
      [id]
    );
    const runId = run.rows[0].id;
    let fetched = 0;
    let inserted = 0;
    try {
      const config = connectorConfig(source);
      const records = source.type === 'manual'
        ? normalizeManualRecords(config, manualRecords ?? [])
        : await fetchSourceRecords(config);
      if (records.length > 500) throw new AppError('A source run cannot ingest more than 500 records.');
      fetched = records.length;

      for (const record of records) {
        const saved = await this.saveRecord(source.id, record);
        if (saved.inserted) inserted += 1;
        await this.createPosts(saved.record);
      }

      await aggregatorDb.query(
        `UPDATE sources SET last_success_at = now(), consecutive_failures = 0,
          last_error = NULL, last_alerted_at = NULL WHERE id = $1`,
        [id]
      );
      await aggregatorDb.query(
        `UPDATE source_runs SET status = 'succeeded', finished_at = now(),
          records_fetched = $2, records_inserted = $3 WHERE id = $1`,
        [runId, fetched, inserted]
      );
      return { run_id: runId, source_id: id, fetched, inserted };
    } catch (error) {
      await aggregatorDb.query(
        `UPDATE sources SET consecutive_failures = consecutive_failures + 1,
          last_error = $2 WHERE id = $1`,
        [id, errorText(error).slice(0, 1000)]
      );
      await aggregatorDb.query(
        `UPDATE source_runs SET status = 'failed', finished_at = now(),
          records_fetched = $2, records_inserted = $3, error_message = $4 WHERE id = $1`,
        [runId, fetched, inserted, errorText(error).slice(0, 1000)]
      );
      throw error;
    }
  }

  static async listSourceRuns(limit = 100) {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const result = await aggregatorDb.query(
      `SELECT r.*, s.source_key FROM source_runs r
       JOIN sources s ON s.id = r.source_id
       ORDER BY r.started_at DESC LIMIT $1`,
      [safeLimit]
    );
    return result.rows;
  }

  static async listRecords(limit = 100) {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const result = await aggregatorDb.query(
      `SELECT r.*, s.source_key FROM raw_records r
       JOIN sources s ON s.id = r.source_id
       ORDER BY r.scraped_at DESC LIMIT $1`,
      [safeLimit]
    );
    return result.rows;
  }

  static async listPosts(status?: string, limit = 100) {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const values: unknown[] = [];
    let statusClause = '';
    if (status) {
      if (!['pending', 'approved', 'rejected', 'published'].includes(status)) {
        throw new AppError('status must be pending, approved, rejected, or published.');
      }
      values.push(status);
      statusClause = 'WHERE p.status = $1';
    }
    values.push(safeLimit);
    const result = await aggregatorDb.query(
      `SELECT p.*, r.category, r.title, r.link
       FROM formatted_posts p JOIN raw_records r ON r.id = p.raw_record_id
       ${statusClause}
       ORDER BY p.created_at DESC LIMIT $${values.length}`,
      values
    );
    return result.rows;
  }

  static async listContractPosts(status: string | undefined, category: string | undefined, limit: number, offset: number) {
    const safeLimit = this.pageLimit(limit);
    const safeOffset = this.pageOffset(offset);
    if (status && !['pending', 'approved', 'rejected', 'published'].includes(status)) {
      throw new AppError('status must be pending, approved, rejected, or published.');
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    if (status) {
      values.push(status);
      conditions.push(`p.status = $${values.length}`);
    }
    if (category) {
      values.push(category);
      conditions.push(`r.category = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await aggregatorDb.query<{ total: string } & QueryResultRow>(
      `SELECT count(*)::text AS total FROM formatted_posts p
       JOIN raw_records r ON r.id = p.raw_record_id ${where}`,
      values
    );
    const pageValues = [...values, safeLimit, safeOffset];
    const result = await aggregatorDb.query<ContractPostRow>(
      `SELECT p.id AS post_id, p.raw_record_id, p.platform, p.body_text, p.status,
          p.edited_by, p.created_at, p.reviewed_at, p.reviewed_by,
          r.id AS raw_id, r.source_id, r.category, r.title, r.org, r.description,
          r.deadline, r.link, r.location, r.eligibility, r.tags, r.content_hash, r.scraped_at
       FROM formatted_posts p JOIN raw_records r ON r.id = p.raw_record_id
       ${where} ORDER BY p.created_at DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues
    );
    return {
      posts: result.rows.map(contractPost),
      total: Number(countResult.rows[0].total),
    };
  }

  static async getContractPost(id: number) {
    const result = await aggregatorDb.query<ContractPostRow>(
      `SELECT p.id AS post_id, p.raw_record_id, p.platform, p.body_text, p.status,
          p.edited_by, p.created_at, p.reviewed_at, p.reviewed_by,
          r.id AS raw_id, r.source_id, r.category, r.title, r.org, r.description,
          r.deadline, r.link, r.location, r.eligibility, r.tags, r.content_hash, r.scraped_at
       FROM formatted_posts p JOIN raw_records r ON r.id = p.raw_record_id
       WHERE p.id = $1`,
      [id]
    );
    if (!result.rows[0]) throw new AppError('Post not found.', 404);
    return contractPost(result.rows[0]);
  }

  static async updatePostBody(id: number, bodyText: string, editorId: string) {
    if (typeof bodyText !== 'string' || bodyText.trim().length === 0 || bodyText.length > 10000) {
      throw new AppError('body_text must contain 1-10000 characters.');
    }
    const result = await aggregatorDb.query(
      `UPDATE formatted_posts SET body_text = $2, edited_by = $3
       WHERE id = $1 AND status IN ('pending', 'approved') RETURNING id`,
      [id, bodyText.trim(), editorId]
    );
    if (!result.rows[0]) throw new AppError('Post not found or can no longer be edited.', 404);
    return this.getContractPost(id);
  }

  static async approveContractPost(id: number, reviewerId: string) {
    const approved = await this.reviewPost(id, 'approved', undefined, reviewerId);
    if (approved.platform === 'telegram') {
      try {
        await this.publishPost(id, reviewerId);
      } catch (error) {
        await aggregatorDb.query(
          'UPDATE formatted_posts SET publication_error = $2 WHERE id = $1',
          [id, errorText(error).slice(0, 1000)]
        );
        throw error;
      }
    }
    return this.getContractPost(id);
  }

  static async rejectContractPost(id: number, reviewerId: string) {
    await this.reviewPost(id, 'rejected', undefined, reviewerId);
    return this.getContractPost(id);
  }

  static async createManualEntry(input: ManualEntryInput) {
    if (typeof input.category !== 'string' || !input.category.trim()) throw new AppError('category is required.');
    if (typeof input.title !== 'string' || !input.title.trim()) throw new AppError('title is required.');
    if (typeof input.link !== 'string' || !input.link.trim()) throw new AppError('link is required.');
    const fieldMapping: FieldMapping = {
      category: 'category',
      title: 'title',
      org: 'org',
      description: 'description',
      deadline: 'deadline',
      link: 'link',
      location: 'location',
      eligibility: 'eligibility',
    };
    await aggregatorDb.query(
      `INSERT INTO sources (source_key, category, type, field_mapping, enabled)
       VALUES ('manual_entries', 'manual', 'manual', $1::jsonb, FALSE)
       ON CONFLICT (source_key) DO NOTHING`,
      [JSON.stringify(fieldMapping)]
    );
    const sourceResult = await aggregatorDb.query<SourceRow>(
      'SELECT * FROM sources WHERE source_key = $1',
      ['manual_entries']
    );
    const source = sourceResult.rows[0];
    if (!source || source.type !== 'manual') {
      throw new AppError('Manual entry source key is already assigned to an incompatible source.', 409);
    }
    const normalized = normalizeManualRecords(connectorConfig(source), [{ ...input, category: input.category.trim() }]);
    const saved = await this.saveRecord(source.id, normalized[0]);
    await this.createPosts(saved.record);
    const record = await aggregatorDb.query(
      'SELECT * FROM raw_records WHERE id = $1',
      [saved.record.id]
    );
    return record.rows[0];
  }

  static async listPublishLogs(limit = 100) {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const result = await aggregatorDb.query(
      `SELECT l.*, p.body_text, r.category, r.title
       FROM publish_log l
       JOIN formatted_posts p ON p.id = l.formatted_post_id
       JOIN raw_records r ON r.id = p.raw_record_id
       ORDER BY l.published_at DESC LIMIT $1`,
      [safeLimit]
    );
    return result.rows;
  }

  static async listContractPublishLogs(
    category: string | undefined,
    from: string | undefined,
    to: string | undefined,
    limit: number,
    offset: number
  ) {
    const safeLimit = this.pageLimit(limit);
    const safeOffset = this.pageOffset(offset);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (category) {
      values.push(category);
      conditions.push(`r.category = $${values.length}`);
    }
    if (from) {
      values.push(from);
      conditions.push(`l.published_at >= $${values.length}::timestamptz`);
    }
    if (to) {
      values.push(to);
      conditions.push(`l.published_at < ($${values.length}::date + interval '1 day')`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await aggregatorDb.query<{ total: string } & QueryResultRow>(
      `SELECT count(*)::text AS total FROM publish_log l
       JOIN formatted_posts p ON p.id = l.formatted_post_id
       JOIN raw_records r ON r.id = p.raw_record_id ${where}`,
      values
    );
    const pageValues = [...values, safeLimit, safeOffset];
    const result = await aggregatorDb.query(
      `SELECT l.id, l.platform, l.published_at, l.published_by, l.channel_id,
          p.id AS post_id, p.raw_record_id, p.body_text, p.status,
          r.id AS raw_id, r.source_id, r.category, r.title, r.org, r.description,
          r.deadline, r.link, r.location, r.eligibility, r.tags, r.content_hash, r.scraped_at
       FROM publish_log l
       JOIN formatted_posts p ON p.id = l.formatted_post_id
       JOIN raw_records r ON r.id = p.raw_record_id
       ${where}
       ORDER BY l.published_at DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues
    );
    return {
      entries: result.rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        published_at: row.published_at,
        published_by: row.published_by,
        channel_id: row.channel_id,
        post: {
          id: row.post_id,
          raw_record: {
            id: row.raw_id,
            source_id: row.source_id,
            category: row.category,
            title: row.title,
            org: row.org,
            description: row.description,
            deadline: row.deadline,
            link: row.link,
            location: row.location,
            eligibility: row.eligibility,
            tags: row.tags,
            content_hash: row.content_hash,
            scraped_at: row.scraped_at,
          },
          body_text: row.body_text,
          status: row.status,
        },
      })),
      total: Number(count.rows[0].total),
    };
  }

  static async reviewPost(id: number, status: 'approved' | 'rejected', bodyText: string | undefined, reviewerId: string) {
    if (bodyText !== undefined && (typeof bodyText !== 'string' || bodyText.trim().length === 0 || bodyText.length > 10000)) {
      throw new AppError('body_text must contain 1-10000 characters.');
    }
    const result = await aggregatorDb.query(
      `UPDATE formatted_posts SET status = $2, body_text = COALESCE($3, body_text),
        edited_by = CASE WHEN $3 IS NOT NULL THEN $4 ELSE edited_by END,
        reviewed_at = now(), reviewed_by = $4, publication_error = NULL
       WHERE id = $1 AND status IN ('pending', 'approved')
       RETURNING *`,
      [id, status, bodyText?.trim() ?? null, reviewerId]
    );
    if (result.rows.length === 0) throw new AppError('Post not found or can no longer be reviewed.', 404);
    return result.rows[0];
  }

  static async getPublishSettings() {
    const result = await aggregatorDb.query('SELECT * FROM category_publish_settings ORDER BY category');
    return result.rows;
  }

  static async setPublishMode(category: string, mode: PublishMode, adminId: string) {
    if (!category?.trim()) throw new AppError('category is required.');
    if (!['manual_approval', 'auto_publish'].includes(mode)) throw new AppError('Unsupported publish mode.');
    const result = await aggregatorDb.query(
      `INSERT INTO category_publish_settings (category, publish_mode, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (category) DO UPDATE SET
         publish_mode = EXCLUDED.publish_mode, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [category.trim(), mode, adminId]
    );
    return result.rows[0];
  }

  static async publishPost(id: number, publisherId: string | null = null) {
    const result = await aggregatorDb.query<PostRow>(
      `SELECT p.id, p.raw_record_id, p.platform, p.body_text, p.status,
          r.category, r.title, r.org, r.description, r.deadline, r.link,
          r.location, r.eligibility, r.tags
       FROM formatted_posts p JOIN raw_records r ON r.id = p.raw_record_id
       WHERE p.id = $1`,
      [id]
    );
    const post = result.rows[0];
    if (!post) throw new AppError('Formatted post not found.', 404);
    if (post.status !== 'approved') throw new AppError('Only approved posts can be published.', 409);

    let channelId: string | null = null;
    if (post.platform === 'telegram') {
      channelId = await this.sendTelegram(post.body_text);
    }

    await aggregatorDb.query(
      `INSERT INTO publish_log (formatted_post_id, platform, published_by, channel_id)
       VALUES ($1, $2, $3, $4)`,
      [id, post.platform, publisherId, channelId]
    );
    const updated = await aggregatorDb.query(
      `UPDATE formatted_posts SET status = 'published', publication_error = NULL
       WHERE id = $1 AND status = 'approved' RETURNING *`,
      [id]
    );
    if (updated.rows.length === 0) throw new AppError('Post state changed while publishing.', 409);
    return updated.rows[0];
  }

  static async publishAutoApproved(): Promise<void> {
    const result = await aggregatorDb.query<{ id: number } & QueryResultRow>(
      `SELECT p.id FROM formatted_posts p
       JOIN raw_records r ON r.id = p.raw_record_id
       JOIN category_publish_settings s ON s.category = r.category
       WHERE p.status = 'approved' AND p.platform = 'telegram'
         AND s.publish_mode = 'auto_publish'
         AND NOT EXISTS (SELECT 1 FROM publish_log l WHERE l.formatted_post_id = p.id)
       ORDER BY p.created_at LIMIT 50`
    );
    for (const post of result.rows) {
      try {
        await this.publishPost(post.id, null);
      } catch (error) {
        await aggregatorDb.query(
          'UPDATE formatted_posts SET publication_error = $2 WHERE id = $1',
          [post.id, errorText(error).slice(0, 1000)]
        );
        console.error(`[aggregator] Auto-publish failed for post ${post.id}: ${errorText(error)}`);
      }
    }
  }

  static async getSourceHealth() {
    const result = await aggregatorDb.query<SourceRow>(
      `SELECT * FROM sources ORDER BY source_key`
    );
    const now = Date.now();
    return result.rows.map((source) => {
      const referenceTime = source.last_success_at ?? source.created_at;
      const staleAfterMs = source.poll_frequency_minutes * 3 * 60 * 1000;
      const isStale = source.enabled && now - new Date(referenceTime).getTime() > staleAfterMs;
      return {
        ...publicSource(source),
        is_stale: isStale,
        needs_attention: source.enabled && (source.consecutive_failures >= 3 || isStale),
      };
    });
  }

  static async checkAndSendAlerts(): Promise<void> {
    const health = await this.getSourceHealth();
    for (const source of health) {
      if (!source.needs_attention || source.last_alerted_at) continue;
      const message = `Aggregator source needs attention: ${source.source_key}; failures=${source.consecutive_failures}; stale=${source.is_stale}.`;
      try {
        await this.sendAdminTelegram(message);
        await aggregatorDb.query(
          'UPDATE sources SET last_alerted_at = now() WHERE id = $1',
          [source.id]
        );
      } catch (error) {
        console.error(`[aggregator] Alert failed for source ${source.source_key}: ${errorText(error)}`);
      }
    }
  }

  private static async findSource(id: number): Promise<SourceRow> {
    if (!Number.isInteger(id) || id < 1) throw new AppError('Invalid source id.');
    const result = await aggregatorDb.query<SourceRow>('SELECT * FROM sources WHERE id = $1', [id]);
    if (!result.rows[0]) throw new AppError('Source not found.', 404);
    return result.rows[0];
  }

  private static async saveRecord(sourceId: number, record: NormalizedRecord): Promise<{ record: StoredRecord; inserted: boolean }> {
    const result = await aggregatorDb.query<StoredRecord & QueryResultRow>(
      `INSERT INTO raw_records
        (source_id, category, title, org, description, deadline, link, location, eligibility, tags, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (source_id, content_hash) DO NOTHING
       RETURNING id, category, title, org, description, deadline, link, location, eligibility, tags`,
      [
        sourceId,
        record.category,
        record.title,
        record.org,
        record.description,
        record.deadline,
        record.link,
        record.location,
        record.eligibility,
        record.tags,
        record.content_hash,
      ]
    );
    if (result.rows[0]) return { record: result.rows[0], inserted: true };
    const existing = await aggregatorDb.query<StoredRecord & QueryResultRow>(
      `SELECT id, category, title, org, description, deadline, link, location, eligibility, tags
       FROM raw_records WHERE source_id = $1 AND content_hash = $2`,
      [sourceId, record.content_hash]
    );
    if (!existing.rows[0]) throw new AppError('Unable to find or save the ingested record.', 500);
    return { record: existing.rows[0], inserted: false };
  }

  private static async createPosts(record: StoredRecord): Promise<void> {
    const setting = await aggregatorDb.query<{ publish_mode: PublishMode } & QueryResultRow>(
      'SELECT publish_mode FROM category_publish_settings WHERE category = $1',
      [record.category]
    );
    const autoPublish = setting.rows[0]?.publish_mode === 'auto_publish';
    const platforms: AggregatorPlatform[] = ['telegram', 'whatsapp', 'community'];
    for (const platform of platforms) {
      const status = platform === 'telegram' && autoPublish ? 'approved' : 'pending';
      await aggregatorDb.query(
        `INSERT INTO formatted_posts (raw_record_id, platform, body_text, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (raw_record_id, platform) DO UPDATE SET
           status = CASE
             WHEN EXCLUDED.status = 'approved' AND formatted_posts.status = 'pending' THEN 'approved'
             ELSE formatted_posts.status
           END`,
        [record.id, platform, formatPost(record, platform), status]
      );
    }
  }

  private static async sendTelegram(text: string): Promise<string> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const channelId = process.env.TELEGRAM_CHANNEL_ID;
    if (!token || !channelId) throw new AppError('Telegram publishing is not configured.', 503);
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json() as { ok?: boolean };
    if (!response.ok || !payload.ok) throw new AppError(`Telegram publishing failed with HTTP ${response.status}.`, 502);
    return channelId;
  }

  private static async sendAdminTelegram(text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!token || !chatId) throw new AppError('Telegram admin alerting is not configured.', 503);
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json() as { ok?: boolean };
    if (!response.ok || !payload.ok) throw new AppError(`Telegram admin alert failed with HTTP ${response.status}.`, 502);
  }
}

interface StoredRecord extends Omit<NormalizedRecord, 'content_hash'> {
  id: number;
}

export function isPublishMode(value: unknown): value is PublishMode {
  return value === 'manual_approval' || value === 'auto_publish';
}

export function isPostStatus(value: unknown): value is 'approved' | 'rejected' {
  return value === 'approved' || value === 'rejected';
}

export function isSourceInput(value: unknown): value is SourceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Partial<SourceInput>;
  return typeof input.source_key === 'string'
    && typeof input.category === 'string'
    && typeof input.type === 'string'
    && ['api', 'rss', 'scrape', 'manual'].includes(input.type)
    && Boolean(input.field_mapping && typeof input.field_mapping === 'object' && !Array.isArray(input.field_mapping));
}

export function isSourcePatch(value: unknown): value is Partial<SourceInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  const allowed = new Set([
    'source_key', 'category', 'type', 'base_url', 'auth_config',
    'field_mapping', 'poll_frequency_minutes', 'enabled',
  ]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) return false;
  if ('source_key' in patch && typeof patch.source_key !== 'string') return false;
  if ('category' in patch && typeof patch.category !== 'string') return false;
  if ('type' in patch && !['api', 'rss', 'scrape', 'manual'].includes(String(patch.type))) return false;
  if ('base_url' in patch && patch.base_url !== null && typeof patch.base_url !== 'string') return false;
  if ('auth_config' in patch && patch.auth_config !== null
    && (!patch.auth_config || typeof patch.auth_config !== 'object' || Array.isArray(patch.auth_config))) return false;
  if ('field_mapping' in patch
    && (!patch.field_mapping || typeof patch.field_mapping !== 'object' || Array.isArray(patch.field_mapping))) return false;
  if ('poll_frequency_minutes' in patch && typeof patch.poll_frequency_minutes !== 'number') return false;
  if ('enabled' in patch && typeof patch.enabled !== 'boolean') return false;
  return true;
}

export function isManualEntryInput(value: unknown): value is ManualEntryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const allowed = new Set([
    'category', 'title', 'org', 'description', 'deadline', 'link', 'location', 'eligibility',
  ]);
  if (Object.keys(entry).some((key) => !allowed.has(key))) return false;
  if (typeof entry.category !== 'string' || typeof entry.title !== 'string' || typeof entry.link !== 'string') {
    return false;
  }
  return ['org', 'description', 'deadline', 'location', 'eligibility'].every((key) => (
    entry[key] === undefined || entry[key] === null || typeof entry[key] === 'string'
  ));
}

