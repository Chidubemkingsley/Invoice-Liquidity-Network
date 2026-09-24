#!/usr/bin/env node
/**
 * scripts/load-test-notifications.ts — 10× peak notification volume harness (#892 / #1028)
 *
 * Stress-tests the Notifications service at today's measured peak (22 RPS) and at
 * 10× peak (220 RPS). The 10× scenario is the hardened ceiling validation required
 * before mainnet: it identifies the actual bottleneck (queue backpressure vs
 * provider rate limits vs DB writes) and the failure mode once the ceiling is
 * exceeded, so the concurrent rate-limiting/backoff work can be tuned against
 * real numbers, not assumptions.
 *
 * Usage:
 *   pnpm exec tsx scripts/load-test-notifications.ts                # standard 10s smoke
 *   pnpm exec tsx scripts/load-test-notifications.ts --ten-x        # 10× peak soak (120s, 100 VUs)
 *   pnpm exec tsx scripts/load-test-notifications.ts --ten-x --duration 60 --concurrency 85  # custom
 *   pnpm exec tsx scripts/load-test-notifications.ts --duration 30 --concurrency 50           # ad-hoc
 *
 * The --ten-x flag pins the harness to TEN_X_NOTIFICATION_* constants from
 * scripts/lib/load-test-harness.ts (derived from production Grafana) and then
 * allows explicit --duration / --concurrency overrides for sweep experiments.
 */

import {
  getTenXNotificationConfig,
  analyzeBottleneck,
  TEN_X_PEAK_NOTIFICATION_RPS,
  TEN_X_NOTIFICATION_CONCURRENCY,
  TEN_X_NOTIFICATION_DURATION_S,
  MEASURED_PEAK_NOTIFICATION_RPS,
  VALIDATED_NOTIFICATION_CEILING_RPS,
  colors,
  runLoadTest,
  printReport,
  writeMarkdownReport,
  writeJsonReport,
} from './lib/load-test-harness.js';

function parseArgs(): {
  tenX: boolean;
  duration?: number;
  concurrency?: number;
  indexerUrl?: string;
  notificationsUrl?: string;
  report?: string;
  json?: string;
  help: boolean;
} {
  const raw = process.argv.slice(2);
  const out: any = { tenX: false, help: false };
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--ten-x' || a === '--10x') out.tenX = true;
    else if (a === '--duration' && raw[i + 1]) out.duration = parseInt(raw[++i], 10);
    else if (a === '--concurrency' && raw[i + 1]) out.concurrency = parseInt(raw[++i], 10);
    else if (a === '--indexer-url' && raw[i + 1]) out.indexerUrl = raw[++i];
    else if (a === '--notifications-url' && raw[i + 1]) out.notificationsUrl = raw[++i];
    else if (a === '--report' && raw[i + 1]) out.report = raw[++i];
    else if (a === '--json' && raw[i + 1]) out.json = raw[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--service')) { /* ignored — always notifications */ }
  }
  return out;
}

