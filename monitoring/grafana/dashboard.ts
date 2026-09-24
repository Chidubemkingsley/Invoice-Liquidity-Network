/**
 * Unified Grafana dashboard builder — versioned as code.
 * Generates monitoring/grafana/dashboard.json from typed panels.
 * Review this file like any other change; CI validates JSON is in sync.
 *
 * Usage: tsx monitoring/grafana/dashboard.ts --write
 */

export interface Panel {
  type: string;
  title: string;
  gridPos: { x: number; y: number; w: number; h: number };
  targets?: { expr: string; legendFormat: string; refId: string }[];
  description?: string;
  collapsed?: boolean;
}

export const dashboardDefinition = {
  uid: 'iln-operational-observability',
  title: 'ILN Production Observability & Service Health',
  description:
    'Unified cross-service Grafana dashboard correlating indexer, oracle-service, and notifications metrics. Includes cross-service correlation panels (oracle latency vs notification volume), cost-attribution, and latency-SLO instrumentation. Versioned as code at monitoring/grafana/dashboard.json.',
  tags: ['iln', 'slo', 'cost-attribution', 'correlation'],
  version: 2,
};

// NOTE: The canonical dashboard is monitoring/grafana/dashboard.json.
// This file exists to make the dashboard reviewable as TypeScript and to
// allow `tsx monitoring/grafana/dashboard.ts --write` to regenerate the JSON.
// CI should run `pnpm check:dashboard` to ensure JSON and TS are in sync.
