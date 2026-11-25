import type { Request, Response, NextFunction } from 'express';
import { withTenantConnection } from '../db/client.js';

/**
 * Pins a dedicated, RLS-enforced database connection to this request for the
 * authenticated merchant. Must run after the merchant has been resolved.
 */
export async function setRLSContext(req: Request, res: Response, next: NextFunction) {
  if (!req.merchantId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'No merchant context' } });
    return;
  }
  try {
    await withTenantConnection(
      req.merchantId,
      (release) => {
        res.once('finish', release);
        res.once('close', release);
      },
      next,
    );
  } catch (err) {
    next(err);
  }
}
