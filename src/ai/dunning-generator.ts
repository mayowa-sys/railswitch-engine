// services/engine/src/ai/dunning-generator.ts
//
// Personalized dunning message generator. Given customer + subscription
// context, produces a subject line and body copy tailored to the
// cascade stage, plan tier, and prior interactions.
//
// Contract:
//   - If GEMINI_API_KEY is configured AND the call succeeds within the
//     timeout AND the response validates, we return the generated content.
//   - Otherwise we return the caller-supplied template fallback verbatim.
//
// This is the only place LLM output touches user-facing copy. Callers
// (whatsapp-service, email-service, gateway routes) always pass a
// fallback so nothing user-visible depends on the LLM being available.

import { getGeminiClient, type GeminiClient } from './gemini-client.js';
import { GlobalLogger } from '../utils/logger.js';
import { checkDunningOutput, guardFailures } from './dunning-checks.js';

export type DunningChannel = 'whatsapp' | 'email';
export type CascadeStage = 'retrying' | 'va_fallback' | 'whatsapp_fallback' | 'past_due';

export interface DunningContext {
  channel: DunningChannel;
  stage: CascadeStage;
  customerName: string;
  planName: string;
  amountNaira: number;
  currency?: string;
  daysOverdue?: number;
  retryCount?: number;
  vaAccountNumber?: string;
  vaBankName?: string;
  paymentLink?: string;
  merchantName?: string;
  language?: 'en' | 'en-NG';
  /** Optional free-form hint the merchant sets, e.g. "always sign off with 'Stay well fit.'" */
  toneHint?: string;
}

export interface GeneratedMessage {
  subject: string;
  body: string;
  /** True if this message came from the LLM; false if it's the fallback. */
  generated: boolean;
}

export interface DunningFallback {
  subject: string;
  body: string;
}

export interface GenerateDunningOptions {
  client?: GeminiClient;
  /** Skip the LLM even if configured (used by tests / feature-flag). */
  disable?: boolean;
}

export const GENERATION_TEMPERATURE = 0.5;

export const SYSTEM_PROMPT = `You are a professional payments recovery assistant for a Nigerian subscription business.
You write short, warm, non-shaming reminders to customers whose card payments failed.
Rules:
- Never guilt-trip or threaten. Assume the failure was a bank issue, not intent.
- Keep it under 5 sentences for WhatsApp, under 8 for email.
- Always include the exact amount and a clear next step.
- If a virtual account number is provided, tell the customer to transfer to it.
- Nigerian English is fine; avoid slang and emojis.
- Respond ONLY as JSON: { "subject": "...", "body": "..." }
- For WhatsApp, subject is unused but must still be a short label.`;

export async function generateDunningMessage(
  ctx: DunningContext,
  fallback: DunningFallback,
  opts: GenerateDunningOptions = {},
): Promise<GeneratedMessage> {
  const logger = new GlobalLogger('DunningGenerator');
  if (opts.disable || process.env.RAILSWITCH_AI_DUNNING === 'off') {
    return { ...fallback, generated: false };
  }
  const client = opts.client ?? getGeminiClient();
  if (!client.isConfigured()) {
    return { ...fallback, generated: false };
  }

  const userPrompt = buildUserPrompt(ctx);
  let result: { subject?: unknown; body?: unknown } | null;
  try {
    result = await client.generateJSON<{ subject?: unknown; body?: unknown }>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: GENERATION_TEMPERATURE,
      maxOutputTokens: 400,
    });
  } catch (err) {
    // GeminiClient already swallows its own errors; this protects callers
    // from any other client implementation that throws.
    logger.warn('Dunning generation threw — falling back', { error: (err as Error).message });
    return { ...fallback, generated: false };
  }

  if (!result || typeof result !== 'object') {
    return { ...fallback, generated: false };
  }
  const subject = typeof result.subject === 'string' ? result.subject.trim() : '';
  const body = typeof result.body === 'string' ? result.body.trim() : '';
  if (!subject || !body) {
    logger.warn('Gemini response missing subject/body — falling back');
    return { ...fallback, generated: false };
  }

  // Runtime guardrail: the same 'guard' checks the eval harness scores.
  const failures = guardFailures(checkDunningOutput(ctx, { subject, body }));
  if (failures.length > 0) {
    logger.warn('Generated dunning copy failed guardrails — falling back', {
      checks: failures.map((f) => f.id),
    });
    return { ...fallback, generated: false };
  }
  return { subject, body, generated: true };
}

export function buildUserPrompt(ctx: DunningContext): string {
  const lines: string[] = [];
  lines.push(`Channel: ${ctx.channel}`);
  lines.push(`Cascade stage: ${ctx.stage}`);
  lines.push(`Customer first name: ${firstName(ctx.customerName)}`);
  lines.push(`Plan: ${ctx.planName}`);
  lines.push(`Amount due: ₦${ctx.amountNaira.toLocaleString()}`);
  if (ctx.currency && ctx.currency !== 'NGN') lines.push(`Currency: ${ctx.currency}`);
  if (typeof ctx.daysOverdue === 'number') lines.push(`Days overdue: ${ctx.daysOverdue}`);
  if (typeof ctx.retryCount === 'number') lines.push(`Retries so far: ${ctx.retryCount}`);
  if (ctx.vaAccountNumber) lines.push(`Virtual account: ${ctx.vaAccountNumber} (${ctx.vaBankName ?? 'Nomba'})`);
  if (ctx.paymentLink) lines.push(`Payment link: ${ctx.paymentLink}`);
  if (ctx.merchantName) lines.push(`Business name: ${ctx.merchantName}`);
  if (ctx.toneHint) lines.push(`Tone hint from merchant: ${ctx.toneHint}`);
  lines.push('');
  lines.push('Write one recovery message using the fields above.');
  lines.push('Return JSON only, no markdown, no explanation.');
  return lines.join('\n');
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? 'Customer';
}
