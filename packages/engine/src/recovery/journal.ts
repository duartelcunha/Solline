import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

interface RecordLine<T> {
  version: 1;
  sequence: number;
  value: T;
  checksum: string;
}
const checksum = (sequence: number, value: unknown) =>
  createHash('sha256').update(JSON.stringify({ sequence, value })).digest('hex');

/** Single-writer durable records. A final incomplete append is never an acknowledged save. */
export class DurableJournal<T> {
  readonly #directory: string;
  readonly #parse: (value: unknown) => T;
  readonly #key: Buffer;
  readonly records: T[] = [];
  #sequence = 0;
  #failed: Error | undefined;
  readonly #owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  #closed = false;
  constructor(directory: string, parse: (value: unknown) => T, key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error('A chave de recuperação não está disponível.');
    this.#key = Buffer.from(key);
    this.#directory = directory;
    this.#parse = parse;
    mkdirSync(directory, { recursive: true });
    this.#claim();
    try {
      this.#load();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  get error(): Error | undefined {
    return this.#failed;
  }
  get sequence(): number {
    return this.#sequence;
  }
  #load(): void {
    this.records.length = 0;
    this.#sequence = 0;
    const snapshot = path.join(this.#directory, 'snapshot.json');
    let snapshotFailure: unknown;
    if (existsSync(snapshot)) {
      try {
        this.#read(readFileSync(snapshot, 'utf8').trim(), true);
      } catch (error) {
        snapshotFailure = error;
        this.records.length = 0;
        this.#sequence = 0;
      }
    }
    const journal = path.join(this.#directory, 'journal.ndjson');
    const bytes = existsSync(journal) ? readFileSync(journal) : Buffer.alloc(0);
    const end = bytes.lastIndexOf(10) + 1;
    // Without a usable snapshot, #read requires a complete authenticated sequence from 1.
    // Do not quarantine/replace anything until that entire fallback has validated.
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n'))
      if (line) this.#read(line);
    if (snapshotFailure) {
      if (!this.records.length) throw snapshotFailure;
      renameSync(snapshot, path.join(this.#directory, `corrupt-snapshot-${randomUUID()}.json`));
    }
    if (end !== bytes.length) {
      writeFileSync(
        path.join(this.#directory, `incomplete-${randomUUID()}.ndjson`),
        bytes.subarray(end),
      );
      truncateSync(journal, end);
    }
  }
  #read(line: string, snapshot = false): void {
    const sealed = JSON.parse(line) as {
      version: number;
      nonce: string;
      tag: string;
      data: string;
    };
    if (sealed.version !== 1) throw new Error('Versão de recuperação desconhecida.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      Buffer.from(sealed.nonce, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const record = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    ) as RecordLine<unknown>;
    if (
      record.version !== 1 ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 1 ||
      record.checksum !== checksum(record.sequence, record.value)
    )
      throw new Error(
        'O histórico de recuperação está danificado; os ficheiros foram preservados.',
      );
    if (record.sequence <= this.#sequence) return;
    if (!snapshot && record.sequence !== this.#sequence + 1)
      throw new Error(
        'Falta um registo no histórico de recuperação; os ficheiros foram preservados.',
      );
    const value = this.#parse(record.value);
    this.#sequence = record.sequence;
    this.records.push(value);
  }
  #seal(record: RecordLine<T>): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const data = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    return (
      JSON.stringify({
        version: 1,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }) + '\n'
    );
  }
  append(value: T): void {
    if (this.#closed) throw new Error('O histórico de recuperação já está fechado.');
    if (this.#failed) throw this.#failed;
    const parsed = this.#parse(value);
    const sequence = this.#sequence + 1;
    const record: RecordLine<T> = {
      version: 1,
      sequence,
      value: parsed,
      checksum: checksum(sequence, parsed),
    };
    let fd: number | undefined;
    try {
      fd = openSync(path.join(this.#directory, 'journal.ndjson'), 'a');
      const bytes = Buffer.from(this.#seal(record));
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
      this.#sequence = sequence;
    } catch (error) {
      this.#failed = new Error(
        'Não foi possível guardar a recuperação. O trabalho ainda não está confirmado no disco.',
        { cause: error },
      );
      throw this.#failed;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  #claim(): void {
    const file = path.join(this.#directory, 'writer.lock');
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd: number | undefined;
      try {
        fd = openSync(file, 'wx');
        writeFileSync(fd, this.#owner);
        fsyncSync(fd);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const previous = readFileSync(file, 'utf8');
        const owner = JSON.parse(previous) as { pid?: unknown };
        if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0)
          throw new Error('O bloqueio de recuperação é inválido; não foi removido.', {
            cause: error,
          });
        let alive = true;
        try {
          process.kill(owner.pid as number, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
        if (alive)
          throw new Error('Outro motor ainda está a usar este histórico de recuperação.', {
            cause: error,
          });
        if (readFileSync(file, 'utf8') === previous) unlinkSync(file);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    throw new Error('Não foi possível reservar o histórico de recuperação.');
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const file = path.join(this.#directory, 'writer.lock');
    if (existsSync(file) && readFileSync(file, 'utf8') === this.#owner) unlinkSync(file);
    this.#key.fill(0);
  }
  /** Snapshot replacement is atomic; the journal stays until the replacement is durable. */
  snapshot(value: T): void {
    this.append(value);
    const sequence = this.#sequence;
    const record: RecordLine<T> = {
      version: 1,
      sequence,
      value,
      checksum: checksum(sequence, value),
    };
    const temporary = path.join(this.#directory, `snapshot-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx');
      writeFileSync(fd, this.#seal(record));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path.join(this.#directory, 'snapshot.json'));
      // Retain the journal: an interrupted rename or directory flush cannot erase its fallback.
    } catch (error) {
      this.#failed = new Error('Não foi possível concluir o snapshot de recuperação.', {
        cause: error,
      });
      throw this.#failed;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Explicit save retry only. Re-read authenticated records before replacing an uncertain append. */
  retrySnapshot(value: T): void {
    if (this.#closed) throw new Error('O histórico de recuperação já está fechado.');
    const previousFailure = this.#failed;
    try {
      if (readFileSync(path.join(this.#directory, 'writer.lock'), 'utf8') !== this.#owner)
        throw new Error('A reserva do histórico mudou.');
      this.#load();
      this.#failed = undefined;
      this.snapshot(value);
      this.records.length = 0;
    } catch (error) {
      this.#failed = error instanceof Error ? error : (previousFailure ?? new Error(String(error)));
      throw this.#failed;
    }
  }
}
