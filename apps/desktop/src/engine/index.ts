/**
 * Entrada do processo utilitário do motor. Só liga a MessagePort ao Engine;
 * a lógica toda vive em packages/engine e testa-se em Node puro.
 */
import type { MessagePortMain } from 'electron';
import { ENGINE_VERSION, Engine, claudeReviewer, resolveClaudeExecutable } from '@solline/engine';
import { EngineEvent } from '@solline/protocol';

let port: MessagePortMain | undefined;

const claudeExecutable = resolveClaudeExecutable({
  packaged: process.env.SOLLINE_PACKAGED === '1',
});

const engine = new Engine({
  claudeExecutable,
  dataDir: process.env.SOLLINE_DATA_DIR,
  packaged: process.env.SOLLINE_PACKAGED === '1',
  // Testes e smoke: sem hooks, plugins nem definições do utilizador.
  isolated: process.env.SOLLINE_ISOLATED === '1',
  // O smoke com SDK real liga o revisor mesmo isolado, para o provar de ponta a ponta.
  ...(process.env.SOLLINE_REVIEWER === '1'
    ? { reviewer: claudeReviewer({ claudeExecutable }) }
    : {}),
  emit: (event) => {
    // Validado antes de sair; o main volta a validar ao receber.
    const checked = EngineEvent.safeParse(event);
    if (!checked.success) {
      console.error('[engine] evento inválido não enviado', checked.error.issues[0]);
      return;
    }
    port?.postMessage(checked.data);
  },
});

function serve(next: MessagePortMain): void {
  port = next;
  next.on('message', (event) => {
    void engine.handle(event.data).then((response) => next.postMessage(response));
  });
  next.start();
  next.postMessage({
    kind: 'event',
    type: 'engine.ready',
    engineVersion: ENGINE_VERSION,
    pid: process.pid,
  } satisfies EngineEvent);
}

process.parentPort.once('message', (event) => {
  const [first] = event.ports;
  if (first) serve(first);
});
