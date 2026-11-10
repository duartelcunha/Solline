import type { SessionState } from '@solline/protocol';

/** A frase do cabeçalho: o que fazer a seguir, sem depender de um tooltip. */
export function nextStep(input: {
  state: SessionState;
  archived: boolean;
  failingChecks: number;
  pendingFiles: number;
  queued: number;
  hasTurns: boolean;
}): string {
  if (input.archived) return 'O PR entrou. A sessão fica para ler.';
  if (input.state === 'needs-you') return 'Há um pedido à tua espera.';
  if (input.state === 'error') return 'A ligação caiu. Podes retomar.';
  if (input.failingChecks > 0) return 'Uma verificação falhou. Podes mandá-la ao agente.';
  if (input.pendingFiles > 0) return 'Há alterações por rever.';
  if (input.state === 'starting') return 'A preparar a sessão.';
  if (input.state === 'running') {
    return input.queued > 0
      ? 'Está a trabalhar. Há mensagens na fila.'
      : 'Está a trabalhar. Podes deixar uma mensagem na fila.';
  }
  if (!input.hasTurns) return 'Escreve a primeira mensagem.';
  return 'Podes continuar, ou rever o que ficou.';
}

export function checkCounts(results: readonly { state: string }[] | undefined): {
  passed: number;
  failed: number;
  running: boolean;
} {
  let passed = 0;
  let failed = 0;
  let running = false;
  for (const result of results ?? []) {
    if (result.state === 'passed') passed += 1;
    else if (result.state === 'failed' || result.state === 'timeout') failed += 1;
    else if (result.state === 'running') running = true;
  }
  return { passed, failed, running };
}

/** O que mudou e que prova há. Null quando ainda não há nada a resumir. */
export function proofLine(input: {
  pendingFiles: number;
  passed: number;
  failed: number;
  running: boolean;
}): string | null {
  const parts: string[] = [];
  if (input.pendingFiles > 0) {
    parts.push(
      input.pendingFiles === 1
        ? '1 ficheiro por rever'
        : `${input.pendingFiles} ficheiros por rever`,
    );
  }
  if (input.running) parts.push('Verificações a correr');
  else if (input.failed > 0) {
    parts.push(
      input.failed === 1 ? '1 verificação falhou' : `${input.failed} verificações falharam`,
    );
  } else if (input.passed > 0) parts.push('Verificações passaram');
  return parts.length > 0 ? parts.join(' · ') : null;
}
