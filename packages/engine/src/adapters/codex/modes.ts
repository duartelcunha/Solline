import type { ModeOption } from '@solline/protocol';
import type { AskForApproval } from './protocol/v2/AskForApproval';
import type { SandboxMode } from './protocol/v2/SandboxMode';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy';

/**
 * Modos do Codex na Solline: política de aprovação mais sandbox. Acesso total
 * (never + danger-full-access) não existe aqui.
 */
export const CODEX_MODES: readonly ModeOption[] = [
  {
    id: 'read-only',
    label: 'Ler',
    description: 'Só lê; pergunta antes de mudar',
    risk: 'read-only',
  },
  {
    id: 'ask',
    label: 'Ask',
    description: 'Pergunta antes de editar ou correr comandos',
    risk: 'ask',
  },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Trabalha na pasta sem perguntar',
    risk: 'auto',
  },
];

export const DEFAULT_CODEX_MODE = 'ask';

interface Policy {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
}

const POLICIES: Record<string, Policy> = {
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only' },
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
};

/** Política para o thread/start e o thread/resume. Um modo desconhecido fica em Ask. */
export function threadPolicy(mode: string | null): Policy {
  return POLICIES[mode ?? DEFAULT_CODEX_MODE] ?? (POLICIES.ask as Policy);
}

/** A mesma política no formato do turn/start (que pede o sandbox por extenso). */
export function turnOverrides(mode: string): {
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
} {
  const policy = threadPolicy(mode);
  return {
    approvalPolicy: policy.approvalPolicy,
    sandboxPolicy:
      policy.sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
  };
}
