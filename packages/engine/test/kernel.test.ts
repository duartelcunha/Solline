import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCapabilities, CheckSpec } from '@solline/protocol';
import { ProjectChecks } from '../src/checks/project-checks.ts';
import { type RunCommand } from '../src/checks/run.ts';
import { registryOf } from '../src/agents/registry.ts';
import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitRegistry,
  Engine,
  EngineEventBus,
  EngineKernel,
  createToken,
  type KernelModule,
} from '../src/index.ts';

const dirs: string[] = [];
const engines: Engine[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'solline-kernel-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose().catch(() => undefined)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('EngineKernel e EngineEventBus', () => {
  it('arranca em ordem topológica e fecha na ordem inversa', async () => {
    const trace: string[] = [];
    const TOK_A = createToken<string>('svc.a');
    const kernel = new EngineKernel();

    const modB: KernelModule = {
      manifest: { id: 'mod.b', version: '1.0.0', dependsOn: ['mod.a'] },
      init(ctx) {
        trace.push(`init:b:${ctx.inject(TOK_A)}`);
      },
      start() {
        trace.push('start:b');
      },
      dispose() {
        trace.push('dispose:b');
      },
    };
    const modA: KernelModule = {
      manifest: { id: 'mod.a', version: '1.0.0' },
      init(ctx) {
        ctx.provide(TOK_A, 'ok');
        trace.push('init:a');
      },
      start() {
        trace.push('start:a');
      },
      dispose() {
        trace.push('dispose:a');
      },
    };
    const modC: KernelModule = {
      manifest: { id: 'mod.c', version: '1.0.0', dependsOn: ['mod.b'] },
      init() {
        trace.push('init:c');
      },
      start() {
        trace.push('start:c');
      },
      dispose() {
        trace.push('dispose:c');
      },
    };

    kernel.register(modC);
    kernel.register(modB);
    kernel.register(modA);
    await kernel.boot();
    expect(trace).toEqual(['init:a', 'init:b:ok', 'init:c', 'start:a', 'start:b', 'start:c']);
    expect(kernel.health().modules.map((m) => [m.id, m.state])).toEqual([
      ['mod.c', 'running'],
      ['mod.b', 'running'],
      ['mod.a', 'running'],
    ]);

    await kernel.shutdown();
    expect(trace.slice(-3)).toEqual(['dispose:c', 'dispose:b', 'dispose:a']);
    expect(kernel.health().modules.every((m) => m.state === 'stopped')).toBe(true);
  });

  it('valida manifestos por Zod e recusa ciclos ou dependências em falta', async () => {
    const kernel = new EngineKernel();
    expect(() =>
      kernel.register({
        manifest: { id: 'INVALID ID', version: '1.0.0' },
        init() {},
      }),
    ).toThrow();

    const missing = new EngineKernel();
    missing.register({
      manifest: { id: 'child', version: '1.0.0', dependsOn: ['ghost'] },
      init() {},
    });
    await expect(missing.boot()).rejects.toThrow('ghost');

    const cycle = new EngineKernel();
    cycle.register({ manifest: { id: 'x', version: '1.0.0', dependsOn: ['y'] }, init() {} });
    cycle.register({ manifest: { id: 'y', version: '1.0.0', dependsOn: ['x'] }, init() {} });
    await expect(cycle.boot()).rejects.toThrow('Ciclo');
  });

  it('isola falhas de módulos não críticos como degraded sem parar os essenciais', async () => {
    const kernel = new EngineKernel();
    kernel.register({
      manifest: { id: 'core', version: '1.0.0', critical: true },
      init() {},
    });
    kernel.register({
      manifest: { id: 'optional-fail-init', version: '1.0.0', critical: false },
      init() {
        throw new Error('falha opcional no init');
      },
    });
    kernel.register({
      manifest: { id: 'optional-fail-start', version: '1.0.0', critical: false },
      init() {},
      start() {
        throw new Error('falha opcional no start');
      },
    });

    await kernel.boot();
    expect(kernel.moduleHealth('core')?.state).toBe('running');
    expect(kernel.moduleHealth('optional-fail-init')).toMatchObject({
      state: 'degraded',
      lastError: 'falha opcional no init',
    });
    expect(kernel.moduleHealth('optional-fail-start')).toMatchObject({
      state: 'degraded',
      lastError: 'falha opcional no start',
    });

    const critical = new EngineKernel();
    critical.register({
      manifest: { id: 'vital', version: '1.0.0', critical: true },
      init() {
        throw new Error('boom');
      },
    });
    await expect(critical.boot()).rejects.toThrow('boom');
    expect(critical.moduleHealth('vital')?.state).toBe('degraded');
  });

  it('isola subscritores no barramento e degrada módulo não crítico que lance em evento', async () => {
    const errors: string[] = [];
    const seen: string[] = [];
    const bus = new EngineEventBus({
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
    });
    const kernel = new EngineKernel({ bus });

    kernel.register({
      manifest: { id: 'bad-listener', version: '1.0.0', critical: false },
      init(ctx) {
        ctx.on('engine.ready', () => {
          throw new Error('listener falhou');
        });
      },
    });
    kernel.register({
      manifest: { id: 'good-listener', version: '1.0.0', critical: true },
      init(ctx) {
        ctx.on('engine.ready', () => seen.push('targeted'));
        ctx.on('*', () => seen.push('wildcard'));
      },
    });
    await kernel.boot();
    bus.on('engine.ready', () => {
      throw new Error('raw-sub falhou');
    });

    bus.emit({ kind: 'event', type: 'engine.ready', engineVersion: 'test', pid: 1 });
    expect(seen).toEqual(['targeted', 'wildcard']);
    expect(errors).toEqual(['raw-sub falhou']);
    expect(kernel.moduleHealth('bad-listener')).toMatchObject({
      state: 'degraded',
      lastError: 'listener falhou',
    });
  });

  it('permite desligar e voltar a ligar módulos toggleable e recusa essenciais', async () => {
    let disposed = 0;
    let inits = 0;
    const kernel = new EngineKernel();
    kernel.register({
      manifest: {
        id: 'essential',
        version: '1.0.0',
        critical: true,
        toggleable: false,
      },
      init() {},
    });
    kernel.register({
      manifest: {
        id: 'addon',
        version: '1.0.0',
        critical: false,
        toggleable: true,
        commands: ['engine.ping'],
      },
      init(ctx) {
        inits += 1;
        ctx.registerCommand('engine.ping', () => ({
          pong: true,
          engineVersion: 'test',
          pid: 1,
          receivedAt: inits,
        }));
      },
      dispose() {
        disposed += 1;
      },
    });
    await kernel.boot();
    expect(kernel.getCommand('engine.ping')).toBeDefined();

    await expect(kernel.setModuleEnabled('essential', false)).rejects.toThrow('essencial');
    const disabled = await kernel.setModuleEnabled('addon', false);
    expect(disabled.state).toBe('disabled');
    expect(disposed).toBe(1);
    expect(kernel.getCommand('engine.ping')).toBeUndefined();

    const enabled = await kernel.setModuleEnabled('addon', true);
    expect(enabled.state).toBe('running');
    expect(inits).toBe(2);
    expect(kernel.getCommand('engine.ping')).toBeDefined();
  });
});