function printUsage(): void {
  console.log(`
${colors.bright}${colors.cyan}ILN Notifications Load Test — 10× Peak Validation${colors.reset}
Usage: pnpm exec tsx scripts/load-test-notifications.ts [options]

Options:
  --ten-x, --10x                 Run the 10×-peak soak (default: ${TEN_X_NOTIFICATION_DURATION_S}s, ${TEN_X_NOTIFICATION_CONCURRENCY} VUs, target ~${TEN_X_PEAK_NOTIFICATION_RPS} RPS)
  --duration <seconds>           Override duration (default smoke 10s; 10× 120s)
  --concurrency <count>          Override VU count
  --notifications-url <url>      Notifications base URL (default: http://localhost:4001)
  --indexer-url <url>            Indexer base URL (default: http://localhost:3001)
  --report <filepath>            Markdown report dest (default: load-test-report.md)
  --json <filepath>              JSON log dest (default: load-test-results.json)
  -h, --help                     This help

Measured peak (prod p95, last 30d): ${MEASURED_PEAK_NOTIFICATION_RPS} RPS → 10× target ${TEN_X_PEAK_NOTIFICATION_RPS} RPS
Validated ceiling (sweep 25→150 VUs): ${VALIDATED_NOTIFICATION_CEILING_RPS} RPS — see docs/load-test-harness.md
`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const base = args.tenX
    ? getTenXNotificationConfig({
        duration: args.duration,
        concurrency: args.concurrency,
        notificationsUrl: args.notificationsUrl,
        indexerUrl: args.indexerUrl,
      })
    : {
        service: 'notifications' as const,
        duration: args.duration ?? 10,
        concurrency: args.concurrency ?? 5,
        indexerUrl: args.indexerUrl ?? 'http://localhost:3001',
        notificationsUrl: args.notificationsUrl ?? 'http://localhost:4001',
        p95Threshold: 500,
        errorThreshold: 2,
        avgThreshold: 200,
        rpsThreshold: 10,
      };

  // If --ten-x but user overrode duration/concurrency, they already applied in getTenXNotificationConfig;
  // otherwise ensure overrides still apply for non-10× case
  if (!args.tenX) {
    // already handled
  }

  console.log(`\n${colors.bright}${colors.magenta}=== NOTIFICATIONS LOAD TEST ${args.tenX ? '(10× PEAK)' : '(smoke)'} ===${colors.reset}`);
  console.log(`${colors.bright}Mode:${colors.reset}            ${args.tenX ? `10× peak validated ceiling sweep` : 'smoke'}`);
  if (args.tenX) {
    console.log(`${colors.bright}Measured peak:${colors.reset}   ${MEASURED_PEAK_NOTIFICATION_RPS} RPS (prod p95, 30d)`);
    console.log(`${colors.bright}Target 10×:${colors.reset}      ${TEN_X_PEAK_NOTIFICATION_RPS} RPS`);
    console.log(`${colors.bright}Validated ceiling:${colors.reset} ${VALIDATED_NOTIFICATION_CEILING_RPS} RPS (sweep 25→150 VUs) — docs/load-test-harness.md`);
  }
  console.log(`${colors.bright}Duration:${colors.reset}         ${base.duration}s`);
  console.log(`${colors.bright}Concurrency:${colors.reset}      ${base.concurrency} VUs`);
  console.log(`${colors.bright}Notifications URL:${colors.reset} ${base.notificationsUrl}`);
  console.log(`${colors.bright}Thresholds:${colors.reset}       avg ${base.avgThreshold}ms | p95 ${base.p95Threshold}ms | err ${base.errorThreshold}% | minRPS ${base.rpsThreshold}\n`);

  const report = await runLoadTest(base);
  printReport(report);
  writeMarkdownReport(report, args.report ?? 'load-test-report.md');
  writeJsonReport(report, args.json ?? 'load-test-results.json');

  if (args.tenX || base.service === 'notifications') {
    const ba = analyzeBottleneck(report);
    console.log(`${colors.bright}${colors.cyan}=== FEEDING INTO RATE-LIMITING & BACKOFF WORK ===${colors.reset}`);
    console.log(`Bottleneck identified: ${colors.bright}${ba.bottleneck}${colors.reset}`);
    console.log(`Validated ceiling: ${ba.validatedCeilingRps.toFixed(1)} RPS @ ${ba.validatedCeilingConcurrency} VUs`);
    console.log(`Reason: ${ba.reason}`);
    console.log(`Recommendation for concurrent batch: ${ba.recommendation}`);
    console.log(`${colors.dim}→ Update notifications/src/config.ts RATE_LIMIT_* and delivery.ts webhookBackoffBaseMs / jitter using these numbers.${colors.reset}\n`);
    // Also emit a short JSON summary that CI can parse
    const summary = {
      tenXTargetRps: TEN_X_PEAK_NOTIFICATION_RPS,
      measuredPeakRps: MEASURED_PEAK_NOTIFICATION_RPS,
      validatedCeilingRps: ba.validatedCeilingRps,
      validatedCeilingConcurrency: ba.validatedCeilingConcurrency,
      bottleneck: ba.bottleneck,
      signals: ba.signals,
      recommendation: ba.recommendation,
      thresholdsPassed: report.thresholds.passed,
    };
    try {
      const { writeFileSync } = await import('fs');
      writeFileSync('load-test-notifications-10x-summary.json', JSON.stringify(summary, null, 2), 'utf-8');
      console.log(`${colors.dim}10× summary written to load-test-notifications-10x-summary.json${colors.reset}`);
    } catch {}
  }

  process.exitCode = report.thresholds.passed ? 0 : 1;
}

main().catch((err) => {
  console.error(`${colors.red}Notifications load test failed: ${err instanceof Error ? err.message : String(err)}${colors.reset}`);
  process.exit(1);
});
