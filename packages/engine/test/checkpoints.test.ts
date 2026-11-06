import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShadowGit, gitVersion, resolveGit } from '../src/checkpoints/git.ts';
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

// Cada chamada ao git é um processo novo; com o antivírus a pesar, chega a 1 s cada.
describe('materializar um checkpoint noutra pasta', { timeout: 30_000 }, () => {
  let target: string;

  beforeEach(async () => {
    target = path.join(root, 'target');
    await mkdir(target);
  });

  const put = (rel: string, text: string) =>
    mkdir(path.dirname(path.join(target, rel)), { recursive: true }).then(() =>
      writeFile(path.join(target, rel), text),
    );
  const got = (rel: string) => readFile(path.join(target, rel), 'utf8');

  it('põe a pasta como no fim do turno e deixa em paz o .git, os ignorados e o node_modules', async () => {
    // A origem e a pasta de destino partem do mesmo ponto.
    for (const dir of [project, target]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, '.gitignore'), 'ignored.log\n');
      await writeFile(path.join(dir, 'a.txt'), 'um\n');
      await writeFile(path.join(dir, 'gone.txt'), 'g\n');
    }
    // O destino tem o que um repositório e uma instalação lá deixam.
    await put('.git/marker', 'não mexer');
    await put('ignored.log', 'meu log');
    await put('node_modules/pkg/index.js', 'dep');
    await put('so-no-destino.txt', 'não estava na origem');

    const cp = await open();
    await begin(cp, 't1', 'Muda e apaga');
    await write('a.txt', 'dois\n');
    await write('gone.txt', 'ainda\n');
    await rm(path.join(project, 'gone.txt'));
    await write('novo/c.txt', 'c\n');
    await write('ignored.log', 'log da origem');
    await cp.endTurn(last);
    await begin(cp, 't2', 'Depois');
    await write('a.txt', 'tres\n');
    await write('outro.txt', 'o\n');
    await cp.endTurn(last);
    const sourceAfter = await read('a.txt');

    const result = await cp.materialize('t1', target);
    expect(result).toEqual({ written: 2, removed: 2 });
    // O que o checkpoint tinha...
    expect(await got('a.txt')).toBe('dois\n');
    expect(await got('novo/c.txt')).toBe('c\n');
    expect(existsSync(path.join(target, 'gone.txt'))).toBe(false);
    expect(existsSync(path.join(target, 'so-no-destino.txt'))).toBe(false);
    expect(existsSync(path.join(target, 'outro.txt'))).toBe(false);
    // ...e o que não é do checkpoint não se toca.
    expect(await got('.git/marker')).toBe('não mexer');
    expect(await got('ignored.log')).toBe('meu log');
    expect(await got('node_modules/pkg/index.js')).toBe('dep');
    expect(await got('.gitignore')).toBe('ignored.log\n');
    // A origem e a linha do tempo dela ficam como estavam.
    expect(await read('a.txt')).toBe(sourceAfter);
    expect(cp.timeline().checkpoints.map((c) => c.turnId)).toEqual(['t1', 't2']);
    expect(cp.timeline().rewoundTo).toBeNull();
    expect(cp.timeline().undo).toBeNull();
    // Repetir não muda nada.
    expect(await cp.materialize('t1', target)).toEqual({ written: 0, removed: 0 });
  });

  it('recusa um turno sem checkpoint ou ainda a correr, sem escrever', async () => {
    await write('a.txt', 'um\n');
    const cp = await open();
    await expect(cp.materialize('nada', target)).rejects.toThrow('Este turno não tem checkpoint');
    await begin(cp, 't1', 'A meio');
    await expect(cp.materialize('t1', target)).rejects.toThrow('ainda não acabou');
    expect(await readdir(target)).toEqual([]);
  });
});

describe('custo de cada ação em chamadas ao git', { timeout: 30_000 }, () => {
  it('rejeitar um ficheiro inteiro não repete fotografias ao disco', async () => {
    await write('notes.txt', 'The quick alpha fox.\n');
    const cp = await open();
    await begin(cp, 't1', 'muda');
    await write('notes.txt', 'The quick beta fox.\n');
    await cp.endTurn(last);
    const calls: string[] = [];
    const original = ShadowGit.prototype.run;
    ShadowGit.prototype.run = function (this: ShadowGit, args, options) {
      calls.push(args.find((a) => !a.startsWith('-') && !a.startsWith('core.')) ?? '');
      return original.call(this, args, options);
    };
    try {
      await cp.apply('reject', 'notes.txt');
    } finally {
      ShadowGit.prototype.run = original;
    }
    expect(await read('notes.txt')).toContain('alpha');
    // Antes eram 11: duas fotografias seguidas no fim e o diff depois das contas.
    expect(calls.filter((c) => c === 'add')).toHaveLength(2);
    expect(calls.length).toBeLessThanOrEqual(9);
  });
});

describe('qual git corre', () => {
  const win = process.platform === 'win32';
  it.runIf(win)('salta o lançador de cmd e nunca procura numa pasta relativa', () => {
    const git = path.win32.join('C:', 'Program Files', 'Git');
    const real = path.win32.join(git, 'ucrt64', 'bin', 'git.exe');
    const files = new Set([
      path.win32.join('relativa', 'git.exe'),
      path.win32.join(git, 'cmd', 'git.exe'),
      real,
    ]);
    const PATH = ['.', 'relativa', path.win32.join(git, 'cmd')].join(';');
    expect(resolveGit({ PATH }, (f) => files.has(f))).toBe(real);
  });

  it('sem git no PATH não inventa um', () => {
    expect(resolveGit({ PATH: '' }, () => false)).toBeNull();
  });

  it('gitVersion não corre um git pelo nome', async () => {
    await expect(gitVersion('git')).resolves.toBeNull();
  });
});
