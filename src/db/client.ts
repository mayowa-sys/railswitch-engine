// Database access with enforced tenant isolation.
//
// Two execution modes share one connection pool:
//
//   System (default)  Queries run as the connecting role, which owns the
//                     tables and therefore bypasses row-level security.
//                     Used by background workers, provider webhooks and
//                     authentication — code that legitimately spans tenants.
//
//   Tenant            runAsTenant() / the tenantContext middleware pin ONE
//                     connection for the whole unit of work, switch it to the
//                     unprivileged `railswitch_app` role and set
//                     app.current_merchant_id. Every query in that scope —
//                     including transactions — runs on that connection, so the
//                     merchant_isolation RLS policies are evaluated by Postgres
//                     and cross-tenant rows are invisible even if a query
//                     forgets its WHERE merchant_id clause.
//
// The exported `db` is a proxy that resolves to the tenant connection when
// called inside a tenant scope and to the pool otherwise, so callers don't
// change.

import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import dotenv from 'dotenv';
import { Pool, type PoolClient } from 'pg';

dotenv.config({ quiet: true });

export const TENANT_ROLE = 'railswitch_app';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

const systemDb = drizzle(pool);

interface TenantScope {
  merchantId: string;
  db: NodePgDatabase;
}

const tenantStorage = new AsyncLocalStorage<TenantScope>();

/** Pool-backed or tenant-pinned database, depending on the current scope. */
export const db: typeof systemDb = new Proxy(systemDb, {
  get(target, prop) {
    const scoped = tenantStorage.getStore()?.db ?? target;
    const value = Reflect.get(scoped, prop, scoped);
    return typeof value === 'function' ? value.bind(scoped) : value;
  },
});

/** The merchant whose tenant scope is active, if any. */
export function currentMerchantId(): string | undefined {
  return tenantStorage.getStore()?.merchantId;
}

async function enterTenant(client: PoolClient, merchantId: string): Promise<void> {
  await client.query(`SET ROLE ${TENANT_ROLE}`);
  await client.query(`SELECT set_config('app.current_merchant_id', $1, false)`, [merchantId]);
}

/**
 * Reset the connection before returning it to the pool. If the reset fails
 * the connection is destroyed rather than reused with tenant state on it.
 */
async function releaseTenant(client: PoolClient): Promise<void> {
  try {
    await client.query('RESET ROLE');
    await client.query('RESET app.current_merchant_id');
    client.release();
  } catch (err) {
    client.release(err as Error);
  }
}

/** Run `fn` with all `db` queries pinned to one RLS-enforced connection. */
export async function runAsTenant<T>(merchantId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await enterTenant(client, merchantId);
  } catch (err) {
    client.release(err as Error);
    throw err;
  }
  try {
    return await tenantStorage.run({ merchantId, db: drizzle(client) }, fn);
  } finally {
    await releaseTenant(client);
  }
}

/**
 * Express-style variant of runAsTenant: the connection stays pinned until
 * the response has finished (or the socket closed), so async route handlers
 * that outlive `next()` still run inside the tenant scope.
 */
export async function withTenantConnection(
  merchantId: string,
  onDone: (cb: () => void) => void,
  next: () => void,
): Promise<void> {
  const client = await pool.connect();
  try {
    await enterTenant(client, merchantId);
  } catch (err) {
    client.release(err as Error);
    throw err;
  }
  let released = false;
  onDone(() => {
    if (released) return;
    released = true;
    void releaseTenant(client);
  });
  tenantStorage.run({ merchantId, db: drizzle(client) }, next);
}
