import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

export interface GameDayTimelineEvent {
  timeOffset: string;
  phase: string;
  action: string;
  crossRepoHandshake: string;
}

export function parseGameDayTimeline(filePath: string): GameDayTimelineEvent[] {
  if (!existsSync(filePath)) {
    throw new Error(`Game day report not found at: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const events: GameDayTimelineEvent[] = [];

  let inTable = false;
  for (const line of lines) {
    if (line.includes('| Time Elapsed | Phase |')) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith('|---')) {
      continue;
    }
    if (inTable && line.startsWith('|')) {
      const parts = line.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
      if (parts.length >= 4) {
        events.push({
          timeOffset: parts[0].replace(/\*\*/g, ''),
          phase: parts[1],
          action: parts[2],
          crossRepoHandshake: parts[3],
        });
      }
    } else if (inTable && line.trim() === '') {
      inTable = false;
    }
  }

  return events;
}

describe('Issue #978: Cross-Repo Game-Day Exercise Validation', () => {
  const gameDayReportPath = resolve(REPO_ROOT, 'docs/game-days/cross-repo-exercise-01.md');
  const incidentRunbookPath = resolve(REPO_ROOT, 'docs/runbooks/incident-response.md');

  it('docs/game-days/cross-repo-exercise-01.md exists and documents cross-repo scenario', () => {
    expect(existsSync(gameDayReportPath)).toBe(true);
    const content = readFileSync(gameDayReportPath, 'utf-8');

    expect(content).toContain('Invoice-Liquidity-Network');
    expect(content).toContain('ILN-Frontend');
    expect(content).toContain('ILN-Smart-Contract');
    expect(content).toContain('The Phantom Verification Badge Incident');
  });

  it('documents full detection-to-resolution cycle within 22 minutes', () => {
    const events = parseGameDayTimeline(gameDayReportPath);
    expect(events.length).toBeGreaterThanOrEqual(5);

    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];

    expect(firstEvent.timeOffset).toContain('T+00:00');
    expect(lastEvent.timeOffset).toContain('T+22:00');
  });

  it('documents findings and cross-repo runbook fixes', () => {
    const content = readFileSync(gameDayReportPath, 'utf-8');
    expect(content).toContain('Finding 1');
    expect(content).toContain('Finding 2');
    expect(content).toContain('Finding 3');
    expect(content).toContain('docs/runbooks/incident-response.md');
  });

  it('docs/runbooks/incident-response.md defines 3-step triage and service recovery playbooks', () => {
    expect(existsSync(incidentRunbookPath)).toBe(true);
    const content = readFileSync(incidentRunbookPath, 'utf-8');

    expect(content).toContain('Step 1: Smart Contract Layer Check');
    expect(content).toContain('Step 2: Main Repo Services Check');
    expect(content).toContain('Step 3: Frontend Layer Check');
    expect(content).toContain('Oracle Service Malfunction Recovery Playbook');
    expect(content).toContain('Indexer Sync Degradation Recovery Playbook');
    expect(content).toContain('Notification Delivery Failure Recovery Playbook');
  });
});
