import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { cleanMappedText } from './formatter.js';

export type SourceType = 'api' | 'rss' | 'scrape' | 'manual';
export type FieldTransform = 'strip_html' | 'date' | 'split_csv';
export interface FieldMappingRule {
  path: string;
  transform?: FieldTransform;
  value_map?: Record<string, string>;
}
export type FieldMapping = Record<string, string | FieldMappingRule>;

export interface SourceConfig {
  id?: number;
  source_key: string;
  category: string;
  type: SourceType;
  base_url: string | null;
  field_mapping: FieldMapping;
  auth_config?: Record<string, unknown> | null;
}

export interface NormalizedRecord {
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
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')
      || normalized.startsWith('::ffff:');
  }
  return true;
}

async function validateSourceUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Source URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Source URL must use HTTPS and must not contain embedded credentials.');
  }
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new Error('Source URL cannot target a local hostname.');
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('Source URL must resolve only to public IP addresses.');
  }
  return url;
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown[] = [value];
  for (const segment of path.split('.').filter(Boolean)) {
    current = current.flatMap((item) => {
      if (Array.isArray(item)) return item.map((entry) => (entry as Record<string, unknown>)[segment]);
      if (item && typeof item === 'object') return [(item as Record<string, unknown>)[segment]];
      return [undefined];
    });
  }
  const values = current.filter((entry) => entry !== undefined);
  return values.length === 1 ? values[0] : values;
}

function getRule(mapping: FieldMapping, field: string): FieldMappingRule | null {
  const rule = mapping[field];
  if (typeof rule === 'string') return { path: rule };
  if (rule && typeof rule === 'object' && typeof rule.path === 'string') return rule;
  return null;
}

function mapValue(raw: unknown, rule: FieldMappingRule | null): unknown {
  if (!rule) return undefined;
  let value = getPath(raw, rule.path);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const linkObject = value as Record<string, unknown>;
    value = linkObject['@_href'] ?? linkObject.href ?? linkObject['#text'] ?? value;
  }
  if (rule.transform === 'strip_html') {
    return typeof value === 'string' ? cleanMappedText(value) : value;
  }
  if (rule.transform === 'date' && value !== null && value !== undefined) {
    const parsedDate = new Date(String(value));
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString().slice(0, 10);
  }
  if (rule.transform === 'split_csv' && typeof value === 'string') {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  if (rule.value_map && value !== null && value !== undefined) {
    return rule.value_map[String(value)] ?? value;
  }
  return value;
}

function normalizeOne(source: SourceConfig, raw: unknown): NormalizedRecord {
  if (!raw || typeof raw !== 'object') throw new Error('Source record must be an object.');
  const mapping = source.field_mapping || {};
  const mapped = (field: string) => mapValue(raw, getRule(mapping, field));
  const title = cleanMappedText(mapped('title'));
  const rawLink = cleanMappedText(mapped('link'));
  if (!title || !rawLink) throw new Error('Source field_mapping must provide non-empty title and link fields.');

  let link: URL;
  try {
    link = new URL(rawLink, source.base_url ?? undefined);
  } catch {
    throw new Error('Mapped record link must be a valid HTTP(S) URL.');
  }
  if (link.protocol !== 'https:' && link.protocol !== 'http:') {
    throw new Error('Mapped record link must use HTTP or HTTPS.');
  }

  const rawDeadline = mapped('deadline');
  const deadlineText = cleanMappedText(rawDeadline);
  let deadline: string | null = null;
  if (deadlineText) {
    const parsed = new Date(deadlineText);
    if (!Number.isNaN(parsed.getTime())) deadline = parsed.toISOString().slice(0, 10);
  }

  const rawTags = mapped('tags');
  const tags = Array.isArray(rawTags)
    ? rawTags.map(cleanMappedText).filter((tag): tag is string => Boolean(tag))
    : cleanMappedText(rawTags)?.split(',').map((tag) => tag.trim()).filter(Boolean) ?? [];
  const category = cleanMappedText(mapped('category')) ?? source.category;
  const contentHash = `${link.toString()}\n${title.toLowerCase()}`;

  return {
    category,
    title,
    org: cleanMappedText(mapped('org')),
    description: cleanMappedText(mapped('description')),
    deadline,
    link: link.toString(),
    location: cleanMappedText(mapped('location')),
    eligibility: cleanMappedText(mapped('eligibility')),
    tags,
    content_hash: createHash('sha256').update(contentHash).digest('hex'),
  };
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function requireRecordList(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Configured API records path did not resolve to an array.');
  }
  return value;
}

async function fetchRawSourceRecords(source: SourceConfig): Promise<unknown[]> {
  if (source.type === 'manual') {
    throw new Error('Manual sources accept records through the ingestion endpoint; they cannot be polled.');
  }
  if (source.type === 'scrape') {
    throw new Error('Scrape sources require a site-specific connector. Verify the site Terms of Service before enabling one.');
  }
  if (!source.base_url) throw new Error('Source URL is required for API and RSS sources.');

  const url = await validateSourceUrl(source.base_url);
  const headers: Record<string, string> = { accept: source.type === 'rss' ? 'application/rss+xml, application/atom+xml, application/xml, text/xml' : 'application/json' };
  const auth = source.auth_config ?? {};
  if (typeof auth.bearer_token === 'string' && auth.bearer_token) {
    headers.authorization = `Bearer ${auth.bearer_token}`;
  } else if (typeof auth.api_key === 'string' && auth.api_key) {
    const headerName = typeof auth.api_key_header === 'string' ? auth.api_key_header : 'x-api-key';
    if (!/^[a-z0-9-]+$/i.test(headerName)) throw new Error('API key header name is invalid.');
    headers[headerName] = auth.api_key;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`Source request failed with HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > 5_000_000) throw new Error('Source response exceeds the 5 MB limit.');
  const body = await response.text();
  if (body.length > 5_000_000) throw new Error('Source response exceeds the 5 MB limit.');

  let records: unknown[];
  if (source.type === 'rss') {
    const parsed = xmlParser.parse(body) as Record<string, unknown>;
    const rss = parsed.rss as Record<string, unknown> | undefined;
    const channel = rss?.channel as Record<string, unknown> | undefined;
    const feed = parsed.feed as Record<string, unknown> | undefined;
    records = asArray(channel?.item ?? feed?.entry);
  } else {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('API source returned invalid JSON.');
    }
    const recordsPath = getRule(source.field_mapping, 'records');
    const list = recordsPath ? getPath(payload, recordsPath.path) : payload;
    records = requireRecordList(list);
  }

  return records;
}

export async function fetchSourceRecords(source: SourceConfig): Promise<NormalizedRecord[]> {
  const records = await fetchRawSourceRecords(source);
  return records.map((record) => normalizeOne(source, record));
}

export async function previewSourceRecord(source: SourceConfig): Promise<{
  raw_sample: unknown;
  mapped_sample: NormalizedRecord;
}> {
  if (source.type === 'manual') {
    throw new Error('Manual sources do not fetch records; submit a manual entry to preview formatting.');
  }
  const record = (await fetchRawSourceRecords(source))[0];
  if (!record) throw new Error('The source returned no records to preview.');
  return { raw_sample: record, mapped_sample: normalizeOne(source, record) };
}

export function normalizeManualRecords(source: SourceConfig, records: unknown[]): NormalizedRecord[] {
  if (source.type !== 'manual') throw new Error('Manual record submission is only available for manual sources.');
  return records.map((record) => normalizeOne(source, record));
}
