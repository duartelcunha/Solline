import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { RecoveryCodec } from './ui-recovery';

const PREFIX = 'solline-ui-v1:';
const CONTEXT = Buffer.from('Solline UI recovery v1', 'utf8');

/** The key is already durable in Credential Manager before any draft is acknowledged. */
export function recoveryCodec(
  key: () => Uint8Array | undefined,
  legacyDecode?: (encoded: string) => string,
): RecoveryCodec {
  const currentKey = () => {
    const value = key();
    if (!value || value.byteLength !== 32)
      throw new Error('A chave protegida dos rascunhos não está disponível.');
    return value;
  };
  return {
    encode(text) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', currentKey(), nonce);
      cipher.setAAD(CONTEXT);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    decode(encoded) {
      if (!encoded.startsWith(PREFIX)) {
        // Only pre-release DPAPI journals use this explicitly provided legacy decoder.
        // A failed decode must propagate: never reinterpret it as an empty draft store.
        if (
          encoded.startsWith('solline-ui-') ||
          !legacyDecode ||
          !encoded ||
          Buffer.from(encoded, 'base64').toString('base64') !== encoded
        )
          throw new Error('Formato de rascunhos desconhecido. Os dados foram preservados.');
        return legacyDecode(encoded);
      }
      const payload = encoded.slice(PREFIX.length);
      const bytes = Buffer.from(payload, 'base64');
      if (bytes.toString('base64') !== payload) throw new Error('Rascunho encriptado inválido.');
      if (bytes.length < 28) throw new Error('Rascunho encriptado incompleto.');
      const decipher = createDecipheriv('aes-256-gcm', currentKey(), bytes.subarray(0, 12));
      decipher.setAAD(CONTEXT);
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}
