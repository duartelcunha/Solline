import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoints/store.ts';
import type { SessionCheckpoints } from '../src/checkpoints/session-checkpoints.ts';
import { headerPath } from '../src/checkpoints/unified-diff.ts';

let root: string;
let project: string;
let store: CheckpointStore;
let opened: SessionCheckpoints[] = [];

async function open(id: string = crypto.randomUUID()): Promise<SessionCheckpoints> {
  const cp = store.open(id, project, () => 'agent');
  opened.push(cp);
  await cp.ready;
  return cp;
}

const write = (rel: string, text: string) =>
  mkdir(path.dirname(path.join(project, rel)), { recursive: true }).then(() =>
    writeFile(path.join(project, rel), text),
  );
const read = (rel: string) => readFile(path.join(project, rel), 'utf8');

/** O último turno aberto (endTurn fecha-o pelo id). */
let last = '';
async function begin(cp: SessionCheckpoints, turnId: string, text: string): Promise<void> {
  last = turnId;
  await cp.beginTurn(turnId, text).done;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solline-cp-'));
  project = path.join(root, 'project');
  await mkdir(project);
  store = new CheckpointStore({ root: path.join(root, 'data') });
  opened = [];
});

afterEach(async () => {
  await Promise.all(opened.map((cp) => cp.dispose()));
  await rm(root, { recursive: true, force: true });
});

