import type { Readable, Writable } from 'node:stream';
import { APP_NAME, CLIENT_APP_ID } from '@solline/protocol/app';
import type { JsonRpcPeer, StderrTail } from '../../rpc/json-rpc.ts';
import { killTree, spawnAgent } from '../../rpc/spawn.ts';
import { ENGINE_VERSION } from '../../version.ts';
import type { InitializeParams } from './protocol/InitializeParams';

/** Os fios para o app-server: stdio do processo, ou streams falsos nos testes. */
export interface CodexTransport {
  input: Readable;
  output: Writable;
  stderr?: Readable | undefined;
  exited: Promise<unknown>;
  kill(): Promise<void>;
}

/** Arranca um codex app-server. O stderr vai para o fim guardado em tail. */
export function spawnCodex(options: {
  executable: string;
  env: Record<string, string | undefined>;
  cwd: string;
  stderr: StderrTail;
}): CodexTransport {
  const child = spawnAgent({
    command: options.executable,
    args: ['app-server'],
    env: options.env,
    cwd: options.cwd,
  });
  const exited = new Promise((resolve) => {
    child.on('exit', resolve);
    // Sem isto, um codex.exe que não arranca (apagado, bloqueado) derrubava o motor.
    child.on('error', (error) => {
      options.stderr.push(String(error));
      child.stdout.destroy();
      resolve(error);
    });
  });
  return {
    input: child.stdout,
    output: child.stdin,
    stderr: child.stderr,
    exited,
    kill: () => killTree(child.pid),
  };
}

/** initialize + initialized, na superfície estável (sem a API experimental). */
export async function initializeCodex(peer: JsonRpcPeer, timeoutMs: number): Promise<void> {
  const init: InitializeParams = {
    clientInfo: { name: CLIENT_APP_ID, title: APP_NAME, version: ENGINE_VERSION },
    capabilities: { experimentalApi: false, requestAttestation: false },
  };
  await peer.request('initialize', init, timeoutMs);
  peer.notify('initialized');
}
