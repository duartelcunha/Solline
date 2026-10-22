import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recoveryCodec } from './recovery-codec';
import { UiRecoveryStore } from './ui-recovery';

const prefix = 'solline-ui-v1:';
const text = JSON.stringify({
  text: 'Rascunho português 🧪 — não reenviar automaticamente',
  pendingSend: null,
});
async function removeFixture(directory: string): Promise<void> {
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('solline-codec-test-'))
    throw new Error('Unsafe fixture path');
  await rm(target, { recursive: true, force: true });
}
function mutate(encoded: string, offset: number): string {
  const bytes = Buffer.from(encoded.slice(prefix.length), 'base64');
  const current = bytes[offset];
  if (current === undefined) throw new Error('Invalid mutation offset');
  bytes[offset] = current ^ 1;
  return prefix + bytes.toString('base64');
}

describe('vault-key UI recovery codec', () => {
  it('decrypts exact Unicode in an independent codec and randomizes every record', () => {
    const key = randomBytes(32);
    const first = recoveryCodec(() => key);
    const encoded = first.encode(text);
    const again = first.encode(text);
    expect(encoded.startsWith(prefix)).toBe(true);
    expect(encoded).not.toBe(again);
    expect(Buffer.from(encoded.slice(prefix.length), 'base64').subarray(0, 12)).not.toEqual(
      Buffer.from(again.slice(prefix.length), 'base64').subarray(0, 12),
    );
    expect(recoveryCodec(() => Buffer.from(key)).decode(encoded)).toBe(text);
    expect(first.decode(first.encode(''))).toBe('');
  });

  it.each([0, 12, 28])(
    'authenticates nonce/tag/ciphertext byte %i without invoking legacy decoding',
    (offset) => {
      const key = randomBytes(32);
      const legacy = vi.fn(() => 'must not be used');
      const codec = recoveryCodec(() => key, legacy);
      expect(() => codec.decode(mutate(codec.encode(text), offset))).toThrow();
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  it('rejects a different vault key and records encrypted for the engine context', () => {
    const key = randomBytes(32);
    const codec = recoveryCodec(() => key);
    const ciphertext = codec.encode(text);
    expect(() => recoveryCodec(() => randomBytes(32)).decode(ciphertext)).toThrow();
    const nonce = randomBytes(12);
    const other = createCipheriv('aes-256-gcm', key, nonce);
    // Engine journals deliberately do not use the UI domain's authenticated context.
    const data = Buffer.concat([other.update(text), other.final()]);
    const otherEnvelope =
      prefix + Buffer.concat([nonce, other.getAuthTag(), data]).toString('base64');
    expect(() => codec.decode(otherEnvelope)).toThrow();
  });

  it.each([
    'solline-ui-v2:AAAA',
    'solline-ui-v1:not base64!',
    'solline-ui-v1:AA==',
    'solline-ui-v1:',
    'solline-ui-v1:AAAA\n',
    '',
  ])('fails closed for malformed/versioned input %j', (input) => {
    const legacy = vi.fn(() => 'must not be used');
    const codec = recoveryCodec(() => randomBytes(32), legacy);
    expect(() => codec.decode(input)).toThrow();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('uses legacy decoding only explicitly and propagates its failure', () => {
    const old = Buffer.from('opaque pre-release OS ciphertext').toString('base64');
    const key = randomBytes(32);
    expect(() => recoveryCodec(() => key).decode(old)).toThrow('Formato');
    const legacy = vi.fn(() => {
      throw new Error('OS decrypt failed');
    });
    expect(() => recoveryCodec(() => key, legacy).decode(old)).toThrow('OS decrypt failed');
    expect(legacy).toHaveBeenCalledExactlyOnceWith(old);
    expect(
      recoveryCodec(
        () => key,
        () => text,
      ).decode(old),
    ).toBe(text);
  });

  it.each([undefined, new Uint8Array(16), new Uint8Array(33)])(
    'does not encrypt/decrypt without a valid vault key',
    (invalid) => {
      const encoded = recoveryCodec(() => randomBytes(32)).encode(text);
      const codec = recoveryCodec(() => invalid);
      expect(() => codec.encode(text)).toThrow('chave');
      expect(() => codec.decode(encoded)).toThrow('chave');
    },
  );

  it('reads the current key getter rather than retaining a stale key across startup retry', () => {
    let key: Buffer | undefined;
    const codec = recoveryCodec(() => key);
    expect(() => codec.encode(text)).toThrow('chave');
    key = randomBytes(32);
    const original = Buffer.from(key);
    const encoded = codec.encode(text);
    key = randomBytes(32);
    expect(() => codec.decode(encoded)).toThrow();
    key = original;
    expect(codec.decode(encoded)).toBe(text);
  });

  it('reopens acknowledged encrypted drafts with a fresh store and codec', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'solline-codec-test-'));
    try {
      const key = randomBytes(32);
      const store = new UiRecoveryStore(
        directory,
        recoveryCodec(() => key),
      );
      await store.load();
      const update = { sessionId: 'fixture', text, pendingSend: 'pedido sem resposta 🧪' };
      await store.save(update);
      const disk = await readFile(join(directory, 'drafts.journal'), 'utf8');
      expect(disk).not.toContain('Rascunho');
      expect(disk).not.toContain('pedido sem resposta');
      expect(disk).toContain(prefix);
      const restored = await new UiRecoveryStore(
        directory,
        recoveryCodec(() => Buffer.from(key)),
      ).load();
      expect(restored.revision).toBe(1);
      expect(restored.drafts.fixture).toEqual({
        text: update.text,
        pendingSend: update.pendingSend,
      });
      await expect(
        new UiRecoveryStore(
          directory,
          recoveryCodec(() => randomBytes(32)),
        ).load(),
      ).rejects.toThrow();
      expect(await readFile(join(directory, 'drafts.journal'), 'utf8')).toBe(disk);
    } finally {
      await removeFixture(directory);
    }
  });
});
