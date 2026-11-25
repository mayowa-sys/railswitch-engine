// Unit tests for the deterministic dunning checks used by both the runtime
// guardrail and the eval harness.

import { describe, it, expect } from 'vitest';
import {
  checkDunningOutput,
  containsAmount,
  countSentences,
  guardFailures,
} from '../../src/ai/dunning-checks.js';
import type { DunningContext } from '../../src/ai/dunning-generator.js';

const vaCtx: DunningContext = {
  channel: 'whatsapp',
  stage: 'va_fallback',
  customerName: 'Tunde Bakare',
  planName: 'Family',
  amountNaira: 24500,
  vaAccountNumber: '9876543210',
  vaBankName: 'Nomba MFB',
};

const good = {
  subject: 'Payment reminder',
  body: 'Hi Tunde, your Family plan payment of ₦24,500 did not go through. Please transfer it to account 9876543210 (Nomba MFB) to keep your plan active. Thank you.',
};

const failedIds = (body: string, subject = 'Reminder', ctx = vaCtx) =>
  checkDunningOutput(ctx, { subject, body })
    .filter((r) => !r.passed)
    .map((r) => r.id);

describe('containsAmount', () => {
  it.each([
    ['₦24,500', true],
    ['NGN 24500', true],
    ['₦24,500.00', true],
    ['24 500 naira', true],
    ['₦245,000', false],
    ['₦2,450', false],
  ])('%s → %s', (text, expected) => {
    expect(containsAmount(text, 24500)).toBe(expected);
  });

  it('handles seven-figure amounts', () => {
    expect(containsAmount('Amount due: ₦3,750,000.', 3750000)).toBe(true);
  });
});

describe('countSentences', () => {
  it('counts sentences across punctuation and newlines', () => {
    expect(countSentences('Hi Ada. Your payment failed! Pay now?\nThanks')).toBe(4);
  });
});

describe('checkDunningOutput', () => {
  it('passes a good message with no guard failures', () => {
    expect(guardFailures(checkDunningOutput(vaCtx, good))).toEqual([]);
    expect(failedIds(good.body, good.subject)).toEqual([]);
  });

  it('flags a missing amount', () => {
    expect(failedIds('Hi Tunde, please pay to 9876543210.')).toContain('states_amount');
  });

  it('flags a missing or altered virtual account number', () => {
    expect(failedIds('Hi Tunde, pay ₦24,500 to 9876543211.')).toContain('virtual_account_number');
    expect(failedIds('Hi Tunde, pay ₦24,500 to your account.')).toContain('virtual_account_number');
  });

  it('accepts a spaced-out virtual account number', () => {
    expect(failedIds('Hi Tunde, pay ₦24,500 to 987 654 3210.')).not.toContain('virtual_account_number');
  });

  it('flags shaming or threatening language', () => {
    const ids = failedIds('Hi Tunde, pay ₦24,500 to 9876543210 or we take legal action.');
    expect(ids).toContain('no_shaming');
  });

  it('flags the customer surname appearing in the copy', () => {
    expect(failedIds('Dear Tunde Bakare, pay ₦24,500 to 9876543210.')).toContain('no_surname');
  });

  it('flags card-number-like digit runs but not the VA number', () => {
    expect(failedIds('Hi Tunde, card 5399 8312 3456 7890 failed. Pay ₦24,500 to 9876543210.')).toContain(
      'no_card_like_numbers',
    );
    expect(failedIds(good.body)).not.toContain('no_card_like_numbers');
  });

  it('flags empty fields and oversize copy', () => {
    expect(failedIds('Hi Tunde, ₦24,500 to 9876543210.', '')).toContain('non_empty');
    expect(failedIds(`Hi Tunde, ₦24,500 to 9876543210. ${'x'.repeat(2100)}`)).toContain('length_caps');
  });

  it('scores quality issues without making them guard failures', () => {
    const body =
      'Hi Tunde 🙂. One. Two. Three. Four. Five. Pay ₦24,500 to 9876543210.';
    const results = checkDunningOutput(vaCtx, { subject: 'Reminder', body });
    expect(results.find((r) => r.id === 'no_emoji')?.passed).toBe(false);
    expect(results.find((r) => r.id === 'sentence_limit')?.passed).toBe(false);
    expect(guardFailures(results)).toEqual([]);
  });

  it('only checks the payment link when one is provided', () => {
    const withLink = { ...vaCtx, paymentLink: 'https://pay.railswitch.dev/i/x' };
    expect(failedIds(good.body, good.subject, withLink)).toContain('includes_payment_link');
    expect(failedIds(good.body, good.subject)).not.toContain('includes_payment_link');
  });
});
