import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineCommandSchemas, rankFindings, type FileDiff, type Finding } from '@solline/protocol';
import {
  codexAvailability,
  codexReviewer,
  isSensitivePath,
  promptFor,
  reviewWorth,
  routeReviewer,
  type Reviewer,
} from '../src/index.ts';
import { REVIEWED_CODEX_VERSION } from '../src/adapters/codex/executable.ts';
import { OUTPUT, SCHEMA, projectFindings } from '../src/quality/reviewer.ts';
import { fakeCodexServer } from './codex-fakes.ts';
import { waitFor } from './helpers.ts';

function diffOf(file: string, additions: number, deletions = 0): FileDiff {
  return { path: file, status: 'modified', binary: false, additions, deletions, hunks: [] };
}

const FOUND = {
  path: 'src/a.ts',
  line: 3,
  severity: 'bug' as const,
  priority: 0 as const,
  confidence: 0.9,
  title: 'Falta validar',
  detail: 'Valida a entrada.',
};

describe('rankFindings', () => {
  const f = (
    id: string,
    severity: Finding['severity'],
    priority: Finding['priority'],
    confidence: number,
    status: Finding['status'] = 'open',
  ): Finding => ({
    id,
    path: 'a',
    line: 1,
    severity,
    priority,
    confidence,
    status,
    title: id,
    detail: '',
  });

  it('mostra só erros e riscos seguros, por prioridade e depois por confiança', () => {
    const { shown, folded } = rankFindings([
      f('b-p1', 'bug', 1, 0.95),
      f('r-p0-lo', 'risk', 0, 0.75),
      f('r-p0-hi', 'risk', 0, 0.9),
      f('slop', 'slop', 0, 1),
      f('duvida', 'bug', 0, 0.69),
    ]);
    expect(shown.map((x) => x.id)).toEqual(['r-p0-hi', 'r-p0-lo', 'b-p1']);
    expect(folded.map((x) => x.id).sort()).toEqual(['duvida', 'slop']);
  });

  it('o limiar é 0,7 e o máximo à vista é 5; o resto fica dobrado', () => {
    const many = Array.from({ length: 7 }, (_, i) => f(`x${i}`, 'bug', 2, 0.7 + i / 100));
    const { shown, folded } = rankFindings(many);
    expect(shown).toHaveLength(5);
    expect(shown.map((x) => x.id)).toEqual(['x6', 'x5', 'x4', 'x3', 'x2']);
    expect(folded.map((x) => x.id).sort()).toEqual(['x0', 'x1']);
    expect(rankFindings([f('na-conta', 'bug', 0, 0.7)]).shown).toHaveLength(1);
  });

  it('os descartados nunca aparecem, nem dobrados; sem achados é um bom resultado', () => {
    const { shown, folded } = rankFindings([f('d', 'bug', 0, 1, 'dismissed')]);
    expect([shown, folded]).toEqual([[], []]);
    expect(rankFindings([])).toEqual({ shown: [], folded: [] });
  });
});

describe('quando vale a pena rever um turno', () => {
  it('19 linhas não chegam, 20 sim (somando o que entra e o que sai)', () => {
    expect(reviewWorth([diffOf('src/util.ts', 10, 9)])).toMatchObject({ worth: false, lines: 19 });
    expect(reviewWorth([diffOf('src/util.ts', 10, 10)])).toMatchObject({ worth: true, lines: 20 });
    expect(reviewWorth([diffOf('src/a.ts', 5), diffOf('src/b.ts', 5, 10)]).worth).toBe(true);
  });

  it('um caminho sensível chega com uma linha', () => {
    for (const file of [
      'src/auth/login.ts',
      'src/userSession.ts',
      'lib/token-store.js',
      '.env',
      '.env.local',
      'db/migrations/001_init.sql',
      'prisma/schema.prisma',
      'vite.config.ts',
      'package.json',
      '.github/workflows/ci.yml',
      'apps/desktop/src/main/index.ts',
      'apps/desktop/src/preload/index.ts',
      'src/permissions.ts',
      'src\\secrets\\key.ts',
    ]) {
      expect(reviewWorth([diffOf(file, 1)]), file).toMatchObject({
        worth: true,
        sensitive: [file],
      });
    }
  });

  it('um ficheiro banal com uma linha não vale', () => {
    for (const file of [
      'src/button.tsx',
      'README.md',
      'docs/notas.md',
      'src/authors.ts',
      // Num projeto Java ou Kotlin todo o código vive em src/main: não é o processo do Electron.
      'src/main/java/com/acme/Button.java',
      'app/src/main/kotlin/Util.kt',
      'src/main/resources/messages.properties',
    ]) {
      expect(isSensitivePath(file), file).toBe(false);
    }
    expect(reviewWorth([diffOf('src/button.tsx', 1)])).toEqual({
      worth: false,
      lines: 1,
      sensitive: [],
    });
  });
});

