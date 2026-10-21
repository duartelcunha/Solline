import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PortAllocator, portIsFree } from '../src/workspace/ports.ts';
import { copyEnvFiles, detectSetup } from '../src/workspace/setup.ts';
import { SessionTurns } from '../src/session-turns.ts';

const dirs: string[] = [];
async function dir(files: Record<string, string> = {}): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'solline-ws-'));
  dirs.push(d);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(d, name), content);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('portas por sessão', () => {
  it('blocos de 10 sem colisão; libertar devolve o bloco', async () => {
    const ports = new PortAllocator({ isFree: async () => true });
    const a = await ports.reserve('a');
    const b = await ports.reserve('b');
    expect(b - a).toBe(10);
    expect(await ports.reserve('a')).toBe(a);
    ports.release('a');
    expect(await ports.reserve('c')).toBe(a);
    expect(PortAllocator.env(a)).toEqual({ SOLLINE_PORT: String(a), SOLLINE_PORT_COUNT: '10' });
  });

  it('salta um bloco com uma porta ocupada', async () => {
    const busy = new Set([41_003]);
    const ports = new PortAllocator({ isFree: async (p) => !busy.has(p) });
    expect(await ports.reserve('a')).toBe(41_010);
  });

  it('uma porta em uso não está livre', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    expect(await portIsFree(port)).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('preparar a worktree', () => {
  it('a sugestão vem do conductor.json, senão do lock', async () => {
    expect(
      await detectSetup(
        await dir({ 'conductor.json': JSON.stringify({ scripts: { setup: 'make deps' } }) }),
      ),
    ).toEqual({
      command: 'make deps',
      copyEnv: true,
    });
    expect((await detectSetup(await dir({ 'pnpm-lock.yaml': '' }))).command).toBe('pnpm install');
    expect((await detectSetup(await dir({ 'package.json': '{}' }))).command).toBe('npm install');
    expect((await detectSetup(await dir())).command).toBe('');
  });

  it('copia os .env não versionados e nunca pisa os que já lá estão', async () => {
    const from = await dir({
      '.env': 'A=1',
      '.env.local': 'B=2',
      '.env.example': 'X=',
      outro: 'n',
    });
    const to = await dir({ '.env.local': 'JA=LA' });
    const copied = await copyEnvFiles(from, to, new Set(['.env.example']));
    expect(copied).toEqual(['.env']);
    expect(await readFile(path.join(to, '.env'), 'utf8')).toBe('A=1');
    expect(await readFile(path.join(to, '.env.local'), 'utf8')).toBe('JA=LA');
  });

  it('tirar da fila diz se tirou', async () => {
    const turns = new SessionTurns({
      start: async () => 'turn',
      running: () => true,
      emit: () => undefined,
    });
    const { turnId } = await turns.submit('um');
    expect(turns.unqueue(turnId)).toBe(true);
    expect(turns.unqueue(turnId)).toBe(false);
  });

  it('enquanto prepara, o que escreves espera; ao acabar, segue', async () => {
    let running = false;
    const started: string[] = [];
    const turns = new SessionTurns({
      start: async (t) => (started.push(t), (running = true), 'turn'),
      running: () => running,
      emit: () => undefined,
    });
    turns.hold();
    expect(await turns.submit('olá')).toMatchObject({ how: 'queued' });
    expect(started).toEqual([]);
    turns.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['olá']);
  });
});
