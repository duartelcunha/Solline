import { describe, expect, it } from 'vitest';
import { nextStep, proofLine } from './glance.ts';

const idle = {
  state: 'idle' as const,
  archived: false,
  failingChecks: 0,
  pendingFiles: 0,
  queued: 0,
  hasTurns: true,
};

describe('o próximo passo', () => {
  it('põe o que precisa de ti à frente do resto', () => {
    expect(nextStep({ ...idle, archived: true, state: 'needs-you' })).toBe(
      'O PR entrou. A sessão fica para ler.',
    );
    expect(nextStep({ ...idle, state: 'needs-you', failingChecks: 2 })).toBe(
      'Há um pedido à tua espera.',
    );
    expect(nextStep({ ...idle, state: 'error' })).toBe('A ligação caiu. Podes retomar.');
    expect(nextStep({ ...idle, failingChecks: 1, pendingFiles: 3 })).toBe(
      'Uma verificação falhou. Podes mandá-la ao agente.',
    );
    expect(nextStep({ ...idle, pendingFiles: 2 })).toBe('Há alterações por rever.');
  });

  it('distingue trabalhar, começar e continuar', () => {
    expect(nextStep({ ...idle, state: 'running', queued: 0 })).toBe(
      'Está a trabalhar. Podes deixar uma mensagem na fila.',
    );
    expect(nextStep({ ...idle, state: 'running', queued: 2 })).toBe(
      'Está a trabalhar. Há mensagens na fila.',
    );
    expect(nextStep({ ...idle, state: 'starting' })).toBe('A preparar a sessão.');
    expect(nextStep({ ...idle, hasTurns: false })).toBe('Escreve a primeira mensagem.');
    expect(nextStep(idle)).toBe('Podes continuar, ou rever o que ficou.');
  });
});

describe('o resumo da prova', () => {
  it('junta ficheiros e verificações, e cala-se quando não há nada', () => {
    expect(proofLine({ pendingFiles: 0, passed: 0, failed: 0, running: false })).toBeNull();
    expect(proofLine({ pendingFiles: 1, passed: 2, failed: 0, running: false })).toBe(
      '1 ficheiro por rever · Verificações passaram',
    );
    expect(proofLine({ pendingFiles: 3, passed: 0, failed: 1, running: false })).toBe(
      '3 ficheiros por rever · 1 verificação falhou',
    );
    expect(proofLine({ pendingFiles: 0, passed: 1, failed: 1, running: true })).toBe(
      'Verificações a correr',
    );
  });
});