describe('os caminhos dos achados', () => {
  const root = path.resolve('projeto');
  const at = (file: string) => ({ ...FOUND, path: file });

  it('ficam relativos ao projeto e com "/", venham absolutos, do Windows ou com o a/ b/ do diff', () => {
    const found = projectFindings(
      [
        at(path.join(root, 'src', 'a.ts')),
        at('src\\b.ts'),
        at('b/src/c.ts'),
        at('./src/d.ts'),
        // Um caminho que existe mesmo com "b/" à frente fica como está.
        at('b/real.ts'),
      ],
      root,
      [{ path: 'src/c.ts' }, { path: 'b/real.ts' }],
    );
    expect(found.map((f) => f.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'b/real.ts',
    ]);
  });

  it('o que cai fora do projeto sai (um diff com instruções não aponta para ~/.ssh)', () => {
    const outside = [
      at('../segredos.txt'),
      at(path.resolve(root, '..', 'outro', 'x.ts')),
      at(path.join(path.parse(root).root, 'etc', 'passwd')),
      at('.'),
    ];
    expect(projectFindings([...outside, at('src/ok.ts')], root).map((f) => f.path)).toEqual([
      'src/ok.ts',
    ]);
    // Um nome que só começa por ".." continua dentro.
    expect(projectFindings([at('..notas.md')], root)).toHaveLength(1);
  });
});

describe('o fabricante oposto', () => {
  const claude: Reviewer = Object.assign(async () => [], { vendor: 'claude', model: 'sonnet' });
  const codex: Reviewer = Object.assign(async () => [], { vendor: 'codex', model: 'gpt-x' });
  const ready = () => Promise.resolve(codex);

  it('o Claude é revisto pelo Codex; o Codex e o ACP pelo Claude', async () => {
    const pick = routeReviewer({ claude, codex: ready });
    expect(await pick('claude', true)).toBe(codex);
    expect(await pick('codex', true)).toBe(claude);
    expect(await pick('gemini', true)).toBe(claude);
  });

  it('sem o Codex pronto cai no Claude (o gestor marca "mesmo fabricante")', async () => {
    expect(
      await routeReviewer({ claude, codex: () => Promise.resolve(null) })('claude', true),
    ).toBe(claude);
    expect(
      await routeReviewer({ claude, codex: () => Promise.reject(new Error('x')) })('claude', true),
    ).toBe(claude);
    expect(await routeReviewer({ claude })('claude', true)).toBe(claude);
  });

  it('num projeto sem confiança o Codex não revê (leria a config do projeto)', async () => {
    expect(await routeReviewer({ claude, codex: ready })('claude', false)).toBe(claude);
  });
});

