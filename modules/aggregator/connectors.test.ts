import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSourceRecords, normalizeManualRecords, SourceConfig } from './connectors.js';
import { decryptSourceAuth, encryptSourceAuth } from './crypto.js';

const source: SourceConfig = {
  source_key: 'manual-updates',
  category: 'jobs',
  type: 'manual',
  base_url: null,
  field_mapping: {
    title: 'title',
    link: 'url',
    description: { path: 'description', transform: 'strip_html' },
    deadline: { path: 'apply_by', transform: 'date' },
  },
};

test('normalizes manual records, omits unmapped fields, and hashes consistently', () => {
  const first = normalizeManualRecords(source, [{
    title: '  Junior <b>Engineer</b> ',
    url: 'https://example.org/jobs/1',
    description: '<p>Build useful tools &amp; systems</p>',
    apply_by: '2026-12-01',
  }])[0];
  const second = normalizeManualRecords(source, [{
    title: 'Junior <b>Engineer</b>',
    url: 'https://example.org/jobs/1',
    description: '<p>Another description</p>',
  }])[0];

  assert.equal(first.title, 'Junior Engineer');
  assert.equal(first.description, 'Build useful tools & systems');
  assert.equal(first.deadline, '2026-12-01');
  assert.equal(first.category, 'jobs');
  assert.equal(first.org, null);
  assert.equal(first.tags.length, 0);
  assert.equal(first.content_hash, second.content_hash);
});

test('rejects non-web application links in manually submitted records', () => {
  assert.throws(() => normalizeManualRecords(source, [{
    title: 'Invalid',
    url: 'javascript:alert(1)',
  }]), /HTTP or HTTPS/);
});

test('rejects source URLs that target a private address', async () => {
  await assert.rejects(fetchSourceRecords({
    ...source,
    type: 'api',
    base_url: 'https://127.0.0.1/private',
  }), /public IP addresses/);
});

test('encrypts source credentials and detects tampering', () => {
  const previousKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = 'test-only-secret-key-with-at-least-32-characters';
  try {
    const encrypted = encryptSourceAuth({ bearer_token: 'sensitive-test-token' });
    assert.ok(encrypted);
    assert.equal(encrypted.includes('sensitive-test-token'), false);
    assert.deepEqual(decryptSourceAuth(encrypted), { bearer_token: 'sensitive-test-token' });
    assert.throws(() => decryptSourceAuth(`${encrypted}tampered`));
  } finally {
    if (previousKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = previousKey;
  }
});
