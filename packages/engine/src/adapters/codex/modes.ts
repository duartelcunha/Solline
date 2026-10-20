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
    description: 'Só lê; para mudar alguma coisa pede autorização.',
    risk: 'read-only',
  },
  {
    id: 'ask',
    label: 'Ask',
    description: 'Pede autorização para comandos que não são só de leitura e para edições.',
    risk: 'ask',
  },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Edita e corre comandos dentro da pasta sem perguntar; pede para sair dela.',
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