describe('CircuitBreaker e fronteiras externas', () => {
  it('transita closed -> open -> half-open -> closed e protege corrida concorrente', async () => {
    let now = 1_000;
    const breaker = new CircuitBreaker('ext', {
      threshold: 2,
      resetMs: 5_000,
      now: () => now,
    });

    // Erro excluído por tripOn nunca abre o circuito.
    await expect(
      breaker.execute(
        async () => {
          throw new Error('validacao');
        },
        { tripOn: (e) => !(e instanceof Error && e.message === 'validacao') },
      ),
    ).rejects.toThrow('validacao');
    expect(breaker.snapshot().failures).toBe(0);

    await expect(
      breaker.execute(async () => {
        throw new Error('falha 1');
      }),
    ).rejects.toThrow('falha 1');
    expect(breaker.state).toBe('closed');

    await expect(
      breaker.execute(async () => {
        throw new Error('falha 2');
      }),
    ).rejects.toThrow('falha 2');
    expect(breaker.state).toBe('open');

    // Curto-circuito imediato antes do resetMs.
    let called = 0;
    await expect(
      breaker.execute(async () => {
        called += 1;
        return 'no';
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(0);

    // Após resetMs entra em half-open e bloqueia segunda sonda simultânea.
    now = 6_500;
    expect(breaker.state).toBe('half-open');
    let releaseProbe!: () => void;
    const probePending = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const first = breaker.execute(async () => {
      await probePending;
      return 'ok';
    });
    await expect(breaker.execute(async () => 'stampede')).rejects.toBeInstanceOf(CircuitOpenError);
    releaseProbe();
    await expect(first).resolves.toBe('ok');
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', failures: 0, lastError: null });
  });

  it('ProjectChecks abre após 2 infraError seguidos, ignora falhas normais e reinicia em corrida manual', async () => {
    let now = 10_000;
    const circuits = new CircuitRegistry();
    const spec: CheckSpec = { id: 'unit', label: 'Unit', command: 'run unit', enabled: true };
    let mode: 'infra' | 'fail' | 'pass' = 'fail';
    const runs: number[] = [];
    const run: RunCommand = async () => {
      runs.push(runs.length + 1);
      if (mode === 'fail') return { state: 'failed', tail: 'assertion failed', durationMs: 5 };
      if (mode === 'infra')
        return { state: 'failed', tail: 'spawn ENOENT', durationMs: 0, infraError: true };
      return { state: 'passed', tail: null, durationMs: 3 };
    };

    const checks = new ProjectChecks({
      cwd: tempDir(),
      saved: [spec],
      trusted: true,
      emit: () => undefined,
      run,
      circuits,
      now: () => now,
      breakerResetMs: 60_000,
    });

    // Falhas normais de testes nunca abrem o circuit breaker.
    await checks.run('t1');
    await checks.run('t2');
    await checks.run('t3');
    expect(runs).toHaveLength(3);
    expect(circuits.get('check:unit')?.state).toBe('closed');

    // 2 falhas de infraestrutura abrem o circuito; a 3ª corrida automática falha depressa sem spawn.
    mode = 'infra';
    await checks.run('t4');
    await checks.run('t5');
    expect(circuits.get('check:unit')?.state).toBe('open');
    await checks.run('t6');
    expect(runs).toHaveLength(5);
    expect(checks.state.results[0]).toMatchObject({
      id: 'unit',
      state: 'failed',
    });

    // Corrida manual reinicia o breaker.
    mode = 'pass';
    now += 1_000;
    await checks.run('t7', { manual: true });
    expect(runs).toHaveLength(6);
    expect(checks.state.results[0]).toMatchObject({ id: 'unit', state: 'passed' });
    expect(circuits.get('check:unit')?.state).toBe('closed');
  });

  it('SessionManager e Engine expõem engine.health, moduleToggle e circuit breaker no arranque do adaptador', async () => {
    const project = tempDir();
    let failMode: 'spawn' | 'login' | 'ok' = 'spawn';
    let starts = 0;
    const caps: AgentCapabilities = {
      models: [],
      modes: [],
      effort: false,
      effortOrder: [],
      features: { cost: false, context: false, resume: false, rewind: false },
    };
    const registry = registryOf([
      {
        id: 'flaky',
        label: 'Flaky',
        transport: 'acp',
        defaultMode: null,
        staticModes: [],
        untrustedProjects: 'allowed',
        envPolicy: { base: 'no-secrets', keys: [] },
        detect: async () => ({ status: 'ready' }),
        create: (_opt, sink) => ({
          start: async () => {
            starts += 1;
            if (failMode === 'spawn') throw new Error('spawn ENOENT flaky-bin');
            if (failMode === 'login') throw new Error('precisa de login antes');
            sink.state('idle');
            return { capabilities: caps, settings: { model: null, effort: null, mode: null } };
          },
          send: async (_t, o) => o?.turnId ?? 't1',
          interrupt: async () => undefined,
          close: async () => undefined,
          setMode: async () => undefined,
          setModel: async () => undefined,
          answerPermission: () => false,
          capabilities: () => caps,
          agentSessionId: () => null,
        }),
      },
    ]);

    const engine = new Engine({
      isolated: true,
      checkpoints: false,
      worktrees: false,
      reviewer: false,
      planner: false,
      drafter: false,
      checks: false,
      registry,
    });
    engines.push(engine);
    await engine.ready();

    // Saúde e toggles no Engine real.
    const healthRes = await engine.handle({
      kind: 'request',
      id: 'h1',
      command: 'engine.health',
      payload: {},
    });
    expect(healthRes.ok).toBe(true);
    if (healthRes.ok) {
      const modules = (healthRes.result as { modules: { id: string; state: string }[] }).modules;
      expect(modules).toHaveLength(13);
      expect(modules.every((m) => m.state === 'running')).toBe(true);
    }

    const disableCritical = await engine.handle({
      kind: 'request',
      id: 't1',
      command: 'engine.moduleToggle',
      payload: { id: 'sessions', enabled: false },
    });
    expect(disableCritical.ok).toBe(false);

    const disablePull = await engine.handle({
      kind: 'request',
      id: 't2',
      command: 'engine.moduleToggle',
      payload: { id: 'pull', enabled: false },
    });
    expect(disablePull.ok).toBe(true);
    const blockedCall = await engine.handle({
      kind: 'request',
      id: 't3',
      command: 'issues.list',
      payload: { projectId: 'p1' },
    });
    expect(blockedCall.ok).toBe(false);
    const enablePull = await engine.handle({
      kind: 'request',
      id: 't4',
      command: 'engine.moduleToggle',
      payload: { id: 'pull', enabled: true },
    });
    expect(enablePull.ok).toBe(true);

    // Erro de login nunca conta para abrir o circuit breaker do adaptador.
    failMode = 'login';
    for (let i = 0; i < 3; i += 1) {
      const r = await engine.handle({
        kind: 'request',
        id: `l-${i}`,
        command: 'session.start',
        payload: { projectId: 'p1', cwd: project, trusted: true, agent: 'flaky' },
      });
      expect(r.ok).toBe(false);
    }
    expect(engine.circuits.get('adapter-start:flaky')?.snapshot().failures).toBe(0);

    // 3 falhas reais de spawn abrem adapter-start:flaky; a 4ª chamada não chama adapter.start().
    failMode = 'spawn';
    starts = 0;
    for (let i = 0; i < 3; i += 1) {
      await engine.handle({
        kind: 'request',
        id: `s-${i}`,
        command: 'session.start',
        payload: { projectId: 'p1', cwd: project, trusted: true, agent: 'flaky' },
      });
    }
    expect(starts).toBe(3);
    expect(engine.circuits.get('adapter-start:flaky')?.state).toBe('open');

    const fastFail = await engine.handle({
      kind: 'request',
      id: 's-4',
      command: 'session.start',
      payload: { projectId: 'p1', cwd: project, trusted: true, agent: 'flaky' },
    });
    expect(fastFail.ok).toBe(false);
    expect(starts).toBe(3);

    // Atualizar lista de agentes limpa o circuito do adaptador.
    failMode = 'ok';
    await engine.handle({
      kind: 'request',
      id: 'refresh-1',
      command: 'agents.list',
      payload: { refresh: true },
    });
    expect(engine.circuits.get('adapter-start:flaky')?.state).toBe('closed');
    const started = await engine.handle({
      kind: 'request',
      id: 's-ok',
      command: 'session.start',
      payload: { projectId: 'p1', cwd: project, trusted: true, agent: 'flaky' },
    });
    expect(started.ok).toBe(true);
  }, 15_000);
});
