// Live eval for the Gemini dunning generator.
//
// Generates N samples per golden case (evals/dunning/cases.json) against the
// real model, scores every sample with src/ai/dunning-checks.ts, and writes a
// scorecard to evals/dunning/results/. Exits non-zero if the run falls below
// evals/dunning/thresholds.json, so it can gate prompt or model changes.
//
// Run:  cd services/engine && GEMINI_API_KEY=... npm run eval:dunning -- --samples 5
//
// Without GEMINI_API_KEY the script exits 0 and says it skipped.

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiClient } from '../src/ai/gemini-client.js';
import {
  buildUserPrompt,
  GENERATION_TEMPERATURE,
  SYSTEM_PROMPT,
  type DunningContext,
} from '../src/ai/dunning-generator.js';
import { checkDunningOutput, type CheckResult } from '../src/ai/dunning-checks.js';

const here = dirname(fileURLToPath(import.meta.url));
const evalDir = join(here, '..', 'evals', 'dunning');

interface GoldenCase {
  id: string;
  notes?: string;
  ctx: DunningContext;
}

interface Thresholds {
  minGuardPassRate: number;
  minQualityPassRate: number;
  maxFallbackRate: number;
  minSamplesPerCase: number;
}

interface SampleResult {
  caseId: string;
  sample: number;
  latencyMs: number;
  output: { subject: string; body: string } | null;
  checks: CheckResult[];
  guardPassed: boolean;
}

function parseSamples(argv: string[]): number {
  const i = argv.indexOf('--samples');
  const n = i >= 0 ? Number(argv[i + 1]) : 3;
  return Number.isInteger(n) && n > 0 ? n : 3;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log('eval-dunning: GEMINI_API_KEY not set — skipping live eval.');
    return;
  }

  const { cases } = JSON.parse(readFileSync(join(evalDir, 'cases.json'), 'utf8')) as { cases: GoldenCase[] };
  const thresholds = JSON.parse(readFileSync(join(evalDir, 'thresholds.json'), 'utf8')) as Thresholds;
  const samples = Math.max(parseSamples(process.argv), thresholds.minSamplesPerCase);
  const client = new GeminiClient();
  const results: SampleResult[] = [];

  for (const c of cases) {
    for (let s = 1; s <= samples; s++) {
      const started = Date.now();
      const raw = await client.generateJSON<{ subject?: unknown; body?: unknown }>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(c.ctx),
        temperature: GENERATION_TEMPERATURE,
        maxOutputTokens: 400,
      });
      const latencyMs = Date.now() - started;
      const output =
        raw && typeof raw.subject === 'string' && typeof raw.body === 'string'
          ? { subject: raw.subject.trim(), body: raw.body.trim() }
          : null;
      const checks = output ? checkDunningOutput(c.ctx, output) : [];
      const guardPassed = output !== null && checks.every((r) => r.severity !== 'guard' || r.passed);
      results.push({ caseId: c.id, sample: s, latencyMs, output, checks, guardPassed });
      process.stdout.write(guardPassed ? '.' : 'x');
    }
  }
  process.stdout.write('\n');

  // ---- aggregate -----------------------------------------------------------
  const total = results.length;
  const fallbackRate = results.filter((r) => !r.guardPassed).length / total;
  const guardPassRate = 1 - fallbackRate;
  const qualityChecks = results.flatMap((r) => r.checks.filter((c) => c.severity === 'quality'));
  const qualityPassRate = qualityChecks.length
    ? qualityChecks.filter((c) => c.passed).length / qualityChecks.length
    : 0;
  const latencies = results.map((r) => r.latencyMs);

  const byCheck = new Map<string, { severity: string; pass: number; total: number }>();
  for (const r of results) {
    for (const c of r.checks) {
      const e = byCheck.get(c.id) ?? { severity: c.severity, pass: 0, total: 0 };
      e.total += 1;
      if (c.passed) e.pass += 1;
      byCheck.set(c.id, e);
    }
  }

  const failures: string[] = [];
  if (guardPassRate < thresholds.minGuardPassRate)
    failures.push(`guard pass rate ${pct(guardPassRate)} < ${pct(thresholds.minGuardPassRate)}`);
  if (qualityPassRate < thresholds.minQualityPassRate)
    failures.push(`quality pass rate ${pct(qualityPassRate)} < ${pct(thresholds.minQualityPassRate)}`);
  if (fallbackRate > thresholds.maxFallbackRate)
    failures.push(`fallback rate ${pct(fallbackRate)} > ${pct(thresholds.maxFallbackRate)}`);

  // ---- report --------------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const model = process.env.GEMINI_MODEL ?? 'default';
  const lines: string[] = [
    `# Dunning eval — ${stamp}`,
    '',
    `Model: \`${model}\` · cases: ${cases.length} · samples/case: ${samples} · total: ${total}`,
    '',
    '| Metric | Value | Threshold |',
    '|---|---|---|',
    `| Guard pass rate (copy a customer could see) | ${pct(guardPassRate)} | ≥ ${pct(thresholds.minGuardPassRate)} |`,
    `| Fallback rate (template shown instead) | ${pct(fallbackRate)} | ≤ ${pct(thresholds.maxFallbackRate)} |`,
    `| Quality check pass rate | ${pct(qualityPassRate)} | ≥ ${pct(thresholds.minQualityPassRate)} |`,
    `| Latency p50 / p95 | ${percentile(latencies, 50)} ms / ${percentile(latencies, 95)} ms | — |`,
    '',
    '## By check',
    '',
    '| Check | Severity | Pass rate |',
    '|---|---|---|',
    ...[...byCheck.entries()].map(([id, e]) => `| ${id} | ${e.severity} | ${pct(e.pass / e.total)} (${e.pass}/${e.total}) |`),
    '',
    '## By case',
    '',
    '| Case | Guard pass | Failed checks |',
    '|---|---|---|',
    ...cases.map((c) => {
      const rs = results.filter((r) => r.caseId === c.id);
      const failed = [...new Set(rs.flatMap((r) => (r.output ? r.checks.filter((x) => !x.passed).map((x) => x.id) : ['no_output'])))];
      return `| ${c.id} | ${rs.filter((r) => r.guardPassed).length}/${rs.length} | ${failed.join(', ') || '—'} |`;
    }),
    '',
    failures.length ? `**FAILED:** ${failures.join('; ')}` : '**PASSED** all thresholds.',
    '',
  ];

  const outDir = join(evalDir, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${stamp}.md`), lines.join('\n'));
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ model, samples, thresholds, results }, null, 2));

  console.log(lines.join('\n'));
  console.log(`Report written to evals/dunning/results/${stamp}.md`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
