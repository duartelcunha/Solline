import { describe, expect, it } from 'vitest';
import type { PullRequest } from '@solline/protocol';
import { openPullRequest, pullConfirm } from './pull-confirm.ts';

const pull: PullRequest = {
  id: 'gh-pr-7',
  sessionId: 'sessao-1',
  key: '7',
  title: 'Corrige o parser',
  state: 'open',
};

describe('confirmação do PR', () => {
  it('mostra o repositório e o branch, e sem sim não há push', async () => {
    const order: string[] = [];
    await expect(
      openPullRequest({
        preview: () => {
          order.push('preview');
          return Promise.resolve({ repo: 'duartelcunha/atelier', branch: 'solline/parser-ab12' });
        },
        confirm: (data) => {
          order.push('confirm');
          expect(data).toEqual(pullConfirm('duartelcunha/atelier', 'solline/parser-ab12'));
          expect(data.message).toContain('duartelcunha/atelier');
          expect(data.message).toContain('solline/parser-ab12');
          expect(data.detail).toContain('Não faz merge');
          return Promise.resolve(false);
        },
        create: () => {
          order.push('create');
          return Promise.resolve(pull);
        },
      }),
    ).rejects.toThrow('Não enviei o branch.');
    expect(order).toEqual(['preview', 'confirm']);
  });

  it('o push só é pedido depois do sim', async () => {
    const order: string[] = [];
    const opened = await openPullRequest({
      preview: () => {
        order.push('preview');
        return Promise.resolve({ repo: 'duartelcunha/atelier', branch: 'solline/parser-ab12' });
      },
      confirm: () => {
        order.push('confirm');
        return Promise.resolve(true);
      },
      create: () => {
        order.push('create');
        return Promise.resolve(pull);
      },
    });
    expect(opened.id).toBe('gh-pr-7');
    expect(order).toEqual(['preview', 'confirm', 'create']);
  });
});
