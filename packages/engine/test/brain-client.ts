import net from 'node:net';

/** Um cliente do canal da Solline escrito à mão, para os testes (o shim é o cliente a sério). */
export interface ChannelClient {
  send(message: unknown): void;
  /** Escreve texto tal e qual, sem fim de linha. */
  raw(text: string): void;
  /** A próxima mensagem do motor (rejeita se a ligação fechar antes). */
  next(): Promise<Record<string, unknown>>;
  /** Fecha quando o motor fecha a ligação. */
  closed: Promise<void>;
  isClosed(): boolean;
  destroy(): void;
}

export async function connectChannel(address: string): Promise<ChannelClient> {
  const socket = net.connect(address);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let closed = false;
  const queue: Record<string, unknown>[] = [];
  const waiters: { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }[] =
    [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else queue.push(message);
    }
  });
  socket.on('error', () => undefined);
  const done = new Promise<void>((resolve) => {
    socket.on('close', () => {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter.reject(new Error('ligação fechada'));
      resolve();
    });
  });
  return {
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
    raw: (text) => socket.write(text),
    next: () => {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      if (closed) return Promise.reject(new Error('ligação fechada'));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    closed: done,
    isClosed: () => closed,
    destroy: () => socket.destroy(),
  };
}

/** Faz o hello e devolve a primeira resposta do motor. */
export async function hello(address: string, token: string): Promise<Record<string, unknown>> {
  const client = await connectChannel(address);
  client.send({ type: 'hello', token });
  try {
    return await client.next();
  } finally {
    client.destroy();
  }
}
