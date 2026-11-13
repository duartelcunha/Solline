import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { loadRecoveryKey, removeRecoveryKey } from './recovery-key.ts';

// O runner do Actions não tem cofre de credenciais de utilizador. Num Windows real corre.
const vaultHere = process.platform === 'win32' && process.env.SOLLINE_VAULT !== 'skip';

it.skipIf(!vaultHere)(
  'retains the recovery key in the Windows vault without a credential file',
  async () => {
    const directory = join(tmpdir(), `solline-vault-test-${randomUUID()}`);
    try {
      const first = await loadRecoveryKey(directory);
      const second = await loadRecoveryKey(directory);
      expect(first.length).toBe(32);
      expect(first.equals(second)).toBe(true);
    } finally {
      await removeRecoveryKey(directory);
    }
  },
  45000,
);

it.skipIf(!vaultHere).each(['recovery/engine-v1', 'recovery-ui'])(
  'never substitutes a lost vault key when encrypted %s data exists',
  async (relative) => {
    const directory = await mkdtemp(join(tmpdir(), 'solline-vault-test-'));
    try {
      await mkdir(join(directory, relative), { recursive: true });
      await writeFile(join(directory, relative, 'journal.ndjson'), 'ciphertext fixture');
      await expect(loadRecoveryKey(directory)).rejects.toThrow(
        'não foi criada uma chave substituta',
      );
      await expect(loadRecoveryKey(directory)).rejects.toThrow(
        'não foi criada uma chave substituta',
      );
    } finally {
      await removeRecoveryKey(directory);
      await rm(directory, { recursive: true, force: true });
    }
  },
  45000,
);
