/**
 * Entrada do processo utilitário do motor. Só liga a MessagePort ao Engine;
 * a lógica toda vive em packages/engine e testa-se em Node puro.
 */
import type { MessagePortMain } from 'electron';
import { ENGINE_VERSION, Engine, resolveClaudeExecutable } from '@solline/engine';
import type { EngineEvent } from '@solline/protocol';

const engine = new Engine({
  claudeExecutable: resolveClaudeExecutable({ packaged: process.env.SOLLINE_PACKAGED === '1' }),
});

function serve(port: MessagePortMain): void {
  port.on('message', (event) => {
    void engine.handle(event.data).then((response) => port.postMessage(response));
  });
  port.start();
  const ready: EngineEvent = {
    kind: 'event',
    type: 'engine.ready',
    engineVersion: ENGINE_VERSION,
    pid: process.pid,
  };
  port.postMessage(ready);
}

process.parentPort.once('message', (event) => {
  const [port] = event.ports;
  if (port) serve(port);
});
