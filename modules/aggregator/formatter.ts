export interface AggregatorRecord {
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

export type AggregatorPlatform = 'whatsapp' | 'telegram' | 'community';

function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatPost(record: AggregatorRecord, platform: AggregatorPlatform): string {
  const lines = [
    record.category.toUpperCase(),
    '',
    cleanText(record.title),
  ];

  if (record.org) lines.push(`Organization: ${cleanText(record.org)}`);
  if (record.location) lines.push(`Location: ${cleanText(record.location)}`);
  if (record.deadline) lines.push(`Deadline: ${record.deadline}`);
  if (record.eligibility) lines.push(`Eligibility: ${cleanText(record.eligibility)}`);
  if (record.description) lines.push('', cleanText(record.description).slice(0, 900));
  if (record.tags.length > 0) lines.push(`Tags: ${record.tags.map(cleanText).join(', ')}`);
  lines.push('', `Apply: ${record.link}`);

  const body = lines.join('\n');
  if (platform === 'telegram' && body.length > 4096) {
    return `${body.slice(0, 4080).trimEnd()}\n[truncated]`;
  }
  return body;
}

export function cleanMappedText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = cleanText(Array.isArray(value) ? value.join(', ') : String(value));
  return text || null;
}
