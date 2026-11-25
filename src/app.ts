import express, { Request, Response, NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createStatusHandler } from './status/route.js';
import { probePostgres, probeRedis } from './status/probes.js';
import { requireApiKey, requireApiKeyExcept } from './middleware/api-key.js';
import { setRLSContext } from './middleware/rls.js';
import { requestId } from './middleware/request-id.js';
import { plansRouter } from './routes/plans.js';
import { customersRouter } from './routes/customers.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { invoicesRouter } from './routes/invoices.js';
import { paymentMethodsRouter } from './routes/payment_methods.js';
import { webhooksRouter } from './routes/webhooks.js';
import { authRouter } from './routes/auth.js';
import { auditRouter } from './routes/audit.js';
import { webhookManagementRouter } from './routes/webhook_management.js';
import { portalRouter } from './routes/portal.js';
import { merchantActionsRouter } from './routes/merchant-actions.js';
import { aiRouter } from './routes/ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

export const app = express();
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(requestId);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' } },
});

// Public endpoints — no auth required.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'engine' });
});

app.get(
  '/status',
  createStatusHandler({
    postgres: () => probePostgres(process.env.DATABASE_URL),
    redis: () => probeRedis(),
    version: pkg.version,
    gitSha: process.env.GIT_SHA ?? 'unknown',
  }),
);

// Provider webhook ingress — authenticated by the Nomba HMAC signature, not
// an API key. Runs in system scope: the handler resolves the merchant from
// the payload.
app.use('/webhooks', webhooksRouter);

// Merchant auth. Register/login are public (rate-limited); key management
// requires an existing key.
app.use(
  '/v1/auth',
  authLimiter,
  requireApiKeyExcept([
    { method: 'POST', path: '/register' },
    { method: 'POST', path: '/login' },
  ]),
  authRouter,
);

// Customer self-service portal. Issuing a link needs the merchant's API key;
// everything else is authorised by a signed, expiring customer token.
app.use(
  '/v1/portal',
  (req: Request, res: Response, next: NextFunction) =>
    req.path.startsWith('/customers/') ? requireApiKey(req, res, () => setRLSContext(req, res, next)) : next(),
  portalRouter,
);

// Tenant-scoped API: API key → merchant → pinned RLS-enforced connection.
const tenant = [requireApiKey, setRLSContext];
app.use('/v1/plans', ...tenant, plansRouter);
app.use('/v1/customers', ...tenant, customersRouter);
app.use('/v1/subscriptions', ...tenant, subscriptionsRouter);
app.use('/v1/invoices', ...tenant, invoicesRouter);
app.use('/v1/payment-methods', ...tenant, paymentMethodsRouter);
app.use('/v1/audit-logs', ...tenant, auditRouter);
app.use('/v1/webhooks', ...tenant, webhookManagementRouter);
app.use('/v1/actions', ...tenant, merchantActionsRouter);
app.use('/v1/ai', ...tenant, aiRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

// Global Express error handler — catches unhandled errors and returns JSON.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[unhandled-error]', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});
