import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

export interface ServiceSLO {
  service: string;
  category: string;
  target: string;
  sliFormula: string;
  errorBudget: string;
}

export interface MetricSample {
  totalCount: number;
  successCount: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  ingestionLagSec?: number;
}

export function evaluateSLOCompliance(sloTarget: number, actualSLI: number): {
  compliant: boolean;
  budgetRemainingPercent: number;
} {
  const errorBudget = 100 - sloTarget;
  const actualError = 100 - actualSLI;
  const compliant = actualSLI >= sloTarget;
  const budgetRemainingPercent = Math.max(0, Number(((errorBudget - actualError) / errorBudget * 100).toFixed(2)));

  return { compliant, budgetRemainingPercent };
}

export function parseSLOTable(filePath: string): ServiceSLO[] {
  if (!existsSync(filePath)) {
    throw new Error(`SLO document not found at: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const slos: ServiceSLO[] = [];

  let inTable = false;
  for (const line of lines) {
    if (line.includes('| Service | Category |')) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith('|---')) {
      continue;
    }
    if (inTable && line.startsWith('|')) {
      const parts = line.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
      if (parts.length >= 5) {
        slos.push({
          service: parts[0].replace(/\*\*/g, ''),
          category: parts[1],
          target: parts[2].replace(/\*\*/g, ''),
          sliFormula: parts[3],
          errorBudget: parts[4],
        });
      }
    } else if (inTable && line.trim() === '') {
      inTable = false;
    }
  }

  return slos;
}

describe('Issue #976: Service Level Objectives (SLOs) Configuration & Validation', () => {
  const slosPath = resolve(REPO_ROOT, 'docs/slos.md');
  const crossRepoPath = resolve(REPO_ROOT, 'docs/cross-repo-dependencies.md');

  it('docs/slos.md exists and contains authoritative SLO definitions', () => {
    expect(existsSync(slosPath)).toBe(true);
    const slos = parseSLOTable(slosPath);
    expect(slos.length).toBeGreaterThanOrEqual(6);
  });

  it('defines authoritative targets for Indexer Service', () => {
    const slos = parseSLOTable(slosPath);
    const indexerLag = slos.find((s) => s.service.toLowerCase().includes('indexer') && s.category.toLowerCase().includes('lag'));
    const indexerLatency = slos.find((s) => s.service.toLowerCase().includes('indexer') && s.category.toLowerCase().includes('latency'));
    const indexerUptime = slos.find((s) => s.service.toLowerCase().includes('indexer') && s.category.toLowerCase().includes('availability'));

    expect(indexerLag).toBeDefined();
    expect(indexerLag?.target).toContain('< 5.0s');
    expect(indexerLag?.target).toContain('99.9%');

    expect(indexerLatency).toBeDefined();
    expect(indexerLatency?.target).toContain('p95 < 200ms');

    expect(indexerUptime).toBeDefined();
    expect(indexerUptime?.target).toContain('99.9%');
  });

  it('defines authoritative targets for Oracle Service', () => {
    const slos = parseSLOTable(slosPath);
    const oracleLatency = slos.find((s) => s.service.toLowerCase().includes('oracle') && s.category.toLowerCase().includes('latency'));
    const oracleUptime = slos.find((s) => s.service.toLowerCase().includes('oracle') && s.category.toLowerCase().includes('availability'));

    expect(oracleLatency).toBeDefined();
    expect(oracleLatency?.target).toContain('p95 < 150ms');

    expect(oracleUptime).toBeDefined();
    expect(oracleUptime?.target).toContain('99.95%');
  });

  it('defines authoritative targets for Notification Service', () => {
    const slos = parseSLOTable(slosPath);
    const notifDelivery = slos.find((s) => s.service.toLowerCase().includes('notification') && s.category.toLowerCase().includes('delivery latency'));
    const notifSuccess = slos.find((s) => s.service.toLowerCase().includes('notification') && s.category.toLowerCase().includes('success rate'));

    expect(notifDelivery).toBeDefined();
    expect(notifDelivery?.target).toContain('p95 < 10.0s');

    expect(notifSuccess).toBeDefined();
    expect(notifSuccess?.target).toContain('99.5%');
  });

  it('evaluates SLO compliance and remaining error budget accurately', () => {
    // 99.9% uptime target with 99.92% actual SLI
    const passEval = evaluateSLOCompliance(99.9, 99.92);
    expect(passEval.compliant).toBe(true);
    expect(passEval.budgetRemainingPercent).toBeGreaterThan(0);

    // 99.9% uptime target with 99.85% actual SLI
    const failEval = evaluateSLOCompliance(99.9, 99.85);
    expect(failEval.compliant).toBe(false);
    expect(failEval.budgetRemainingPercent).toBe(0);
  });

  it('cross-repo-dependencies.md references docs/slos.md authoritative targets', () => {
    expect(existsSync(crossRepoPath)).toBe(true);
    const content = readFileSync(crossRepoPath, 'utf-8');
    expect(content).toContain('docs/slos.md');
    expect(content).toContain('< 5.0s');
    expect(content).toContain('p95 < 150ms');
    expect(content).toContain('p95 < 10.0s');
  });
});
