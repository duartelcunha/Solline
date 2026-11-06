import type { PullRequest } from '@solline/protocol';

export interface PullConfirmation {
  title: string;
  message: string;
  detail: string;
  acceptLabel: string;
  cancelLabel: string;
}

/** O que a janela nativa mostra antes do push. O repositório é `owner/repo`, sem URL. */
export function pullConfirm(repo: string, branch: string): PullConfirmation {
  return {
    title: 'Abrir pull request',
    message: `Enviar ${branch} para ${repo}?`,
    detail: 'Isto faz push do branch. Não faz merge.',
    acceptLabel: 'Enviar',
    cancelLabel: 'Cancelar',
  };
}

/**
 * Confirma e só depois abre. Se a confirmação falha, o push não chega a ser pedido.
 */
export async function openPullRequest(input: {
  preview(): Promise<{ repo: string; branch: string }>;
  confirm(data: PullConfirmation): Promise<boolean>;
  create(): Promise<PullRequest>;
}): Promise<PullRequest> {
  const { repo, branch } = await input.preview();
  const accepted = await input.confirm(pullConfirm(repo, branch));
  if (!accepted) throw new Error('Não enviei o branch.');
  return input.create();
}
