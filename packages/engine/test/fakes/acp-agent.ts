/**
 * Um agente ACP v1 falso, para os testes do adaptador genérico. Corre dentro do teste (com
 * streams) ou como processo de verdade: node test/fakes/acp-agent.ts.
 *
 * Responde conforme o texto do pedido: "edit" pede autorização para uma edição (com diff),
 * "slow" fica à espera de session/cancel, o resto é uma resposta simples com raciocínio.
 */
import type { Readable, Writable } from 'node:stream';

export interface FakeAcpOptions {
  /** Começa num modo de acesso total (para testar que a Solline sai dele). */
  startInFullAccess?: boolean;
  /** Modo em que arranca (por omissão "ask"). */
  startMode?: string;
  /** Ao receber um pedido, volta sozinho ao modo YOLO (config_option_update). */
  flipToYolo?: boolean;
  /** Sem config options: modos e modelos à moda antiga. */
  legacy?: boolean;
  resume?: boolean;
  authRequired?: boolean;
  protocolVersion?: number;
  /** Ignora o texto do pedido e faz sempre este cenário (suite de contrato). */
  scenario?: 'plain' | 'edit';
}

type Msg = Record<string, unknown> & {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

export function runFakeAcpAgent(input: Readable, output: Writable, options: FakeAcpOptions = {}) {
  const received: Msg[] = [];
  let nextId = 1000;
  const waiting = new Map<unknown, (msg: Msg) => void>();
  let cancel: (() => void) | null = null;
  let mode = options.startInFullAccess ? 'yolo' : (options.startMode ?? 'ask');
  let model = 'fast';
  let effort = 'low';
  const send = (msg: unknown) =>
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...(msg as object) })}\n`);
  const update = (sessionId: unknown, u: unknown) =>
    send({ method: 'session/update', params: { sessionId, update: u } });
  const request = (method: string, params: unknown) =>
    new Promise<Msg>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });

  const configOptions = () => [
    {
      id: 'mode',
      name: 'Modo',
      category: 'mode',
      type: 'select',
      currentValue: mode,
      options: [
        { value: 'ask', name: 'Ask', description: 'Pergunta antes de mexer' },
        { value: 'plan', name: 'Plan', description: 'Só planeia' },
        { value: 'build', name: 'Build', description: 'Faz e corre sem perguntar dentro da pasta' },
        { value: 'yolo', name: 'YOLO', description: 'Faz tudo sem perguntar' },
      ],
    },
    {
      id: 'model',
      name: 'Modelo',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [
        { value: 'fast', name: 'Rápido', description: 'Barato' },
        { value: 'smart', name: 'Esperto' },
      ],
    },
    {
      id: 'effort',
      name: 'Esforço',
      category: 'thought_level',
      type: 'select',
      currentValue: effort,
      options: [
        { value: 'low', name: 'Baixo' },
        { value: 'high', name: 'Alto' },
      ],
    },
  ];
  const session = () =>
    options.legacy
      ? {
          modes: {
            currentModeId: mode,
            availableModes: [
              { id: 'ask', name: 'Ask' },
              { id: 'bypassPermissions', name: 'Bypass' },
            ],
          },
          models: { currentModelId: model, availableModels: [{ modelId: 'fast', name: 'Rápido' }] },
        }
      : { configOptions: configOptions() };

  async function prompt(id: unknown, params: Record<string, unknown>) {
    const sessionId = params.sessionId;
    const text = String((params.prompt as { text?: string }[])[0]?.text ?? '');
    if (options.scenario === undefined && text.includes('slow')) {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'A trabalhar…' },
      });
      await new Promise<void>((resolve) => (cancel = resolve));
      send({ id, result: { stopReason: 'cancelled' } });
      return;
    }
    if (options.scenario === 'edit' || (options.scenario === undefined && text.includes('edit'))) {
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Editar notes.txt',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: 'C:/p/notes.txt', line: 1 }],
        content: [{ type: 'diff', path: 'C:/p/notes.txt', oldText: 'alpha', newText: 'beta' }],
        rawInput: { path: 'notes.txt' },
      });
      const answer = await request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'call-1' },
        options: [
          { optionId: 'once', name: 'Permitir', kind: 'allow_once' },
          { optionId: 'always', name: 'Permitir sempre neste projeto', kind: 'allow_always' },
          { optionId: 'no', name: 'Recusar', kind: 'reject_once' },
          { optionId: 'never', name: 'Recusar sempre', kind: 'reject_always' },
        ],
      });
      const outcome = (answer.result as { outcome: { outcome: string; optionId?: string } })
        .outcome;
      const allowed =
        outcome.outcome === 'selected' &&
        (outcome.optionId === 'once' || outcome.optionId === 'always');
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: allowed ? 'completed' : 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: allowed ? 'Feito.' : 'Recusado.' } },
        ],
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: allowed ? 'Editei o ficheiro.' : 'Não editei.' },
      });
      send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    update(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'A pensar ' },
    });
    update(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'no assunto.' },
    });
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [{ content: 'Responder', priority: 'high', status: 'completed' }],
    });
    for (const chunk of ['Um **monorepo** ', 'é um só repositório.']) {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk },
      });
    }
    update(sessionId, {
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200000,
      cost: { amount: 0.0123, currency: 'USD' },
    });
    send({ id, result: { stopReason: 'end_turn' } });
  }

  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      i = buffer.indexOf('\n');
      if (!line) continue;
      const msg = JSON.parse(line) as Msg;
      received.push(msg);
      if (msg.method === undefined) {
        waiting.get(msg.id)?.(msg);
        continue;
      }
      const params = msg.params ?? {};
      switch (msg.method) {
        case 'initialize':
          send({
            id: msg.id,
            result: {
              protocolVersion: options.protocolVersion ?? 1,
              agentCapabilities: {
                loadSession: false,
                sessionCapabilities: options.resume ? { resume: {} } : {},
              },
              authMethods: [],
              agentInfo: { name: 'fake', version: '1.0.0' },
            },
          });
          break;
        case 'session/new':
          if (options.authRequired) {
            send({ id: msg.id, error: { code: -32000, message: 'Authentication required' } });
          } else {
            send({ id: msg.id, result: { sessionId: 'sess-1', ...session() } });
          }
          break;
        case 'session/resume':
          send({ id: msg.id, result: session() });
          break;
        case 'session/set_config_option': {
          if (params.configId === 'mode') mode = String(params.value);
          if (params.configId === 'model') model = String(params.value);
          if (params.configId === 'effort') effort = String(params.value);
          send({ id: msg.id, result: { configOptions: configOptions() } });
          break;
        }
        case 'session/set_mode':
          mode = String(params.modeId);
          send({ id: msg.id, result: {} });
          break;
        case 'session/prompt':
          if (options.flipToYolo) {
            mode = 'yolo';
            send({
              method: 'session/update',
              params: {
                sessionId: params.sessionId,
                update: { sessionUpdate: 'config_option_update', configOptions: configOptions() },
              },
            });
          }
          void prompt(msg.id, params);
          break;
        case 'session/cancel':
          cancel?.();
          cancel = null;
          break;
        default:
          if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'não' } });
      }
    }
  });
  return { received };
}

// Como processo: node test/fakes/acp-agent.ts
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  runFakeAcpAgent(process.stdin, process.stdout, {});
}
