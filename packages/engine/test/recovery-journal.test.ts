import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DurableJournal } from '../src/recovery/journal.ts';

const roots: string[] = [];
const key = Buffer.alloc(32, 7);
const schema = z.object({ text: z.string() }).strict();
function directory() {
  const root = mkdtempSync(path.join(tmpdir(), 'solline-journal-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('encrypted recovery journal', () => {
  it('restores the durable snapshot and later records, never plaintext', () => {
    const root = directory();
    const journal = new DurableJournal(root, schema.parse, key);
    journal.append({ text: 'private transcript before snapshot' });
    journal.snapshot({ text: 'snapshot' });
    journal.append({ text: 'last acknowledged message' });
    journal.close();
    const restored = new DurableJournal(root, schema.parse, key);
    expect(restored.records).toEqual([{ text: 'snapshot' }, { text: 'last acknowledged message' }]);
    restored.close();
    for (const file of readdirSync(root))
      expect(readFileSync(path.join(root, file), 'utf8')).not.toContain('private transcript');
    expect(() => new DurableJournal(root, schema.parse, Buffer.alloc(32, 8))).toThrow();
  });
  it('keeps all acknowledged records and preserves an incomplete final append as evidence', () => {
    const root = directory();
    const journal = new DurableJournal(root, schema.parse, key);
    journal.append({ text: 'saved' });
    appendFileSync(path.join(root, 'journal.ndjson'), '{"version":1,"data":"incomplete');
    journal.close();
    const restored = new DurableJournal(root, schema.parse, key);
    expect(restored.records).toEqual([{ text: 'saved' }]);
    expect(readdirSync(root).filter((file) => file.startsWith('incomplete-'))).toHaveLength(1);
    restored.append({ text: 'next' });
    restored.close();
    const next = new DurableJournal(root, schema.parse, key);
    expect(next.records).toEqual([{ text: 'saved' }, { text: 'next' }]);
    next.close();
  });
  it('recovers a damaged snapshot from the complete authenticated journal and retains evidence', () => {
    const root = directory();
    const journal = new DurableJournal(root, schema.parse, key);
    journal.snapshot({ text: 'first acknowledged state' });
    journal.snapshot({ text: 'latest acknowledged state' });
    journal.close();
    writeFileSync(path.join(root, 'snapshot.json'), 'damaged snapshot');
    const restored = new DurableJournal(root, schema.parse, key);
    try {
      expect(restored.records).toEqual([
        { text: 'first acknowledged state' },
        { text: 'latest acknowledged state' },
      ]);
      const evidence = readdirSync(root).find((file) => file.startsWith('corrupt-snapshot-'));
      expect(evidence).toBeDefined();
      expect(readFileSync(path.join(root, evidence!), 'utf8')).toBe('damaged snapshot');
      restored.snapshot({ text: 'recovered and confirmed' });
    } finally {
      restored.close();
    }
  });
  it('refuses corrupt complete records without silently replacing history', () => {
    const root = directory();
    const journal = new DurableJournal(root, schema.parse, key);
    journal.append({ text: 'saved' });
    appendFileSync(path.join(root, 'journal.ndjson'), '{"version":99}\n');
    const before = readFileSync(path.join(root, 'journal.ndjson'));
    journal.close();
    expect(() => new DurableJournal(root, schema.parse, key)).toThrow();
    expect(readFileSync(path.join(root, 'journal.ndjson'))).toEqual(before);
  });
  it('never acknowledges a write failure and remains failed closed', () => {
    const root = directory();
    const journal = new DurableJournal(root, schema.parse, key);
    mkdirSync(path.join(root, 'journal.ndjson'));
    expect(() => journal.append({ text: 'not saved' })).toThrow('Não foi possível guardar');
    expect(journal.sequence).toBe(0);
    rmSync(path.join(root, 'journal.ndjson'), { recursive: true });
    expect(() => journal.append({ text: 'do not silently recover' })).toThrow();
    journal.retrySnapshot({ text: 'explicit retry acknowledged' });
    expect(journal.error).toBeUndefined();
    journal.close();
  });
  it('rejects unknown payload versions rather than accepting lossy state', () => {
    const root = directory();
    const journal = new DurableJournal(root, schema.parse, key);
    expect(() => journal.append({ text: 'ok', unexpected: true } as { text: string })).toThrow();
    expect(journal.sequence).toBe(0);
    journal.close();
    writeFileSync(path.join(root, 'snapshot.json'), 'unknown');
    expect(() => new DurableJournal(root, schema.parse, key)).toThrow();
  });
  it('rejects a second live writer and releases ownership on close', () => {
    const root = directory();
    const journal = new DurableJournal(root, schema.parse, key);
    expect(() => new DurableJournal(root, schema.parse, key)).toThrow('Outro motor');
    journal.close();
    const replacement = new DurableJournal(root, schema.parse, key);
    replacement.append({ text: 'single owner' });
    replacement.close();
  });
});
