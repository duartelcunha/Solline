import { PassThrough } from 'node:stream';
import type { AcpTransport } from '../../src/index.ts';
import { runFakeAcpAgent, type FakeAcpOptions } from './acp-agent.ts';

/** O agente ACP falso ligado ao adaptador por streams, dentro do teste. */
export function fakeAcp(options: FakeAcpOptions = {}) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const agent = runFakeAcpAgent(toAgent, fromAgent, options);
  let exit: (v: unknown) => void = () => undefined;
  const exited = new Promise((r) => (exit = r));
  toAgent.on('finish', () => exit(0));
  const transport: AcpTransport = {
    input: fromAgent,
    output: toAgent,
    exited,
    kill: async () => exit(0),
  };
  return { transport: () => transport, received: agent.received, crash: () => fromAgent.end() };
}
