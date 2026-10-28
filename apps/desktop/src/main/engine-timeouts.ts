import type { EngineCommandName } from '@solline/protocol';

const TIMEOUT_MS: Partial<Record<EngineCommandName, number>> = {
  'engine.ping': 5_000,
  'agents.list': 45_000,
  'agents.loginStart': 75_000,
  'session.start': 120_000,
  'session.resume': 120_000,
  'spaces.dispatch': 180_000,
  'spaces.analyze': 180_000,
  'spaces.tick': 180_000,
  // O registo é um pedido de rede; a sonda arranca o servidor (o npx pode descarregar o pacote).
  'mcp.search': 30_000,
  'mcp.draft': 30_000,
  'mcp.probe': 150_000,
  'mcp.approveNow': 150_000,
};
export function engineTimeout(command: EngineCommandName): number {
  return TIMEOUT_MS[command] ?? 20_000;
}
