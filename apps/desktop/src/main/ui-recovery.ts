import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DraftUpdate, UiRecoveryState } from '@solline/protocol/bridge';
import { DraftUpdateSchema, UiRecoverySchema } from './window-schemas.ts';

export interface RecoveryCodec {
  encode(text: string): string;
  decode(text: string): string;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function durableWrite(file: string, bytes: string | Buffer, append = false): Promise<void> {
  const handle = await open(file, append ? 'a' : 'w', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableTruncate(file: string, size: number): Promise<void> {
  const handle = await open(file, 'r+');
  try {
    await handle.truncate(size);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOptional(file: string): Promise<Buffer | null> {
  return readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

/** Encrypted application drafts only. No credentials, environment, or SDK sessions. */
export class UiRecoveryStore {
  #state: UiRecoveryState = { version: 1, revision: 0, drafts: {} };
  #tail: Promise<void> = Promise.resolve();
  #error: Error | undefined;
  #fatal: Error | undefined;
  #loaded = false;
  readonly #journal: string;
  readonly #snapshot: string;
  readonly #backup: string;
  constructor(
    readonly directory: string,
    readonly codec: RecoveryCodec,
  ) {
    this.#journal = join(directory, 'drafts.journal');
    this.#snapshot = join(directory, 'drafts.snapshot');
    this.#backup = join(directory, 'drafts.snapshot.backup');
  }

  async load(): Promise<UiRecoveryState> {
    if (this.#loaded) {
      await this.flush();
      return structuredClone(this.#state);
    }
    await mkdir(this.directory, { recursive: true });
    const snapshot = await readOptional(this.#snapshot);
    let state: UiRecoveryState = { version: 1, revision: 0, drafts: {} };
    if (snapshot !== null) {
      try {
        state = this.#decodeSnapshot(snapshot);
      } catch (error) {
        const backup = await readOptional(this.#backup);
        if (backup === null) throw error;
        state = this.#decodeSnapshot(backup);
      }
    } else {
      const backup = await readOptional(this.#backup);
      if (backup !== null) state = this.#decodeSnapshot(backup);
    }
    const contents = (await readOptional(this.#journal)) ?? Buffer.alloc(0);
    let offset = 0;
    while (offset < contents.length) {
      const newline = contents.indexOf(10, offset);
      const complete = newline !== -1;
      const end = complete ? newline : contents.length;
      const bytes = contents.subarray(offset, end);
      try {
        const record = JSON.parse(bytes.toString('utf8')) as { payload: string; checksum: string };
        if (typeof record.payload !== 'string' || digest(record.payload) !== record.checksum)
          throw new Error('Checksum inválido');
        const decoded = JSON.parse(this.codec.decode(record.payload)) as {
          revision: number;
          update: unknown;
        };
        const update = DraftUpdateSchema.parse(decoded.update);
        if (!Number.isSafeInteger(decoded.revision) || decoded.revision < 1)
          throw new Error('Revisão inválida');
        if (decoded.revision > state.revision) {
          if (decoded.revision !== state.revision + 1) throw new Error('Sequência incompleta');
          state = this.#apply(state, update, decoded.revision);
        }
      } catch (error) {
        // A complete corrupt record is never mistaken for an interrupted final write.
        if (complete) throw error;
        await durableWrite(join(this.directory, `drafts-tail-${Date.now()}.quarantine`), bytes);
        await durableTruncate(this.#journal, offset);
        break;
      }
      if (!complete) {
        // A valid last record may have lost only its delimiter. Repair before another append.
        await durableWrite(this.#journal, '\n', true);
      }
      offset = end + 1;
    }
    this.#state = state;
    this.#loaded = true;
    return structuredClone(this.#state);
  }

  save(raw: DraftUpdate): Promise<number> {
    const update = DraftUpdateSchema.parse(raw);
    const operation = this.#tail.then(async () => {
      if (this.#fatal) throw this.#fatal;
      if (!this.#loaded) throw new Error('Recuperação ainda não está pronta');
      const revision = this.#state.revision + 1;
      const payload = this.codec.encode(JSON.stringify({ revision, update }));
      const before = await stat(this.#journal)
        .then((s) => s.size)
        .catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return 0;
          throw e;
        });
      try {
        await durableWrite(
          this.#journal,
          JSON.stringify({ payload, checksum: digest(payload) }) + '\n',
          true,
        );
      } catch (error) {
        try {
          await durableTruncate(this.#journal, before);
        } catch {
          this.#fatal = new Error(
            'Não foi possível restaurar o último rascunho confirmado. A gravação está bloqueada para preservar os dados existentes.',
          );
        }
        throw this.#fatal ?? error;
      }
      this.#state = this.#apply(this.#state, update, revision);
      this.#error = undefined;
      // The committed journal remains authoritative if optional compaction fails.
      if (revision % 64 === 0) await this.#compact().catch(() => undefined);
      return revision;
    });
    this.#tail = operation.then(
      () => undefined,
      (error: unknown) => {
        this.#error = error instanceof Error ? error : new Error(String(error));
      },
    );
    return operation;
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#error) throw this.#error;
  }

  /** Explicit recovery after a failed save/startup; never upgrades an unacknowledged write. */
  retry(): Promise<UiRecoveryState> {
    const operation = this.#tail.then(async () => {
      if (!this.#loaded) {
        const loaded = await this.load();
        this.#error = undefined;
        return loaded;
      }
      try {
        // Validate the disk again without replacing the last acknowledged memory state.
        // Any newer complete record remains an unknown result, never silently accepted.
        const verified = await new UiRecoveryStore(this.directory, this.codec).load();
        if (JSON.stringify(verified) !== JSON.stringify(this.#state))
          throw new Error('O disco não corresponde ao último rascunho confirmado.');
        this.#error = undefined;
        this.#fatal = undefined;
        return structuredClone(this.#state);
      } catch (error) {
        this.#fatal = new Error(
          'Não foi possível verificar o último rascunho confirmado. Os dados existentes foram preservados.',
          { cause: error },
        );
        throw this.#fatal;
      }
    });
    this.#tail = operation.then(
      () => undefined,
      (error: unknown) => {
        this.#error = error instanceof Error ? error : new Error(String(error));
      },
    );
    return operation;
  }

  #decodeSnapshot(bytes: Buffer): UiRecoveryState {
    const state = UiRecoverySchema.parse(JSON.parse(this.codec.decode(bytes.toString('utf8'))));
    if (!Number.isSafeInteger(state.revision)) throw new Error('Revisão inválida');
    return state;
  }

  #apply(state: UiRecoveryState, update: DraftUpdate, revision: number): UiRecoveryState {
    const { sessionId, ...draft } = update;
    return { ...state, revision, drafts: { ...state.drafts, [sessionId]: draft } };
  }

  async #compact(): Promise<void> {
    const bytes = this.codec.encode(JSON.stringify(this.#state));
    const temporary = this.#snapshot + '.next';
    await durableWrite(temporary, bytes);
    // Keep a redundant complete checkpoint before replacing either live file. The previous
    // journal is still authoritative if any write/rename fails; after replacement the backup
    // can recover a damaged primary snapshot without discarding subsequent journal entries.
    await durableWrite(this.#backup + '.next', bytes);
    await rename(this.#backup + '.next', this.#backup);
    await rename(temporary, this.#snapshot);
    await durableWrite(this.#journal + '.next', '');
    await rename(this.#journal + '.next', this.#journal);
  }
}
