// API-key authentication for the public /v1 API.
//
// Keys look like `sk_<live|test>_<merchantId>__<random>`. Only a SHA-256 hash
// of each key is stored (api_keys.key_hash). A request is authenticated when
// the hash exists, is not revoked, and belongs to the merchant encoded in the
// key. Lookups run in system scope (before any tenant connection is pinned)
// and fail closed: a database error is a 503, never an implicit allow.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ApiKeysTable } from '../schema/api_keys.schema.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      merchantId: string;
      apiKeyMode?: 'live' | 'test';
    }
  }
}

const KEY_FORMAT = /^sk_(live|test)_(.+?)__[A-Za-z0-9_-]{8,}$/;

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function unauthorized(res: Response, message: string) {
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!token) {
    unauthorized(res, 'Missing API key. Send `Authorization: Bearer sk_...`');
    return;
  }

  const match = KEY_FORMAT.exec(token);
  if (!match) {
    unauthorized(res, 'Malformed API key');
    return;
  }
  const [, mode, merchantId] = match;
  const keyHash = hashApiKey(token);

  let row: { merchant_id: string; revoked_at: Date | null } | undefined;
  try {
    [row] = await db
      .select({ merchant_id: ApiKeysTable.merchant_id, revoked_at: ApiKeysTable.revoked_at })
      .from(ApiKeysTable)
      .where(eq(ApiKeysTable.key_hash, keyHash))
      .limit(1);
  } catch (err) {
    console.error('[auth] API key lookup failed', err);
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication temporarily unavailable' } });
    return;
  }

  if (!row || row.revoked_at) {
    unauthorized(res, row ? 'API key has been revoked' : 'Invalid API key');
    return;
  }
  const a = Buffer.from(row.merchant_id);
  const b = Buffer.from(merchantId);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    unauthorized(res, 'Invalid API key');
    return;
  }

  req.merchantId = row.merchant_id;
  req.apiKeyMode = mode as 'live' | 'test';
  next();
}

/** requireApiKey, except for the given unauthenticated paths (e.g. login). */
export function requireApiKeyExcept(publicPaths: Array<{ method: string; path: string }>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (publicPaths.some((p) => p.method === req.method && p.path === req.path)) {
      next();
      return;
    }
    void requireApiKey(req, res, next);
  };
}
