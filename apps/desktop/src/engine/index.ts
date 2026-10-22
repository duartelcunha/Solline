/**
 * Entrada do processo utilitário do motor. Só liga a MessagePort ao Engine;
 * a lógica toda vive em packages/engine e testa-se em Node puro.
 */
import type { MessagePortMain } from 'electron';
import { ENGINE_VERSION, Engine } from '@solline/engine';
import { EngineEvent, EngineSnapshot } from '@solline/protocol';
import { engineOptions } from './options.ts';

let port: MessagePortMain | undefined;

function createEngine(recoveryKey: unknown): Engine {
  if (!(recoveryKey instanceof Uint8Array) || recoveryKey.byteLength !== 32)
    throw new Error('A chave protegida de recuperação não chegou ao motor.');
  return new Engine({
    ...engineOptions(),
    recoveryKey,
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
}

function serve(next: MessagePortMain, recoveryKey: unknown): void {
  port = next;
  let engine: Engine;
  try {
    engine = createEngine(recoveryKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    next.on('message', (event) => {
      const id = (event.data as { id?: unknown } | null)?.id;
      if (typeof id === 'string')
        next.postMessage({ kind: 'response', id, ok: false, error: { message } });
    });
    next.start();
    next.postMessage({ kind: 'event', type: 'engine.error', message } satisfies EngineEvent);
    return;
  }
  next.on('message', (event) => {
    void engine.handle(event.data).then((response) => next.postMessage(response));
  });
  next.start();
  void engine
    .ready()
    .then(async () => {
      const response = await engine.handle({
        kind: 'request',
        id: 'utility-ready-snapshot',
        command: 'engine.snapshot',
        payload: {},
      });
      if (!response.ok) throw new Error(response.error.message);
      const snapshot = EngineSnapshot.parse(response.result);
      next.postMessage({
        kind: 'event',
        type: 'engine.ready',
        engineVersion: ENGINE_VERSION,
        pid: process.pid,
        epoch: snapshot.epoch,
        sequence: snapshot.sequence,
      } satisfies EngineEvent);
    })
    .catch(() => undefined); // Engine emits the preserved startup failure.
}

process.parentPort.once('message', (event) => {
  const [first] = event.ports;
  if (first) serve(first, (event.data as { recoveryKey?: unknown } | null)?.recoveryKey);
});
