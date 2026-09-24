import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

export interface ActionItem {
  description: string;
  type: string;
  owner: string;
  targetRepo: string;
  status: string;
}

export function parsePostmortemActionItems(filePath: string): ActionItem[] {
  if (!existsSync(filePath)) {
    throw new Error(`Postmortem file not found at: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const actionItems: ActionItem[] = [];

  let inTable = false;
  for (const line of lines) {
    if (line.includes('| Action Item | Type |')) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith('|---')) {
      continue;
    }
    if (inTable && line.startsWith('|')) {
      const parts = line.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
      if (parts.length >= 6) {
        actionItems.push({
          description: parts[0],
          type: parts[1],
          owner: parts[2],
          targetRepo: parts[3],
          status: parts[5],
        });
      }
    } else if (inTable && line.trim() === '') {
      inTable = false;
    }
  }

  return actionItems;
}

describe('Issue #979: Shared Cross-Repo Postmortem Process Validation', () => {
  const postmortemsDir = resolve(REPO_ROOT, 'docs/postmortems');
  const readmePath = resolve(postmortemsDir, 'README.md');
  const templatePath = resolve(postmortemsDir, 'TEMPLATE.md');
  const processPath = resolve(postmortemsDir, 'PROCESS.md');
  const retroPath = resolve(postmortemsDir, '2026-08-30-cross-repo-game-day-oracle-malfunction.md');

  it('docs/postmortems/ directory contains all core governance files', () => {
    expect(existsSync(readmePath)).toBe(true);
    expect(existsSync(templatePath)).toBe(true);
    expect(existsSync(processPath)).toBe(true);
    expect(existsSync(retroPath)).toBe(true);
  });

  it('README.md establishes canonical repository home and links postmortem entries', () => {
    const content = readFileSync(readmePath, 'utf-8');
    expect(content).toContain('Invoice-Liquidity-Network');
    expect(content).toContain('ILN-Frontend');
    expect(content).toContain('ILN-Smart-Contract');
    expect(content).toContain('2026-08-30-cross-repo-game-day-oracle-malfunction.md');
  });

  it('TEMPLATE.md defines required postmortem section headers', () => {
    const content = readFileSync(templatePath, 'utf-8');
    expect(content).toContain('## 1. Executive Summary');
    expect(content).toContain('## 2. Impact & SLO Budget Depletion');
    expect(content).toContain('## 3. Incident Timeline (UTC)');
    expect(content).toContain('## 4. Root Cause Analysis (5 Whys)');
    expect(content).toContain('## 5. Cross-Repo Cascading Effects & Technical Breakdown');
    expect(content).toContain('## 6. Action Items (Corrective & Preventative)');
  });

  it('PROCESS.md defines postmortem operational lifecycle and SLA timelines', () => {
    const content = readFileSync(processPath, 'utf-8');
    expect(content).toContain('Postmortem Operational Lifecycle');
    expect(content).toContain('Step 1: Draft Creation');
    expect(content).toContain('Step 2: Cross-Repo Async Review');
    expect(content).toContain('Step 3: Blameless Walkthrough');
    expect(content).toContain('Step 4: Approval & Index Sync');
  });

  it('retroactive postmortem entry includes game-day findings and assigned action items', () => {
    const content = readFileSync(retroPath, 'utf-8');
    expect(content).toContain('Game-Day #1 Oracle Cache Malfunction');
    expect(content).toContain('Oracle Service Availability SLO');

    const actionItems = parsePostmortemActionItems(retroPath);
    expect(actionItems.length).toBeGreaterThanOrEqual(4);

    const backendAction = actionItems.find((a) => a.targetRepo === '`Invoice-Liquidity-Network`');
    expect(backendAction).toBeDefined();
    expect(backendAction?.status).toBe('DONE');
  });
});
