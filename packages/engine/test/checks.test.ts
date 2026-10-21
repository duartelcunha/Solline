import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Checks, CheckSpec } from '@solline/protocol';
import { detectChecks } from '../src/checks/detect.ts';
import { ProjectChecks, checkFixMessage } from '../src/checks/project-checks.ts';
import { runCommand, tailOf, type CommandOutcome, type RunCommand } from '../src/checks/run.ts';

const dirs: string[] = [];
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'solline-checks-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const spec = (id: string, enabled = true): CheckSpec => ({
  id,
  label: id,
  command: `run ${id}`,
  enabled,
});

/** Um corredor falso: cada comando espera até o teste o resolver. */
function fakeRunner() {
  const pending = new Map<string, (o: CommandOutcome) => void>();
  const calls: string[] = [];
  const run: RunCommand = (command, { signal }) =>
    new Promise((resolve, reject) => {
      calls.push(command);
      pending.set(command, resolve);
      signal.addEventListener('abort', () => reject(new Error('cancelled')));
    });
  const finish = (command: string, outcome: CommandOutcome) => pending.get(command)?.(outcome);
  return { run, calls, finish };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('encontrar as verificações', () => {
  it('lê os scripts da raiz e o gestor de pacotes pelo lock; os testes vêm desligados', async () => {
    const dir = await project({
      'package.json': JSON.stringify({
        scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest' },
      }),
      'pnpm-lock.yaml': '',
    });
    expect(await detectChecks(dir)).toEqual([
      { id: 'typecheck', label: 'Tipos', command: 'pnpm typecheck', enabled: true },
      { id: 'lint', label: 'Lint', command: 'pnpm lint', enabled: true },
      { id: 'test', label: 'Testes', command: 'pnpm test', enabled: false },
    ]);
  });

  it('sem lock usa npm run; sem package.json não há nenhuma', async () => {
    const npm = await project({ 'package.json': JSON.stringify({ scripts: { lint: 'x' } }) });
    expect((await detectChecks(npm)).map((c) => c.command)).toEqual(['npm run lint']);
    expect(await detectChecks(await project({}))).toEqual([]);
    expect(await detectChecks(await project({ 'package.json': '{ partido' }))).toEqual([]);
  });
});

describe('correr um comando', () => {
  it('passa com código 0 e guarda o fim da saída quando falha', async () => {
    const cwd = await project({});
    const signal = new AbortController().signal;
    expect(await runCommand('node -e "process.exit(0)"', { cwd, signal })).toMatchObject({
      state: 'passed',
      tail: null,
    });
    const failed = await runCommand('node -e "console.error(\'partiu aqui\'); process.exit(2)"', {
      cwd,
      signal,
    });
    expect(failed.state).toBe('failed');
    expect(failed.tail).toContain('partiu aqui');
  });

  it('passar o limite é timeout; cancelar rejeita', async () => {
    const cwd = await project({});
    const slow = 'node -e "setTimeout(() => {}, 20000)"';
    const timed = await runCommand(slow, {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 300,
    });
    expect(timed.state).toBe('timeout');
    const abort = new AbortController();
    const running = runCommand(slow, { cwd, signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    await expect(running).rejects.toThrow('cancelled');
  }, 20_000);

  it('o fim da saída vem sem cores e só com as últimas linhas', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `\u001b[31mlinha ${i}\u001b[0m`).join('\n');
    const tail = tailOf(`${lines}\n\n`);
    expect(tail.split('\n')).toHaveLength(40);
    expect(tail).not.toContain('\u001b');
    expect(tail.endsWith('linha 59')).toBe(true);
  });
});

describe('verificações de um projeto', () => {
  function setup(options: { trusted?: boolean; saved?: CheckSpec[] | null } = {}) {
    const runner = fakeRunner();
    const states: Checks[] = [];
    const checks = new ProjectChecks({
      cwd: '.',
      saved: options.saved === undefined ? [spec('a'), spec('b'), spec('c', false)] : options.saved,
      trusted: options.trusted ?? true,
      run: runner.run,
      detect: async () => [spec('detetada')],
      emit: (s) => states.push(s),
    });
    return { checks, runner, states };
  }

  it('corre só as ligadas, ao mesmo tempo, e mostra cada resultado quando chega', async () => {
    const { checks, runner } = setup();
    const done = checks.run('t1');
    await tick();
    expect(runner.calls).toEqual(['run a', 'run b']);
    expect(checks.state.results.map((r) => r.state)).toEqual(['running', 'running']);
    runner.finish('run a', { state: 'passed', tail: null, durationMs: 5 });
    await tick();
    expect(checks.state.results.map((r) => r.state)).toEqual(['passed', 'running']);
    runner.finish('run b', { state: 'failed', tail: 'erro', durationMs: 9 });
    await done;
    expect(checks.state).toMatchObject({ turnId: 't1' });
    expect(checks.failure('b')?.result.tail).toBe('erro');
    expect(checks.failure('a')).toBeNull();
  });

  it('sem confiança não corre nada; perder a confiança apaga os resultados', async () => {
    const untrusted = setup({ trusted: false });
    await untrusted.checks.run('t1');
    expect(untrusted.runner.calls).toEqual([]);

    const { checks, runner } = setup();
    void checks.run('t1');
    await tick();
    checks.setTrusted(false);
    expect(checks.state).toMatchObject({ trusted: false, results: [], turnId: null });
    runner.finish('run a', { state: 'passed', tail: null, durationMs: 1 });
    await tick();
    expect(checks.state.results).toEqual([]);
  });

  it('um turno novo cancela a ronda a meio; rebobinar esquece os resultados', async () => {
    const { checks, runner } = setup();
    void checks.run('t1');
    await tick();
    checks.cancel();
    expect(checks.state.results).toEqual([]);
    runner.finish('run a', { state: 'failed', tail: 'velho', durationMs: 1 });
    await tick();
    expect(checks.state.results).toEqual([]);

    const second = checks.run('t2');
    await tick();
    runner.finish('run a', { state: 'passed', tail: null, durationMs: 1 });
    runner.finish('run b', { state: 'passed', tail: null, durationMs: 1 });
    await second;
    expect(checks.state.turnId).toBe('t2');
    checks.reset();
    expect(checks.state).toMatchObject({ turnId: null, results: [] });
  });

  it('uma ronda nova recomeça com o estado novo', async () => {
    const { checks, runner } = setup();
    void checks.run('t1');
    await tick();
    const second = checks.run('t2');
    await tick();
    runner.finish('run a', { state: 'passed', tail: null, durationMs: 1 });
    runner.finish('run b', { state: 'passed', tail: null, durationMs: 1 });
    await second;
    expect(checks.state.turnId).toBe('t2');
    expect(checks.state.results.every((r) => r.state === 'passed')).toBe(true);
  });

  it('sem lista guardada usa a detetada; guardar uma troca-a', async () => {
    const { checks } = setup({ saved: null });
    await checks.refresh();
    expect(checks.state).toMatchObject({ detected: true, specs: [spec('detetada')] });
    await checks.configure([spec('minha')]);
    expect(checks.state).toMatchObject({ detected: false, specs: [spec('minha')] });
  });

  it('a mensagem para o agente cita o comando e o erro, e pede para não contornar', () => {
    const text = checkFixMessage(spec('lint'), {
      id: 'lint',
      state: 'failed',
      tail: 'no-unused-vars',
      durationMs: 1,
    });
    expect(text).toContain('`run lint`');
    expect(text).toContain('no-unused-vars');
    expect(text).toContain('não desligues');
  });
});
