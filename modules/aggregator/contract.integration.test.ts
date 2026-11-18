import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../../src/app/server.js';
import { aggregatorDb } from './database.js';

const unique = crypto.randomUUID();
const email = `contract-${unique}@example.org`;
const category = `contract-${unique}`;
const sourceKey = `contract-${unique}`;
const title = `Contract integration ${unique}`;
const link = `https://example.org/contract/${unique}`;
let server: Server;
let baseUrl: string;
let token: string;
let sourceId: number | null = null;
let manualSourceExisted = false;

async function request(method: string, path: string, body?: unknown, authToken?: string) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, any>,
  };
}

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.NODE_ENV = 'test';
  await aggregatorDb.initialize();
  const existingManualSource = await aggregatorDb.query(
    "SELECT id FROM sources WHERE source_key = 'manual_entries'"
  );
  manualSourceExisted = existingManualSource.rows.length > 0;

  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await request('POST', '/auth/login', {
    email: 'content@coursepur.com',
    password: 'Content@123',
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'content_ops');
  token = login.body.token;
});

after(async () => {
  const records = await aggregatorDb.query(
    'SELECT id, source_id FROM raw_records WHERE link = $1',
    [link]
  );
  for (const record of records.rows) {
    await aggregatorDb.query(
      `DELETE FROM publish_log WHERE formatted_post_id IN
       (SELECT id FROM formatted_posts WHERE raw_record_id = $1)`,
      [record.id]
    );
    await aggregatorDb.query('DELETE FROM formatted_posts WHERE raw_record_id = $1', [record.id]);
    await aggregatorDb.query('DELETE FROM raw_records WHERE id = $1', [record.id]);
  }
  if (sourceId !== null) {
    await aggregatorDb.query('DELETE FROM source_runs WHERE source_id = $1', [sourceId]);
    await aggregatorDb.query('DELETE FROM sources WHERE id = $1 AND source_key = $2', [sourceId, sourceKey]);
  }
  if (!manualSourceExisted) {
    const manualSource = await aggregatorDb.query(
      "SELECT id FROM sources WHERE source_key = 'manual_entries'"
    );
    if (manualSource.rows[0]) {
      await aggregatorDb.query('DELETE FROM source_runs WHERE source_id = $1', [manualSource.rows[0].id]);
      await aggregatorDb.query(
        "DELETE FROM sources WHERE id = $1 AND source_key = 'manual_entries'",
        [manualSource.rows[0].id]
      );
    }
  }
  await aggregatorDb.query('DELETE FROM category_publish_settings WHERE category = $1', [category]);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await aggregatorDb.close();
});

test('implements the Document 8 auth, source, post, manual-entry, and list contract', async () => {
  const unauthenticatedMe = await request('GET', '/auth/me');
  assert.equal(unauthenticatedMe.status, 401);
  assert.equal(typeof unauthenticatedMe.body.error, 'string');

  const me = await request('GET', '/auth/me', undefined, token);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'content@coursepur.com');

  const sourceResponse = await request('POST', '/sources', {
    source_key: sourceKey,
    category,
    type: 'manual',
    field_mapping: { title: 'title', link: 'link' },
  }, token);
  assert.equal(sourceResponse.status, 201);
  assert.equal(typeof sourceResponse.body.source.id, 'number');
  sourceId = sourceResponse.body.source.id;

  const sources = await request('GET', '/sources?limit=1&offset=0', undefined, token);
  assert.equal(sources.status, 200);
  assert.equal(typeof sources.body.total, 'number');
  assert.equal(sources.body.sources.length, 1);

  const sourceUpdate = await request('PUT', `/sources/${sourceId}`, { enabled: false }, token);
  assert.equal(sourceUpdate.status, 200);
  assert.equal(sourceUpdate.body.source.enabled, false);

  const preview = await request('POST', `/sources/${sourceId}/preview`, {}, token);
  assert.equal(preview.status, 400);
  assert.equal(typeof preview.body.error, 'string');

  const setting = await request('PUT', `/categories/${category}/publish-mode`, {
    publish_mode: 'manual_approval',
  }, token);
  assert.equal(setting.status, 200);
  assert.equal(setting.body.publish_mode, 'manual_approval');

  const manualEntry = await request('POST', '/manual-entries', {
    category,
    title,
    link,
    description: 'Contract integration record',
  }, token);
  assert.equal(manualEntry.status, 201);
  assert.equal(manualEntry.body.raw_record.title, title);

  const pending = await request('GET', `/posts?status=pending&category=${category}&limit=10`, undefined, token);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.total, 3);
  assert.equal(pending.body.posts.length, 3);
  assert.ok(pending.body.posts[0].raw_record);

  const whatsapp = pending.body.posts.find((post: { platform: string }) => post.platform === 'whatsapp');
  const community = pending.body.posts.find((post: { platform: string }) => post.platform === 'community');
  assert.ok(whatsapp && community);

  const edited = await request('PUT', `/posts/${whatsapp.id}`, { body_text: 'Edited contract draft' }, token);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.post.body_text, 'Edited contract draft');
  assert.equal(typeof edited.body.post.edited_by, 'string');

  const approved = await request('POST', `/posts/${whatsapp.id}/approve`, {}, token);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.post.status, 'approved');

  const bulk = await request('POST', '/posts/bulk-approve', { ids: [community.id] }, token);
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.approved.length, 1);

  const health = await request('GET', '/sources/health?limit=10&offset=0', undefined, token);
  assert.equal(health.status, 200);
  assert.ok(Array.isArray(health.body.sources));
  assert.equal(typeof health.body.total, 'number');

  const categories = await request('GET', '/categories?limit=10&offset=0', undefined, token);
  assert.equal(categories.status, 200);
  assert.ok(categories.body.categories.some((item: { category: string }) => item.category === category));

  const publish = await request(
    'POST',
    `/admin/aggregator/posts/${whatsapp.id}/publish`,
    {},
    token
  );
  assert.equal(publish.status, 200);

  const publishLog = await request('GET', `/publish-log?category=${category}&limit=10`, undefined, token);
  assert.equal(publishLog.status, 200);
  assert.equal(publishLog.body.total, 1);
  assert.equal(publishLog.body.entries[0].post.raw_record.title, title);

  const users = await request('GET', '/users?limit=1&offset=0', undefined, token);
  assert.equal(users.status, 403);
  assert.equal(typeof users.body.error, 'string');

  const platformLogin = await request('POST', '/auth/login', {
    email: 'admin@coursepur.com',
    password: 'Admin@123',
  });
  assert.equal(platformLogin.status, 200);
  const platformToken = platformLogin.body.token as string;
  const createdUser = await request('POST', '/users', {
    email: email,
    password: 'LongPass123!',
    role: 'content_ops',
  }, platformToken);
  assert.equal(createdUser.status, 201);
  assert.equal(createdUser.body.user.email, email);

  const duplicateUser = await request('POST', '/users', {
    email,
    password: 'LongPass123!',
    role: 'content_ops',
  }, platformToken);
  assert.equal(duplicateUser.status, 409);

  const userList = await request('GET', '/users?limit=50&offset=0', undefined, platformToken);
  assert.equal(userList.status, 200);
  assert.ok(userList.body.users.some((user: { email: string }) => user.email === email));
  const deactivated = await request('DELETE', `/users/${createdUser.body.user.id}`, undefined, platformToken);
  assert.equal(deactivated.status, 200);

  const removed = await request('DELETE', `/sources/${sourceId}`, undefined, token);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);
});
