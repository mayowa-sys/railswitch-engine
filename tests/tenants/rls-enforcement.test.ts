// Proves tenant isolation is enforced by Postgres row-level security, not
// just by application WHERE clauses. Requires a migrated database
// (docker compose up -d && npm run migration:run).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { db, pool, runAsTenant, TENANT_ROLE } from '../../src/db/client.js';
import { MerchantsTable } from '../../src/schema/merchants.schema.js';
import { PlansTable } from '../../src/schema/plans.schema.js';

const run = Date.now().toString(36);
const merchantA = `mer_rlsA${run}`;
const merchantB = `mer_rlsB${run}`;
const planA = `pln_rlsA${run}`;
const planB = `pln_rlsB${run}`;

beforeAll(async () => {
  await db.insert(MerchantsTable).values([
    { id: merchantA, name: 'A', email: `a+${run}@rls.test`, company: 'A', password_hash: 'x' },
    { id: merchantB, name: 'B', email: `b+${run}@rls.test`, company: 'B', password_hash: 'x' },
  ]);
  await db.insert(PlansTable).values([
    { id: planA, merchant_id: merchantA, name: 'A plan', amount: 1000, interval: 'monthly', interval_count: 1 },
    { id: planB, merchant_id: merchantB, name: 'B plan', amount: 2000, interval: 'monthly', interval_count: 1 },
  ]);
});

afterAll(async () => {
  await db.delete(PlansTable).where(inArray(PlansTable.id, [planA, planB]));
  await db.delete(MerchantsTable).where(inArray(MerchantsTable.id, [merchantA, merchantB]));
  await pool.end();
});

const visiblePlanIds = async () =>
  (await db.select({ id: PlansTable.id }).from(PlansTable).where(inArray(PlansTable.id, [planA, planB]))).map(
    (r) => r.id,
  );

describe('row-level security', () => {
  it('a tenant scope only sees its own rows, even without a merchant filter', async () => {
    expect(await runAsTenant(merchantA, visiblePlanIds)).toEqual([planA]);
    expect(await runAsTenant(merchantB, visiblePlanIds)).toEqual([planB]);
  });

  it('a tenant scope cannot write rows for another merchant', async () => {
    const err = await runAsTenant(merchantA, () =>
      db.insert(PlansTable).values({
        merchant_id: merchantB,
        name: 'smuggled',
        amount: 1,
        interval: 'monthly',
        interval_count: 1,
      }),
    ).then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    // Drizzle wraps the Postgres error; the cause carries the RLS violation.
    expect(err?.cause?.message ?? err?.message).toMatch(/row-level security/);
  });

  it('a tenant scope cannot update or delete another merchant’s rows', async () => {
    await runAsTenant(merchantA, async () => {
      await db.update(PlansTable).set({ name: 'hijacked' }).where(inArray(PlansTable.id, [planB]));
      await db.delete(PlansTable).where(inArray(PlansTable.id, [planB]));
    });
    const [row] = await db.select().from(PlansTable).where(inArray(PlansTable.id, [planB]));
    expect(row?.name).toBe('B plan');
  });

  it('transactions inside a tenant scope stay isolated', async () => {
    const ids = await runAsTenant(merchantA, () => db.transaction(async () => visiblePlanIds()));
    expect(ids).toEqual([planA]);
  });

  it('concurrent tenant scopes never see each other’s data', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const merchant = i % 2 === 0 ? merchantA : merchantB;
        return runAsTenant(merchant, async () => ({ merchant, ids: await visiblePlanIds() }));
      }),
    );
    for (const r of results) {
      expect(r.ids).toEqual([r.merchant === merchantA ? planA : planB]);
    }
  });

  it('connections are returned to the pool with role and tenant reset', async () => {
    await runAsTenant(merchantA, visiblePlanIds);
    const clients = await Promise.all(Array.from({ length: 3 }, () => pool.connect()));
    try {
      for (const c of clients) {
        const { rows } = await c.query(
          `SELECT current_user AS role, current_setting('app.current_merchant_id', true) AS merchant`,
        );
        expect(rows[0].role).not.toBe(TENANT_ROLE);
        expect(rows[0].merchant ?? '').toBe('');
      }
    } finally {
      clients.forEach((c) => c.release());
    }
  });

  it('system scope (workers, webhooks) still sees all tenants', async () => {
    expect((await visiblePlanIds()).sort()).toEqual([planA, planB].sort());
    const [{ role }] = (await db.execute(sql`SELECT current_user AS role`)).rows as Array<{ role: string }>;
    expect(role).not.toBe(TENANT_ROLE);
  });
});