describe('disponibilidade do Codex', () => {
  const found = { path: 'C:/codex.exe', version: REVIEWED_CODEX_VERSION, source: 'path' as const };
  const login = { account: null, requiresOpenaiAuth: true };

  function setup(options: Parameters<typeof fakeCodexServer>[0] = {}) {
    const probes: ReturnType<typeof fakeCodexServer>[] = [];
    const reviews: ReturnType<typeof fakeCodexServer>[] = [];
    let time = 0;
    const availability = codexAvailability({
      resolve: () => found,
      platform: 'win32',
      probeTransport: () => {
        const server = fakeCodexServer(options);
        probes.push(server);
        return server.transport();
      },
      reviewerTransport: () => {
        const server = fakeCodexServer(options);
        reviews.push(server);
        return server.transport();
      },
      now: () => time,
      ttlMs: 60_000,
    });
    return { availability, probes, reviews, tick: (ms: number) => (time += ms) };
  }

  it('pronto: instalado, com login e sandbox; usa o modelo por omissão e esforço medium', async () => {
    const { availability, probes, reviews } = setup();
    const reviewer = await availability();
    expect(reviewer).not.toBeNull();
    expect([reviewer!.vendor, reviewer!.model]).toEqual(['codex', 'gpt-6-luna']);
    expect(probes[0]!.killed).toBe(true);

    const run = reviewer!({ cwd: 'C:/p', diff: [], request: 'x' });
    const started = await waitForStart(reviews);
    expect(started.params).toMatchObject({ effort: 'medium' });
    complete(reviews[0]!, { findings: [] });
    expect(await run).toEqual([]);
  });

  it('sem login, sem sandbox, não instalado ou versão não revista: não está disponível', async () => {
    expect(await setup({ account: login }).availability()).toBeNull();
    expect(await setup({ sandbox: 'notConfigured' }).availability()).toBeNull();
    expect(
      await codexAvailability({ resolve: () => null, probeTransport: () => fail() })(),
    ).toBeNull();
    expect(
      await codexAvailability({
        resolve: () => ({ ...found, version: '0.0.1' }),
        probeTransport: () => fail(),
      })(),
    ).toBeNull();
  });

  it('a resposta vale um minuto: não se arranca um processo por cada turno', async () => {
    const { availability, probes, tick } = setup();
    await Promise.all([availability(), availability()]);
    await availability();
    expect(probes).toHaveLength(1);
    tick(59_000);
    await availability();
    expect(probes).toHaveLength(1);
    tick(2_000);
    await availability();
    expect(probes).toHaveLength(2);
  });
});

/** Para apanhar o erro de uma promessa que devia falhar. */
function unexpected(): never {
  throw new Error('devia ter falhado');
}

function fail(): never {
  throw new Error('não devia arrancar nada');
}

async function waitForStart(servers: ReturnType<typeof fakeCodexServer>[]) {
  await waitFor(() => servers.length > 0, 5_000);
  return servers[0]!.waitFor((m) => m.method === 'turn/start');
}

/** O Codex acaba o turno: a mensagem final e o turn/completed. */
function complete(
  server: ReturnType<typeof fakeCodexServer>,
  answer: unknown,
  extra: { phase?: string | null } = {},
) {
  server.notify('item/completed', {
    item: {
      type: 'agentMessage',
      id: 'm1',
      text: typeof answer === 'string' ? answer : JSON.stringify(answer),
      phase: extra.phase ?? 'final_answer',
    },
    threadId: server.threadId,
    turnId: server.turnId(),
    completedAtMs: 0,
  });
  server.notify('turn/completed', {
    threadId: server.threadId,
    turn: { id: server.turnId(), items: [], status: 'completed', error: null },
  });
}

