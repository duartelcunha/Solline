import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '@solline/protocol';
import { claudeReviewer } from '../src/index.ts';
import { realAgents } from './real-agents.ts';

/**
 * O revisor de verdade (Sonnet, só leitura) sobre um diff com um erro óbvio: tem de o
 * apanhar, preso à linha certa, no formato do esquema.
 */
const skip = !realAgents().has('claude');

describe.skipIf(skip)('revisor (Claude real)', () => {
  it('apanha uma divisão invertida e diz a linha', { timeout: 240_000 }, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'solline-reviewer-'));
    const code = [
      '/** A média de uma lista de números. */',
      'export function average(values: number[]): number {',
      '  const total = values.reduce((a, b) => a + b, 0);',
      '  return values.length / total;',
      '}',
      '',
    ].join('\n');
    await writeFile(path.join(cwd, 'average.ts'), code);
    const diff: FileDiff[] = [
      {
        path: 'average.ts',
        status: 'added',
        binary: false,
        additions: 5,
        deletions: 0,
        hunks: [
          {
            id: 'h',
            header: '@@ -0,0 +1,5 @@',
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 5,
            lines: code
              .trimEnd()
              .split('\n')
              .map((text, i) => ({ kind: 'add' as const, text, oldNo: null, newNo: i + 1 })),
          },
        ],
      },
    ];
    try {
      const findings = await claudeReviewer()({
        cwd,
        diff,
        request: 'Escreve uma função que calcula a média.',
        trusted: false,
      });
      console.info('[revisor]', JSON.stringify(findings));
      const bug = findings.find((f) => f.severity === 'bug');
      expect(bug).toMatchObject({ path: 'average.ts', line: 4 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
