// Offline eval over the golden set (evals/dunning/cases.json).
//
// Runs in CI with no API key:
//   1. Prompt-level PII boundary: the prompt sent to Gemini never contains
//      anything but the customer's first name, and always carries the facts
//      the message needs (amount, VA number, link).
//   2. Guardrail coverage: for every case, a set of deliberately broken
//      outputs must be rejected, and generateDunningMessage must fall back to
//      the template instead of showing them to a customer.
//
// The live model is scored separately by scripts/eval-dunning.ts.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  buildUserPrompt,
  generateDunningMessage,
  type DunningContext,
} from '../../src/ai/dunning-generator.js';
import { checkDunningOutput, guardFailures } from '../../src/ai/dunning-checks.js';
import { GeminiClient } from '../../src/ai/gemini-client.js';

interface GoldenCase {
  id: string;
  ctx: DunningContext;
}

const { cases } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'dunning', 'cases.json'), 'utf8'),
) as { cases: GoldenCase[] };

const fallback = { subject: 'Template subject', body: 'Template body' };

function clientReplying(reply: unknown): GeminiClient {
  const client = new GeminiClient({ apiKey: 'test-key' });
  (client as unknown as { generateJSON: () => Promise<unknown> }).generateJSON = async () => reply;
  return client;
}

const firstName = (c: DunningContext) => c.customerName.trim().split(/\s+/)[0];
const otherNames = (c: DunningContext) => c.customerName.trim().split(/\s+/).slice(1);

/** A message that should pass every guard for this context. */
function referenceMessage(ctx: DunningContext) {
  const parts = [`Hi ${firstName(ctx)}, your ${ctx.planName} payment of ₦${ctx.amountNaira.toLocaleString('en-NG')} did not go through.`];
  if (ctx.vaAccountNumber) parts.push(`Please transfer it to ${ctx.vaAccountNumber} (${ctx.vaBankName ?? 'Nomba'}).`);
  if (ctx.paymentLink) parts.push(`You can also pay here: ${ctx.paymentLink}`);
  parts.push('Thank you.');
  return { subject: 'Payment reminder', body: parts.join(' ') };
}

/** Deliberately broken variants of the reference message. */
function brokenVariants(ctx: DunningContext): Array<{ name: string; msg: { subject: string; body: string } }> {
  const ref = referenceMessage(ctx);
  const variants = [
    { name: 'threatening', msg: { ...ref, body: `${ref.body} Failure to pay will result in legal action.` } },
    { name: 'amount removed', msg: { ...ref, body: ref.body.replace(/₦[\d,]+/, 'your balance') } },
    { name: 'card number', msg: { ...ref, body: `${ref.body} Card 5399 8312 3456 7890 was declined.` } },
  ];
  if (otherNames(ctx).length > 0) {
    variants.push({ name: 'full name', msg: { ...ref, body: `Dear ${ctx.customerName}, ${ref.body}` } });
  }
  if (ctx.vaAccountNumber) {
    const wrong = ctx.vaAccountNumber.slice(0, -1) + ((Number(ctx.vaAccountNumber.slice(-1)) + 1) % 10);
    variants.push({ name: 'altered VA number', msg: { ...ref, body: ref.body.replace(ctx.vaAccountNumber, wrong) } });
  }
  return variants;
}

describe('dunning golden set', () => {
  it('has a non-trivial number of cases covering every channel and stage', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(cases.map((c) => c.ctx.channel))).toEqual(new Set(['whatsapp', 'email']));
    expect(new Set(cases.map((c) => c.ctx.stage))).toEqual(
      new Set(['retrying', 'va_fallback', 'whatsapp_fallback', 'past_due']),
    );
  });

  describe.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const prompt = buildUserPrompt(c.ctx);

    it('prompt carries only the first name (PII boundary)', () => {
      expect(prompt).toContain(firstName(c.ctx));
      for (const token of otherNames(c.ctx)) {
        expect(prompt).not.toMatch(new RegExp(`\\b${token}\\b`, 'i'));
      }
    });

    it('prompt carries the facts the message needs', () => {
      expect(prompt).toContain(c.ctx.amountNaira.toLocaleString());
      if (c.ctx.vaAccountNumber) expect(prompt).toContain(c.ctx.vaAccountNumber);
      if (c.ctx.paymentLink) expect(prompt).toContain(c.ctx.paymentLink);
    });

    it('reference message passes every guard', async () => {
      const ref = referenceMessage(c.ctx);
      expect(guardFailures(checkDunningOutput(c.ctx, ref))).toEqual([]);
      const r = await generateDunningMessage(c.ctx, fallback, { client: clientReplying(ref) });
      expect(r.generated).toBe(true);
    });

    it.each(brokenVariants(c.ctx).map((v) => [v.name, v.msg] as const))(
      'rejects broken output: %s',
      async (_name, msg) => {
        expect(guardFailures(checkDunningOutput(c.ctx, msg)).length).toBeGreaterThan(0);
        const r = await generateDunningMessage(c.ctx, fallback, { client: clientReplying(msg) });
        expect(r.generated).toBe(false);
        expect(r.body).toBe(fallback.body);
      },
    );
  });
});