describe('revisor Codex', () => {
  const input = {
    cwd: 'C:/p',
    diff: [diffOf('src/a.ts', 3)],
    request: 'valida a entrada',
    rules: 'Commits em pt-PT.',
  };

  it('abre uma thread efémera só de leitura, sem aprovações, com o esquema, e devolve os achados', async () => {
    const server = fakeCodexServer();
    const review = codexReviewer({
      transport: server.transport,
      model: 'gpt-6-luna',
      effort: 'low',
    });
    expect([review.vendor, review.model]).toEqual(['codex', 'gpt-6-luna']);
    const run = review(input);
    const thread = await server.waitFor((m) => m.method === 'thread/start');
    const turn = await server.waitFor((m) => m.method === 'turn/start');
    expect(thread.params).toMatchObject({
      cwd: 'C:/p',
      model: 'gpt-6-luna',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
    });
    expect(
      String((thread.params as { developerInstructions: string }).developerInstructions),
    ).toContain('You are the reviewer');
    const params = turn.params as {
      input: { text: string }[];
      outputSchema: unknown;
      approvalPolicy: string;
      sandboxPolicy: unknown;
      effort: string;
    };
    expect(params.outputSchema).toEqual(SCHEMA);
    expect(params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort: 'low',
    });
    expect(params.input[0]!.text).toBe(promptFor(input));

    complete(server, { findings: [FOUND] });
    expect(await run).toEqual([FOUND]);
    expect(OUTPUT.safeParse({ findings: [FOUND] }).success).toBe(true);
    expect(server.killed).toBe(true);
  });

  it('o prompt leva o pedido, o diff e as regras do projeto, e nada que o agente tenha dito', () => {
    const prompt = promptFor(input);
    expect(prompt).toContain('valida a entrada');
    expect(prompt).toContain('+++ b/src/a.ts');
    expect(prompt).toContain('# Regras do projeto');
    expect(prompt).toContain('Commits em pt-PT.');
    expect(promptFor({ ...input, rules: undefined })).not.toContain('Regras do projeto');
    // Sem resumo do agente: as únicas entradas são o pedido, o diff e as regras.
    expect(Object.keys(input).sort()).toEqual(['cwd', 'diff', 'request', 'rules']);
  });

  it('ignora os comentários a meio e fica com a resposta final, mesmo numa cerca de código', async () => {
    const server = fakeCodexServer();
    const run = codexReviewer({ transport: server.transport })(input);
    await server.waitFor((m) => m.method === 'turn/start');
    server.notify('item/completed', {
      item: { type: 'agentMessage', id: 'c', text: 'a ver os ficheiros…', phase: 'commentary' },
      threadId: server.threadId,
      turnId: server.turnId(),
      completedAtMs: 0,
    });
    complete(server, '```json\n' + JSON.stringify({ findings: [FOUND] }) + '\n```');
    expect(await run).toEqual([FOUND]);
  });

  it('o que o Codex pedir autorização é recusado', async () => {
    const server = fakeCodexServer();
    const run = codexReviewer({ transport: server.transport })(input);
    await server.waitFor((m) => m.method === 'turn/start');
    const answer = await server.request('item/commandExecution/requestApproval', {
      threadId: server.threadId,
      turnId: server.turnId(),
      itemId: 'i',
    });
    expect(answer.result).toEqual({ decision: 'decline' });
    const legacy = await server.request('applyPatchApproval', { callId: 'c' });
    expect(JSON.stringify(legacy.result)).toContain('denied');
    complete(server, { findings: [] });
    expect(await run).toEqual([]);
  });

  it('JSON inválido ou fora do esquema é um erro, nunca "sem achados"', async () => {
    for (const answer of [
      'isto não é JSON',
      { findings: [{ ...FOUND, priority: 9 }] },
      { nada: 1 },
    ]) {
      const server = fakeCodexServer();
      const run = codexReviewer({ transport: server.transport })(input);
      const caught = run.then(unexpected, (e: Error) => e);
      await server.waitFor((m) => m.method === 'turn/start');
      complete(server, answer);
      expect((await caught).message).toContain('formato');
      expect(server.killed).toBe(true);
    }
  });

  it('sem resposta final é um erro', async () => {
    const server = fakeCodexServer();
    const caught = codexReviewer({ transport: server.transport })(input).then(
      unexpected,
      (e: Error) => e,
    );
    await server.waitFor((m) => m.method === 'turn/start');
    server.notify('turn/completed', {
      threadId: server.threadId,
      turn: { id: server.turnId(), items: [], status: 'completed', error: null },
    });
    expect((await caught).message).toContain('sem resposta');
  });

  it('quota e login chegam como erro legível em pt-PT', async () => {
    const quota = fakeCodexServer();
    const caughtQuota = codexReviewer({ transport: quota.transport })(input).then(
      unexpected,
      (e: Error) => e,
    );
    await quota.waitFor((m) => m.method === 'turn/start');
    quota.notify('turn/completed', {
      threadId: quota.threadId,
      turn: {
        id: quota.turnId(),
        items: [],
        status: 'failed',
        error: { message: 'You hit your usage limit', codexErrorInfo: 'usageLimitExceeded' },
      },
    });
    expect((await caughtQuota).message).toMatch(/limite da subscrição/);
    expect(quota.killed).toBe(true);

    const out = fakeCodexServer({ account: { account: null, requiresOpenaiAuth: true } });
    const caughtLogin = await codexReviewer({ transport: out.transport })(input).then(
      unexpected,
      (e: Error) => e,
    );
    expect(caughtLogin.message).toMatch(/sessão iniciada/);
    expect(out.killed).toBe(true);
    expect(out.received.some((m) => m.method === 'thread/start')).toBe(false);
  });

  it('um erro que não é de quota nem de login traz a mensagem do Codex', async () => {
    const server = fakeCodexServer();
    const caught = codexReviewer({ transport: server.transport })(input).then(
      unexpected,
      (e: Error) => e,
    );
    await server.waitFor((m) => m.method === 'turn/start');
    server.notify('turn/completed', {
      threadId: server.threadId,
      turn: {
        id: server.turnId(),
        items: [],
        status: 'failed',
        error: { message: 'modelo indisponível', codexErrorInfo: null },
      },
    });
    expect((await caught).message).toContain('modelo indisponível');
  });

  it('cancelar interrompe o turno e mata o processo', async () => {
    const server = fakeCodexServer();
    const abort = new AbortController();
    const caught = codexReviewer({ transport: server.transport })({
      ...input,
      signal: abort.signal,
    }).then(unexpected, (e: Error) => e);
    await server.waitFor((m) => m.method === 'turn/start');
    // Deixa o revisor receber o id do turno (para o poder interromper).
    await new Promise((r) => setTimeout(r, 50));
    abort.abort();
    expect((await caught).message).toContain('cancelada');
    expect(server.received.some((m) => m.method === 'turn/interrupt')).toBe(true);
    expect(server.killed).toBe(true);
  });

  it('já cancelado nem arranca; e o tempo esgotado também mata o processo', async () => {
    const abort = new AbortController();
    abort.abort();
    const never = fakeCodexServer();
    await expect(
      codexReviewer({ transport: never.transport })({ ...input, signal: abort.signal }),
    ).rejects.toThrow('cancelada');
    expect(never.received).toHaveLength(0);

    const slow = fakeCodexServer();
    const caught = await codexReviewer({ transport: slow.transport, timeoutMs: 80 })(input).then(
      unexpected,
      (e: Error) => e,
    );
    expect(caught.message).toContain('demorou');
    expect(slow.killed).toBe(true);
  });

  it('o Codex a cair a meio é um erro, não um resultado limpo', async () => {
    const server = fakeCodexServer();
    const caught = codexReviewer({ transport: server.transport })(input).then(
      unexpected,
      (e: Error) => e,
    );
    await server.waitFor((m) => m.method === 'turn/start');
    server.crash();
    expect((await caught).message).toContain('fechou antes');
    expect(server.killed).toBe(true);
  });

  describe('sem os servidores MCP do utilizador', () => {
    it('lê a config da pasta e desliga cada servidor (e plugins e apps) no thread/start', async () => {
      const server = fakeCodexServer({ mcpServers: ['node_repl', 'a.b'] });
      const run = codexReviewer({ transport: server.transport })(input);
      const read = await server.waitFor((m) => m.method === 'config/read');
      expect(read.params).toMatchObject({ cwd: 'C:/p' });
      const thread = await server.waitFor((m) => m.method === 'thread/start');
      expect((thread.params as { config: unknown }).config).toEqual({
        'features.plugins': false,
        'features.apps': false,
        project_doc_max_bytes: 0,
        project_doc_fallback_filenames: [],
        mcp_servers: { node_repl: { enabled: false }, 'a.b': { enabled: false } },
      });
      await server.waitFor((m) => m.method === 'turn/start');
      const status = server.received.find((m) => m.method === 'mcpServerStatus/list');
      expect(status?.params).toMatchObject({ threadId: server.threadId });
      complete(server, { findings: [] });
      expect(await run).toEqual([]);
    });

    it('sem servidores configurados desliga na mesma plugins e apps', async () => {
      const server = fakeCodexServer();
      const run = codexReviewer({ transport: server.transport })(input);
      const thread = await server.waitFor((m) => m.method === 'thread/start');
      expect((thread.params as { config: unknown }).config).toEqual({
        'features.plugins': false,
        'features.apps': false,
        project_doc_max_bytes: 0,
        project_doc_fallback_filenames: [],
      });
      await server.waitFor((m) => m.method === 'turn/start');
      complete(server, { findings: [] });
      await run;
    });

    it('um servidor que continua ligado cancela a revisão: nunca há turno nem prompt', async () => {
      const server = fakeCodexServer({
        mcpServers: ['node_repl'],
        mcpStatus: [
          { name: 'node_repl', runtimeStatus: 'disabled' },
          { name: 'firebase', runtimeStatus: 'connected' },
        ],
      });
      const caught = await codexReviewer({ transport: server.transport })(input).then(
        unexpected,
        (e: Error) => e,
      );
      expect(caught.message).toContain('MCP');
      expect(caught.message).toContain('firebase');
      expect(server.received.some((m) => m.method === 'turn/start')).toBe(false);
      expect(server.killed).toBe(true);
    });

    it('o estado desconhecido conta como ligado', async () => {
      const server = fakeCodexServer({ mcpStatus: [{ name: 'x', runtimeStatus: null }] });
      const caught = await codexReviewer({ transport: server.transport })(input).then(
        unexpected,
        (e: Error) => e,
      );
      expect(caught.message).toContain('x');
      expect(server.received.some((m) => m.method === 'turn/start')).toBe(false);
    });

    it('sem conseguir ler a config não há thread nem revisão', async () => {
      const server = fakeCodexServer({ failConfigRead: true });
      const caught = await codexReviewer({ transport: server.transport })(input).then(
        unexpected,
        (e: Error) => e,
      );
      expect(caught.message).toContain('config');
      expect(server.received.some((m) => m.method === 'thread/start')).toBe(false);
      expect(server.killed).toBe(true);
    });

    it('o teste de disponibilidade não abre thread nem toca na config (o app-server não lança MCP no arranque)', async () => {
      const probe = fakeCodexServer({ mcpServers: ['node_repl'] });
      const availability = codexAvailability({
        resolve: () => ({
          path: 'C:/codex.exe',
          version: REVIEWED_CODEX_VERSION,
          source: 'path' as const,
        }),
        platform: 'win32',
        probeTransport: probe.transport,
      });
      expect(await availability()).not.toBeNull();
      const methods = probe.received.map((m) => m.method);
      expect(methods).not.toContain('thread/start');
      expect(methods).not.toContain('config/read');
    });
  });
});

describe('quality.review no protocolo', () => {
  const schema = engineCommandSchemas['quality.review'].payload;

  it('trigger e scope são opcionais e só aceitam os valores conhecidos', () => {
    expect(schema.parse({ sessionId: 's' })).toEqual({ sessionId: 's' });
    expect(schema.parse({ sessionId: 's', trigger: 'bring', scope: 'session' })).toEqual({
      sessionId: 's',
      trigger: 'bring',
      scope: 'session',
    });
    expect(() => schema.parse({ sessionId: 's', scope: 'tudo' })).toThrow();
    expect(() => schema.parse({ sessionId: 's', trigger: 'cron' })).toThrow();
  });
});
