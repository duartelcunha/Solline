import type { PermissionAnswer } from '@solline/protocol';
import { ClaudeSdkAdapter, type AgentAdapter } from '../../src/index.ts';
import { fakeQuery, loadFixture, recordingSink, type RecordingSink } from '../helpers.ts';

/**
 * Um agente na suite de contrato: reproduz um cenário gravado (sem rede) com o adaptador
 * de verdade. Cada agente novo junta aqui um harness e os mesmos nomes de cenário.
 */
export interface Harness {
  agent: string;
  /** Cenários que este agente tem gravados. */
  scenarios: readonly ScenarioName[];
  open(scenario: ScenarioName): { adapter: AgentAdapter; sink: RecordingSink };
}

export type ScenarioName = 'plain-answer' | 'thinking' | 'edit-with-permission' | 'denied-edit';

/** O que a interface responde a cada pedido do cenário. */
export const ANSWERS: Record<ScenarioName, PermissionAnswer | null> = {
  'plain-answer': null,
  thinking: null,
  'edit-with-permission': { decision: 'allow-once' },
  'denied-edit': { decision: 'deny' },
};

export const claudeHarness: Harness = {
  agent: 'claude',
  scenarios: ['plain-answer', 'thinking', 'edit-with-permission', 'denied-edit'],
  open(scenario) {
    const sink = recordingSink();
    const adapter = new ClaudeSdkAdapter(
      {
        cwd: 'C:/tmp/proj',
        mode: 'default',
        queryFn: fakeQuery(loadFixture(scenario)).queryFn,
        loadSettings: false,
      },
      sink,
    );
    return { adapter, sink };
  },
};

export const HARNESSES: readonly Harness[] = [claudeHarness];