// Cada chamada ao git custa ~100 ms no Windows.
describe('checkpoints por turno', { timeout: 30_000 }, () => {
  it('guarda o antes e o depois de cada turno sem tocar no git do projeto', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: project });
    await write('a.txt', 'um\ndois\ntrês\n');
    const cp = await open();
    await begin(cp, 't1', 'Muda o a.txt\nmais texto');
    await write('a.txt', 'um\nDOIS\ntrês\n');
    await write('novo/b.txt', 'b\n');
    await cp.endTurn(last);

    const timeline = cp.timeline();
    expect(timeline.available).toBe(true);
    expect(timeline.checkpoints).toEqual([
      expect.objectContaining({
        turnId: 't1',
        index: 1,
        title: 'Muda o a.txt',
        state: 'done',
        stats: { files: 2, additions: 2, deletions: 1 },
      }),
    ]);
    expect(timeline.pending).toEqual({ files: 2, additions: 2, deletions: 1 });

    const files = await cp.diff({ kind: 'turn', turnId: 't1' });
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'modified'],
      ['novo/b.txt', 'added'],
    ]);
    const hunk = files[0]!.hunks[0]!;
    expect(hunk.lines).toEqual([
      { kind: 'context', text: 'um', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'dois', oldNo: 2, newNo: null },
      { kind: 'add', text: 'DOIS', oldNo: null, newNo: 2 },
      { kind: 'context', text: 'três', oldNo: 3, newNo: 3 },
    ]);

    // O índice e o histórico do utilizador ficam intactos.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: project,
      encoding: 'utf8',
    });
    expect(status).toContain('?? a.txt');
    expect(execFileSync('git', ['ls-files'], { cwd: project, encoding: 'utf8' })).toBe('');
  });

  it('rejeitar um hunk volta o disco atrás só nesse hunk; desfazer repõe', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`);
    await write('f.txt', `${lines.join('\n')}\n`);
    const cp = await open();
    await begin(cp, 't1', 'duas mudanças');
    const changed = [...lines];
    changed[1] = 'linha 2 mudada';
    changed[27] = 'linha 28 mudada';
    await write('f.txt', `${changed.join('\n')}\n`);
    await cp.endTurn(last);

    const [file] = await cp.diff({ kind: 'review' });
    expect(file!.hunks).toHaveLength(2);
    const timeline = await cp.apply('reject', 'f.txt', file!.hunks[1]!.id);
    expect(timeline.undo).toBe('Rejeitar o hunk');
    const after = await read('f.txt');
    expect(after).toContain('linha 2 mudada');
    expect(after).not.toContain('linha 28 mudada');
    expect(timeline.pending).toEqual({ files: 1, additions: 1, deletions: 1 });

    await cp.undo();
    expect(await read('f.txt')).toContain('linha 28 mudada');
  });

  it('aceitar tira da revisão sem mexer no disco', async () => {
    await write('a.txt', 'a\n');
    const cp = await open();
    await begin(cp, 't1', 'x');
    await write('a.txt', 'A\n');
    await write('b.txt', 'b\n');
    await cp.endTurn(last);

    const [a] = await cp.diff({ kind: 'review' });
    let timeline = await cp.apply('accept', 'a.txt', a!.hunks[0]!.id);
    expect(timeline.pending.files).toBe(1);
    expect((await cp.diff({ kind: 'review' })).map((f) => f.path)).toEqual(['b.txt']);
    timeline = await cp.apply('accept', 'b.txt');
    expect(timeline.pending.files).toBe(0);
    expect(await read('a.txt')).toBe('A\n');
    // O acumulado da sessão continua a mostrar tudo.
    expect((await cp.diff({ kind: 'session' })).map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('rejeitar um ficheiro novo apaga-o, e a pasta vazia também', async () => {
    const cp = await open();
    await begin(cp, 't1', 'x');
    await write('src/novo/x.ts', 'export {};\n');
    await cp.endTurn(last);
    await cp.apply('reject', 'src/novo/x.ts');
    expect(existsSync(path.join(project, 'src/novo/x.ts'))).toBe(false);
    expect(existsSync(path.join(project, 'src'))).toBe(false);
    await cp.undo();
    expect(await read('src/novo/x.ts')).toBe('export {};\n');
  });

  it('rejeitar tudo e aceitar tudo', async () => {
    await write('a.txt', 'a\n');
    const cp = await open();
    await begin(cp, 't1', 'x');
    await write('a.txt', 'A\n');
    await rm(path.join(project, 'a.txt'));
    await write('b.txt', 'b\n');
    await cp.endTurn(last);
    await cp.apply('reject');
    expect(await read('a.txt')).toBe('a\n');
    expect(existsSync(path.join(project, 'b.txt'))).toBe(false);
    expect(cp.timeline().pending.files).toBe(0);
  });

  it('rebobina os ficheiros para antes de um turno e volta ao presente com desfazer', async () => {
    await write('a.txt', 'v0\n');
    const cp = await open();
    await begin(cp, 't1', 'um');
    await write('a.txt', 'v1\n');
    await cp.endTurn(last);
    await begin(cp, 't2', 'dois');
    await write('a.txt', 'v2\n');
    await write('c.txt', 'c\n');
    await cp.endTurn(last);

    await cp.rewindFiles('t2');
    expect(await read('a.txt')).toBe('v1\n');
    expect(existsSync(path.join(project, 'c.txt'))).toBe(false);
    expect(cp.timeline().rewoundTo).toBe('t2');
    expect(cp.timeline().undo).toBe('Rebobinar ficheiros para antes do turno 2');

    await cp.undo();
    expect(await read('a.txt')).toBe('v2\n');
    expect(await read('c.txt')).toBe('c\n');
    expect(cp.timeline().rewoundTo).toBeNull();
  });

  it('o que aceitaste depois do turno sai da revisão quando rebobinas', async () => {
    await write('a.txt', 'v0\n');
    const cp = await open();
    await begin(cp, 't1', 'um');
    await write('a.txt', 'v1\n');
    await cp.endTurn(last);
    await cp.apply('accept');
    await cp.rewindFiles('t1');
    expect(await read('a.txt')).toBe('v0\n');
    expect(cp.timeline().pending.files).toBe(0);
  });

  it('respeita o .gitignore do projeto e guarda os bytes exatos (CRLF)', async () => {
    await write('.gitignore', 'ignorado/\n');
    await write('ignorado/x.txt', 'x\n');
    await write('crlf.txt', 'a\r\nb\r\n');
    const cp = await open();
    await begin(cp, 't1', 'x');
    await write('ignorado/x.txt', 'mudou\n');
    await write('crlf.txt', 'a\r\nB\r\n');
    await cp.endTurn(last);
    expect((await cp.diff({ kind: 'turn', turnId: 't1' })).map((f) => f.path)).toEqual([
      'crlf.txt',
    ]);
    await cp.rewindFiles('t1');
    expect(await read('crlf.txt')).toBe('a\r\nb\r\n');
    expect(await read('ignorado/x.txt')).toBe('mudou\n');
  });

  it('truncate tira o turno e os seguintes da linha do tempo', async () => {
    const cp = await open();
    await begin(cp, 't1', 'um');
    await cp.endTurn(last);
    await begin(cp, 't2', 'dois');
    await cp.endTurn(last);
    await cp.truncate('t2');
    expect(cp.timeline().checkpoints.map((c) => c.turnId)).toEqual(['t1']);
    await begin(cp, 't3', 'três');
    expect(cp.timeline().checkpoints.map((c) => c.index)).toEqual([1, 2]);
  });

  it('um hunk velho é recusado', async () => {
    await write('a.txt', 'a\n');
    const cp = await open();
    await begin(cp, 't1', 'x');
    await write('a.txt', 'b\n');
    await cp.endTurn(last);
    const [file] = await cp.diff({ kind: 'review' });
    await write('a.txt', 'c\n');
    await expect(cp.apply('reject', 'a.txt', file!.hunks[0]!.id)).rejects.toThrow(/mudou/);
    expect(cp.timeline().undo).toBeNull();
  });

  it('uma mudança de tipo (ficheiro para repositório) não baralha os hunks dos outros', async () => {
    await write('a.txt', 'a\n');
    await write('m', 'm\n');
    await write('z.txt', 'z\n');
    const cp = await open();
    await begin(cp, 't1', 'x');
    await write('a.txt', 'A\n');
    await rm(path.join(project, 'm'));
    await write('m/inner.txt', 'i\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path.join(project, 'm') });
    git('init', '--quiet');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'x');
    await write('z.txt', 'Z\n');
    await cp.endTurn(last);
    const files = await cp.diff({ kind: 'review' });
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'z.txt']);
    expect(files[1]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['z', 'Z']);
    await cp.apply('reject', 'z.txt', files[1]!.hunks[0]!.id);
    expect(await read('z.txt')).toBe('z\n');
    expect(await read('a.txt')).toBe('A\n');
    // Rebobinar não tropeça no repositório aninhado.
    await cp.rewindFiles('t1');
    expect(await read('a.txt')).toBe('a\n');
  });

  it('desfazer não apaga o que mudou depois', async () => {
    await write('a.txt', 'a\n');
    const cp = await open();
    await begin(cp, 't1', 'x');
    await write('a.txt', 'b\n');
    await cp.endTurn(last);
    await cp.apply('reject', 'a.txt');
    await write('a.txt', 'editado à mão\n');
    await expect(cp.undo()).rejects.toThrow(/Já não dá para desfazer/);
    expect(await read('a.txt')).toBe('editado à mão\n');
    expect(cp.timeline().undo).toBeNull();
  });

  it('desfazer um aceitar só mexe na revisão, nunca no disco', async () => {
    await write('a.txt', 'a\n');
    const cp = await open();
    await begin(cp, 't1', 'x');
    await write('a.txt', 'b\n');
    await cp.endTurn(last);
    await cp.apply('accept', 'a.txt');
    await write('a.txt', 'c\n');
    const timeline = await cp.undo();
    expect(await read('a.txt')).toBe('c\n');
    expect(timeline.pending.files).toBe(1);
  });

  it('rebobinar não aceita hunks que ficaram por rever', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`);
    await write(
      'p.txt',
      `${lines.join('\n')}
`,
    );
    const cp = await open();
    await begin(cp, 't1', 'um');
    const one = [...lines];
    one[1] = 'H1';
    one[27] = 'H2';
    await write(
      'p.txt',
      `${one.join('\n')}
`,
    );
    await cp.endTurn(last);
    const [file] = await cp.diff({ kind: 'review' });
    await cp.apply('accept', 'p.txt', file!.hunks[0]!.id);
    await begin(cp, 't2', 'dois');
    await write(
      'p.txt',
      `${one.join('\n')}
mais
`,
    );
    await cp.endTurn(last);
    await cp.rewindFiles('t2');
    const [pending] = await cp.diff({ kind: 'review' });
    expect(pending!.hunks.flatMap((h) => h.lines.map((l) => l.text))).toContain('H2');
    expect(pending!.hunks.flatMap((h) => h.lines.map((l) => l.text))).not.toContain('H1');
  });

  it('ficheiros enormes ficam fora dos checkpoints', async () => {
    const cp = await open();
    await begin(cp, 't1', 'x');
    await writeFile(path.join(project, 'grande.bin'), Buffer.alloc(21 * 1024 * 1024));
    await write('pequeno.txt', 'p\n');
    await cp.endTurn(last);
    expect((await cp.diff({ kind: 'turn', turnId: 't1' })).map((f) => f.path)).toEqual([
      'pequeno.txt',
    ]);
  });

  it('o cabeçalho do patch dá o caminho, também entre aspas', () => {
    expect(headerPath('diff --git a/src/a b.ts b/src/a b.ts')).toBe('src/a b.ts');
    expect(headerPath('diff --git "a/tab\\there" "b/tab\\there"')).toBe('tab\there');
    // Bytes UTF-8 em octal, como o git escreve com core.quotePath.
    expect(headerPath('diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"')).toBe('é.txt');
  });

  it('sem git, fica indisponível e a conversa segue', async () => {
    const broken = new CheckpointStore({ root: path.join(root, 'd2'), git: 'git-que-nao-existe' });
    const cp = broken.open('s', project, () => 'summary');
    await cp.ready;
    await begin(cp, 't1', 'x');
    await cp.endTurn(last);
    expect(cp.timeline()).toMatchObject({
      available: false,
      reason: 'o git não está instalado nesta máquina',
      checkpoints: [],
    });
    await expect(cp.diff({ kind: 'review' })).rejects.toThrow(/não estão disponíveis/);
  });

  it('duas sessões na mesma pasta partilham o repositório sem se pisarem', async () => {
    await write('a.txt', 'a\n');
    const one = await open('s1');
    await write('a.txt', 'b\n');
    const two = await open('s2');
    expect((await one.diff({ kind: 'review' })).map((f) => f.path)).toEqual(['a.txt']);
    expect(await two.diff({ kind: 'review' })).toEqual([]);
  });
});
