import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiRecoveryStore } from './ui-recovery.ts';
import { WindowActionSchema } from './window-schemas.ts';

const faults = vi.hoisted(() => ({
  beforeSync: undefined as ((path: string, mode: string) => Promise<void>) | undefined,
  failTruncate: false,
  failRenameAt: 0,
  renames: 0,
  opens: 0,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      faults.opens += 1;
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              await faults.beforeSync?.(String(args[0]), String(args[1]));
              await target.sync();
            };
          if (key === 'truncate')
            return async (size: number) => {
              if (faults.failTruncate) throw new Error('injected truncate failure');
              await target.truncate(size);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as FileHandle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      faults.renames += 1;
      if (faults.renames === faults.failRenameAt)
        throw new Error('injected compaction rename failure');
      return actual.rename(...args);
    },
  };
});

// Transparent fixture codec exercises UTF-8 offsets. Production uses OS encryption;
// no credentials or user content are present in these temporary files.
const codec = { encode: (text: string) => text, decode: (text: string) => text };
let dir: string;
const update = (text: string) => ({ sessionId: 'fixture-session', text, pendingSend: null });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
beforeEach(async () => {
  faults.beforeSync = undefined;
  faults.failTruncate = false;
  faults.failRenameAt = 0;
  faults.renames = 0;
  faults.opens = 0;
  dir = await mkdtemp(join(tmpdir(), 'solline-ui-recovery-test-'));
});
afterEach(async () => {
  faults.beforeSync = undefined;
  faults.failTruncate = false;
  faults.failRenameAt = 0;
  const target = resolve(dir);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('solline-ui-recovery-test-'))
    throw new Error('Unsafe fixture path');
  await rm(target, { recursive: true, force: true });
});

