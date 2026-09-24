import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import {
  generateObservabilityDigest,
  getDefaultMainRepoDigestData,
  writeObservabilityDigestReport,
  type DigestData,
} from '../weekly-observability-digest';

describe('Issue #977: Weekly Observability Digest Generator', () => {
  const testOutputPath = resolve(import.meta.dirname, '../__fixtures__/weekly-digest-test-output.md');

  it('generateObservabilityDigest produces valid markdown with main-repo scope', () => {
    const data = getDefaultMainRepoDigestData();
    const markdown = generateObservabilityDigest(data);

    expect(markdown).toContain('# Weekly Observability Digest - Main Repo Services');
    expect(markdown).toContain('**Scope**: `main-repo`');
    expect(markdown).toContain('## 1. Service Level Objective (SLO) Compliance');
    expect(markdown).toContain('## 2. Service Error Trends (7-Day Sliding Window)');
    expect(markdown).toContain('## 3. Canary Check Results (Issue #975 Probe Alignment)');
    expect(markdown).toContain('## 4. Cross-Repo Observability Coordination');
  });

  it('includes default main-repo service metrics and SLO targets', () => {
    const data = getDefaultMainRepoDigestData();
    const markdown = generateObservabilityDigest(data);

    expect(markdown).toContain('Indexer');
    expect(markdown).toContain('Oracle Service');
    expect(markdown).toContain('Notification Service');
    expect(markdown).toContain('Ingestion Lag (< 5.0s)');
    expect(markdown).toContain('API Verification p95 Latency');
    expect(markdown).toContain('Delivery p95 Latency');
  });

  it('formats error trends and canary status badges correctly', () => {
    const data = getDefaultMainRepoDigestData();
    const markdown = generateObservabilityDigest(data);

    expect(markdown).toContain('➡️ Stable');
    expect(markdown).toContain('📉 Decreasing');
    expect(markdown).toContain('🟢 PASS');
    expect(markdown).toContain('Stellar RPC Horizon');
  });

  it('highlights required action items when SLO breaches exist', () => {
    const customData: DigestData = {
      ...getDefaultMainRepoDigestData(),
      overallHealthStatus: 'DEGRADED',
      slos: [
        {
          service: 'Oracle Service',
          metric: 'API Verification p95 Latency',
          target: '< 150ms',
          actualSLI: 320,
          unit: 'ms',
          compliant: false,
        },
      ],
    };

    const markdown = generateObservabilityDigest(customData);
    expect(markdown).toContain('Action Required');
    expect(markdown).toContain('Oracle Service API Verification p95 Latency');
  });

  it('writeObservabilityDigestReport writes markdown file to specified path', () => {
    if (existsSync(testOutputPath)) {
      rmSync(testOutputPath);
    }

    const content = writeObservabilityDigestReport(testOutputPath);
    expect(existsSync(testOutputPath)).toBe(true);

    const fileContent = readFileSync(testOutputPath, 'utf-8');
    expect(fileContent).toEqual(content);
    expect(fileContent).toContain('Weekly Observability Digest');

    // Clean up test file
    rmSync(testOutputPath);
  });
});
