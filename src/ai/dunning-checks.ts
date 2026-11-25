// services/engine/src/ai/dunning-checks.ts
//
// Deterministic checks for LLM-generated dunning copy.
//
// Every check takes the context the message was generated for and the
// message itself, and returns pass/fail with a short reason. Checks come in
// two severities:
//
//   - 'guard'   — a customer must never see a message that fails this.
//                 generateDunningMessage() runs these at runtime and falls
//                 back to the template on any failure.
//   - 'quality' — style and completeness. Scored by the eval harness
//                 (scripts/eval-dunning.ts) but not enforced at runtime.
//
// Keeping both the runtime guardrail and the offline eval on the same code
// means what we measure is exactly what we enforce.

import type { DunningContext } from './dunning-generator.js';

export type CheckSeverity = 'guard' | 'quality';

export interface CheckResult {
  id: string;
  severity: CheckSeverity;
  passed: boolean;
  reason?: string;
}

export interface DunningCandidate {
  subject: string;
  body: string;
}

export const LIMITS = {
  subjectMaxChars: 200,
  bodyMaxChars: 2000,
  maxSentences: { whatsapp: 5, email: 8 },
} as const;

/** Phrases that threaten, shame or imply intent. Matched case-insensitively. */
export const SHAMING_PHRASES = [
  'legal action',
  'debt collector',
  'collection agency',
  'blacklist',
  'final warning',
  'credit bureau',
  'report you',
  'police',
  'court',
  'irresponsible',
  'you failed to pay',
  'failure to pay will',
  'consequences',
  'shame',
] as const;

const EMOJI_RE = /\p{Extended_Pictographic}/u;
// 12–19 consecutive digits (optionally separated by spaces or dashes) looks
// like a card number (PAN). Virtual account numbers are 10 digits.
const PAN_LIKE_RE = /(?:\d[ -]?){12,19}/g;

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/** "15,000", "15000", "₦15,000.00", "NGN 15 000" all contain the amount. */
export function containsAmount(text: string, amount: number): boolean {
  const whole = String(Math.trunc(amount));
  // Remove thousands separators and spaces that sit between digits.
  const normalised = text.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1');
  return new RegExp(`(^|\\D)${whole}(\\D|$)`).test(normalised);
}

export function countSentences(text: string): number {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[a-z0-9]/i.test(s)).length;
}

/** Name tokens other than the first name, e.g. the surname. */
function nonFirstNameTokens(fullName: string): string[] {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((t) => t.length >= 2);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function checkDunningOutput(ctx: DunningContext, msg: DunningCandidate): CheckResult[] {
  const results: CheckResult[] = [];
  const subject = msg.subject ?? '';
  const body = msg.body ?? '';
  const combined = `${subject}\n${body}`;
  const lower = combined.toLowerCase();

  const add = (id: string, severity: CheckSeverity, passed: boolean, reason?: string) =>
    results.push(passed ? { id, severity, passed } : { id, severity, passed, reason });

  // ---- guard checks -------------------------------------------------------

  add(
    'non_empty',
    'guard',
    subject.trim().length > 0 && body.trim().length > 0,
    'subject or body is empty',
  );

  add(
    'length_caps',
    'guard',
    subject.length <= LIMITS.subjectMaxChars && body.length <= LIMITS.bodyMaxChars,
    `subject ${subject.length}/${LIMITS.subjectMaxChars} or body ${body.length}/${LIMITS.bodyMaxChars} chars`,
  );

  add(
    'states_amount',
    'guard',
    containsAmount(body, ctx.amountNaira),
    `body does not state the amount due (${ctx.amountNaira})`,
  );

  if (ctx.vaAccountNumber) {
    add(
      'virtual_account_number',
      'guard',
      digitsOnly(body).includes(digitsOnly(ctx.vaAccountNumber)),
      'virtual account number missing or altered',
    );
  }

  const shaming = SHAMING_PHRASES.filter((p) => lower.includes(p));
  add('no_shaming', 'guard', shaming.length === 0, `contains: ${shaming.join(', ')}`);

  const leaked = nonFirstNameTokens(ctx.customerName).filter((t) =>
    new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i').test(combined),
  );
  add('no_surname', 'guard', leaked.length === 0, `contains non-first-name tokens: ${leaked.join(', ')}`);

  const vaDigits = ctx.vaAccountNumber ? digitsOnly(ctx.vaAccountNumber) : '';
  const panLike = (combined.match(PAN_LIKE_RE) ?? [])
    .map(digitsOnly)
    .filter((d) => d.length >= 12 && d !== vaDigits);
  add('no_card_like_numbers', 'guard', panLike.length === 0, 'contains a 12–19 digit number');

  // ---- quality checks -----------------------------------------------------

  const sentences = countSentences(body);
  const maxSentences = LIMITS.maxSentences[ctx.channel];
  add(
    'sentence_limit',
    'quality',
    sentences <= maxSentences,
    `${sentences} sentences > ${maxSentences} for ${ctx.channel}`,
  );

  add('no_emoji', 'quality', !EMOJI_RE.test(combined), 'contains emoji');

  if (ctx.paymentLink) {
    add('includes_payment_link', 'quality', body.includes(ctx.paymentLink), 'payment link missing');
  }

  const first = ctx.customerName.trim().split(/\s+/)[0] ?? '';
  if (first) {
    add(
      'addresses_customer',
      'quality',
      new RegExp(`\\b${escapeRegExp(first)}\\b`, 'i').test(body),
      'does not address the customer by first name',
    );
  }

  return results;
}

/** The subset of failures that must block a message at runtime. */
export function guardFailures(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => r.severity === 'guard' && !r.passed);
}
