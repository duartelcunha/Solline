import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG, catalogDefinition } from '../src/index.ts';
import { recordingSink } from './helpers.ts';

const runOmp = process.env.SOLLINE_AGENTS?.split(',').includes('omp') ?? false;

async function removeDirEventually(dir: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

describe.skipIf(!runOmp)('omp acp real (smoke sem consumo de tokens)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => removeDirEventually(d)));
  });

  it('arranca omp acp com o overlay always-ask, anuncia steering e devolve too-late em repouso', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'solline-omp-real-'));
    dirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    const agentDir = path.join(tmp, 'agent');
    const cwd = path.join(tmp, 'proj');
    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);

    const omp = CATALOG.find((e) => e.id === 'omp');
    expect(omp).toBeDefined();
    const def = catalogDefinition(omp!, { dataDir });
    const detected = await def.detect({ refresh: true });
    expect(detected).toEqual({
      status: 'ready',
      version: { installed: omp!.reviewedVersion, reviewed: omp!.reviewedVersion },
    });

    const sink = recordingSink();
    const adapter = def.create(
      {
        cwd,
        mode: null,
        projectTrusted: true,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      },
      sink,
    );

    const started = await adapter.start();
    expect(started.capabilities.features.steer).toBe(true);
    expect(started.settings.mode).not.toBe('yolo');

    const overlay = await readFile(path.join(dataDir, 'agents', 'omp-solline-overlay.yml'), 'utf8');
    expect(overlay).toContain('approvalMode: always-ask');

    expect(adapter.steer).toBeTypeOf('function');
    await expect(adapter.steer!('ping em repouso', 'st-idle')).resolves.toBe('too-late');
    await adapter.close();
  }, 30_000);
});