describe('UiRecoveryStore durable acknowledgement and recovery', () => {
  it('preserves review comments, scratch note and the active editor across restart', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    const comment = {
      path: 'src/example.ts',
      line: 3,
      side: 'new' as const,
      text: 'comentário guardado',
    };
    const review = {
      scope: { kind: 'review' as const },
      comments: [comment],
      note: 'nota ainda por enviar',
      editing: { ...comment, line: 5, text: 'a escrever' },
    };
    await store.save({ ...update('rascunho'), pendingSend: 'envio sem confirmação', review });
    const restored = await new UiRecoveryStore(dir, codec).load();
    expect(restored.drafts['fixture-session']).toEqual({
      text: 'rascunho',
      pendingSend: 'envio sem confirmação',
      review,
    });
  });

  it('does not acknowledge a write before fsync resolves', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    const entered = deferred(),
      synced = deferred();
    faults.beforeSync = async (path, mode) => {
      if (path.endsWith('drafts.journal') && mode === 'a') {
        entered.release();
        await synced.promise;
      }
    };
    let acknowledged = false;
    const saving = store.save(update('durable fixture')).then((value) => {
      acknowledged = true;
      return value;
    });
    try {
      await entered.promise;
      expect((await readFile(join(dir, 'drafts.journal'))).length).toBeGreaterThan(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acknowledged).toBe(false);
    } finally {
      synced.release();
    }
    expect(await saving).toBe(1);
    expect((await new UiRecoveryStore(dir, codec).load()).drafts['fixture-session']?.text).toBe(
      'durable fixture',
    );
  });

  it('repairs a complete final record missing its newline before the next append', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    await store.save(update('primeiro — 🧪'));
    const journal = join(dir, 'drafts.journal');
    const bytes = await readFile(journal);
    await writeFile(journal, bytes.subarray(0, -1));
    const restored = new UiRecoveryStore(dir, codec);
    expect((await restored.load()).revision).toBe(1);
    await restored.save(update('segundo'));
    expect((await new UiRecoveryStore(dir, codec).load()).drafts['fixture-session']?.text).toBe(
      'segundo',
    );
  });

  it('quarantines exact truncated UTF-8 bytes and retains the acknowledged prefix', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    await store.save(update('ação 🧪 já confirmada'));
    const journal = join(dir, 'drafts.journal');
    const prefix = await readFile(journal);
    const partial = Buffer.from('{"payload":"ação 🧪');
    const tail = partial.subarray(0, partial.length - 2);
    await appendFile(journal, tail);
    const restored = new UiRecoveryStore(dir, codec);
    expect((await restored.load()).drafts['fixture-session']?.text).toBe('ação 🧪 já confirmada');
    expect(await readFile(journal)).toEqual(prefix);
    const quarantine = (await readdir(dir)).find((name) => name.endsWith('.quarantine'));
    expect(quarantine).toBeDefined();
    expect(await readFile(join(dir, quarantine ?? 'missing'))).toEqual(tail);
    await restored.save(update('continua'));
    expect((await new UiRecoveryStore(dir, codec).load()).revision).toBe(2);
  });

  it('rolls failed fsync back durably and permits a successful retry', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    await store.save(update('confirmed'));
    const journal = join(dir, 'drafts.journal');
    const prefix = await readFile(journal);
    let rollbackSynced = false,
      fail = true;
    faults.beforeSync = async (path, mode) => {
      if (!path.endsWith('drafts.journal')) return;
      if (mode === 'a' && fail) {
        fail = false;
        throw new Error('injected fsync failure');
      }
      if (mode === 'r+') rollbackSynced = true;
    };
    await expect(store.save(update('not acknowledged'))).rejects.toThrow('injected fsync failure');
    await expect(store.flush()).rejects.toThrow('injected fsync failure');
    expect(rollbackSynced).toBe(true);
    expect(await readFile(journal)).toEqual(prefix);
    expect(await store.save(update('retry acknowledged'))).toBe(2);
    await store.flush();
    expect((await new UiRecoveryStore(dir, codec).load()).drafts['fixture-session']?.text).toBe(
      'retry acknowledged',
    );
  });

  it('blocks subsequent appends when rollback itself fails', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    await store.save(update('confirmed'));
    faults.beforeSync = async (_path, mode) => {
      if (mode === 'a') throw new Error('injected fsync failure');
    };
    faults.failTruncate = true;
    await expect(store.save(update('unconfirmed'))).rejects.toThrow('bloqueada');
    const bytes = await readFile(join(dir, 'drafts.journal'));
    const opened = faults.opens;
    faults.failTruncate = false;
    faults.beforeSync = undefined;
    await expect(store.save(update('must not be acknowledged'))).rejects.toThrow('bloqueada');
    await expect(store.flush()).rejects.toThrow('bloqueada');
    expect(faults.opens).toBe(opened);
    expect(await readFile(join(dir, 'drafts.journal'))).toEqual(bytes);
  });

  it('explicit retry clears a rolled-back save error without needing a surviving renderer', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    await store.save(update('last acknowledged'));
    faults.beforeSync = async (_path, mode) => {
      if (mode === 'a') throw new Error('temporary disk failure');
    };
    await expect(store.save(update('not acknowledged'))).rejects.toThrow('temporary disk failure');
    faults.beforeSync = undefined;
    await expect(store.flush()).rejects.toThrow();
    expect((await store.retry()).drafts['fixture-session']?.text).toBe('last acknowledged');
    await store.flush();
    expect((await store.load()).revision).toBe(1);
    expect(await store.save(update('new confirmed edit'))).toBe(2);
  });

  it('retry refuses a valid unacknowledged record after failed rollback', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    await store.save(update('confirmed'));
    faults.beforeSync = async (_path, mode) => {
      if (mode === 'a') throw new Error('failed sync');
    };
    faults.failTruncate = true;
    await expect(store.save(update('unknown save result'))).rejects.toThrow('bloqueada');
    faults.beforeSync = undefined;
    faults.failTruncate = false;
    const before = await readFile(join(dir, 'drafts.journal'));
    await expect(store.retry()).rejects.toThrow('verificar');
    await expect(store.save(update('must not overwrite'))).rejects.toThrow('verificar');
    expect(await readFile(join(dir, 'drafts.journal'))).toEqual(before);
  });

  it('retry quarantines a partial suffix while preserving the acknowledged projection', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    await store.save(update('confirmed'));
    const partial = Buffer.from('{interrupted');
    await appendFile(join(dir, 'drafts.journal'), partial);
    expect((await store.retry()).revision).toBe(1);
    const quarantine = (await readdir(dir)).find((name) => name.endsWith('.quarantine'));
    expect(await readFile(join(dir, quarantine ?? 'missing'))).toEqual(partial);
    expect(await store.save(update('next'))).toBe(2);
  });

  it('retry waits for an in-flight save before checking its acknowledged projection', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    const entered = deferred(),
      release = deferred();
    faults.beforeSync = async (_path, mode) => {
      if (mode === 'a') {
        entered.release();
        await release.promise;
      }
    };
    const save = store.save(update('in flight'));
    await entered.promise;
    let done = false;
    const retry = store.retry().then((state) => {
      done = true;
      return state;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    release.release();
    await save;
    expect((await retry).drafts['fixture-session']?.text).toBe('in flight');
  });

  it('retry recovers a transient initial decoder failure without resetting history', async () => {
    const first = new UiRecoveryStore(dir, codec);
    await first.load();
    await first.save(update('existing confirmed draft'));
    let locked = true;
    const restored = new UiRecoveryStore(dir, {
      encode: codec.encode,
      decode: (text) => {
        if (locked) throw new Error('OS storage locked');
        return text;
      },
    });
    await expect(restored.load()).rejects.toThrow('OS storage locked');
    await expect(restored.retry()).rejects.toThrow('OS storage locked');
    locked = false;
    expect((await restored.retry()).drafts['fixture-session']?.text).toBe(
      'existing confirmed draft',
    );
    await restored.flush();
  });

  it('fails closed for a corrupt interior record without truncating later data', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    await store.save(update('confirmed'));
    const journal = join(dir, 'drafts.journal');
    await appendFile(journal, '{"payload":"bad","checksum":"wrong"}\n{"trailing":true}');
    const before = await readFile(journal);
    await expect(new UiRecoveryStore(dir, codec).load()).rejects.toThrow('Checksum');
    expect(await readFile(journal)).toEqual(before);
  });

  it('preserves a corrupt snapshot and refuses silently starting with empty drafts', async () => {
    const snapshot = join(dir, 'drafts.snapshot');
    await writeFile(snapshot, '{broken snapshot');
    await expect(new UiRecoveryStore(dir, codec).load()).rejects.toThrow();
    expect(await readFile(snapshot, 'utf8')).toBe('{broken snapshot');
  });

  it('recovers a damaged compacted snapshot from backup plus later journal entries', async () => {
    const store = new UiRecoveryStore(dir, codec);
    await store.load();
    for (let i = 1; i <= 65; i++) await store.save(update(`confirmed ${i}`));
    await writeFile(join(dir, 'drafts.snapshot'), '{damaged primary');
    const state = await new UiRecoveryStore(dir, codec).load();
    expect(state.revision).toBe(65);
    expect(state.drafts['fixture-session']?.text).toBe('confirmed 65');
    expect(await readFile(join(dir, 'drafts.snapshot'), 'utf8')).toBe('{damaged primary');
  });

  it.each([1, 2, 3])(
    'retains every acknowledged draft if compaction rename %i fails',
    async (rename) => {
      const store = new UiRecoveryStore(dir, codec);
      await store.load();
      faults.failRenameAt = rename;
      for (let i = 1; i <= 64; i++) await store.save(update(`confirmed ${i}`));
      expect(faults.renames).toBe(rename);
      faults.failRenameAt = 0;
      const state = await new UiRecoveryStore(dir, codec).load();
      expect(state.revision).toBe(64);
      expect(state.drafts['fixture-session']?.text).toBe('confirmed 64');
    },
  );

  it.each(['reload', ['close'], { action: 'close' }, null])(
    'rejects unknown or coercible window actions: %j',
    (action) => {
      expect(WindowActionSchema.safeParse(action).success).toBe(false);
    },
  );
});
