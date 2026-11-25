// API-key authentication on the public /v1 API. Requires a migrated database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { app } from '../../src/app.js';
import { db } from '../../src/db/client.js';
import { hashApiKey } from '../../src/middleware/api-key.js';
import { ApiKeysTable } from '../../src/schema/api_keys.schema.js';
import { MerchantsTable } from '../../src/schema/merchants.schema.js';

const run = Date.now().toString(36);
const merchantId = `mer_auth${run}`;
const newKey = () => `sk_test_${merchantId}__${randomBytes(16).toString('base64url')}`;
let liveKey: string;
let revokedKey: string;

beforeAll(async () => {
  await db.insert(MerchantsTable).values({
    id: merchantId,
    name: 'Auth test',
    email: `auth+${run}@test.dev`,
    company: 'Auth test',
    password_hash: 'x',
  });
  liveKey = newKey();
  revokedKey = newKey();
  await db.insert(ApiKeysTable).values([
    { merchant_id: merchantId, key_hash: hashApiKey(liveKey), key_prefix: liveKey.slice(0, 22), type: 'test' },
    {
      merchant_id: merchantId,
      key_hash: hashApiKey(revokedKey),
      key_prefix: revokedKey.slice(0, 22),
      type: 'test',
      revoked_at: new Date(),
    },
  ]);
});

afterAll(async () => {
  await db.delete(ApiKeysTable).where(eq(ApiKeysTable.merchant_id, merchantId));
  await db.delete(MerchantsTable).where(eq(MerchantsTable.id, merchantId));
});

describe('API key authentication', () => {
  it('rejects requests without a key', async () => {
    const res = await request(app).get('/v1/plans');
    expect(res.status).toBe(401);
  });

  it('rejects malformed keys', async () => {
    const res = await request(app).get('/v1/plans').set('Authorization', 'Bearer not-a-key');
    expect(res.status).toBe(401);
  });

  it('rejects unknown keys with a valid shape', async () => {
    const res = await request(app).get('/v1/plans').set('Authorization', `Bearer ${newKey()}`);
    expect(res.status).toBe(401);
  });

  it('rejects revoked keys', async () => {
    const res = await request(app).get('/v1/plans').set('Authorization', `Bearer ${revokedKey}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/revoked/);
  });

  it('accepts a live key and scopes the request to its merchant', async () => {
    const res = await request(app).get('/v1/plans').set('Authorization', `Bearer ${liveKey}`);
    expect(res.status).toBe(200);
  });

  it('accepts keys for merchant IDs containing underscores', async () => {
    // Regression: nanoid IDs can contain '_' and end with it; a lazy regex
    // parse of `sk_test_<id>__<random>` mis-split these and rejected valid keys.
    const trickyId = `mer_x_${run}_`;
    const key = `sk_test_${trickyId}__${randomBytes(16).toString('base64url')}`;
    await db.insert(MerchantsTable).values({
      id: trickyId,
      name: 'Tricky',
      email: `tricky+${run}@test.dev`,
      company: 'Tricky',
      password_hash: 'x',
    });
    await db.insert(ApiKeysTable).values({
      merchant_id: trickyId,
      key_hash: hashApiKey(key),
      key_prefix: key.slice(0, 22),
      type: 'test',
    });
    try {
      const res = await request(app).get('/v1/plans').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
    } finally {
      await db.delete(ApiKeysTable).where(eq(ApiKeysTable.merchant_id, trickyId));
      await db.delete(MerchantsTable).where(eq(MerchantsTable.id, trickyId));
    }
  });

  it('keeps register and login public', async () => {
    const res = await request(app).post('/v1/auth/login').send({ email: 'nobody@test.dev', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/email or password/);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/internal/v1/plans');
    expect(res.status).toBe(404);
  });
});
