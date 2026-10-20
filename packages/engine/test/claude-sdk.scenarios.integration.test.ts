import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRASH_MESSAGE, ClaudeSdkAdapter, SessionManager } from '../src/index.ts';
import type { EngineEvent } from '@solline/protocol';
import { recordingSink, reduce, waitFor } from './helpers.ts';

/**
 * Cenários reais do M1 com Haiku e effort low: interromper (#444), plano (ExitPlanMode),
 * pergunta (AskUserQuestion) e o claude.exe a morrer a meio (#359) com retoma por resume.
 * Saltar com SOLLINE_SKIP_SDK=1.
 */
const skip = process.env.SOLLINE_SKIP_SDK === '1';
const T = 180_000;

describe.skipIf(skip)('cenários reais do Claude', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'solline-sc-'));
    await writeFile(path.join(cwd, 'notes.txt'), 'The quick alpha fox.\n');
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  });

  function haiku(
    mode = 'default',
    extra: Partial<ConstructorParameters<typeof ClaudeSdkAdapter>[0]> = {},
  ) {
    const sink = recordingSink();
    const adapter = new ClaudeSdkAdapter(
      { cwd, mode, model: 'haiku', effort: 'low', loadSettings: false, ...extra },
      sink,
    );
    return { sink, adapter };
  }

  it(
    'interromper a meio fecha o turno e a sessão continua a responder',
    { timeout: T },
    async () => {
      const { sink, adapter } = haiku();
      try {
        await adapter.start();
        await adapter.send('Count from 1 to 400, one number per line, no other text.');
        await waitFor(() => sink.deltas.some((d) => d.type === 'block.append'), 120_000);
        await adapter.interrupt();
        await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'), 60_000);
        expect(sink.deltas.find((d) => d.type === 'turn.end')).toMatchObject({
          outcome: 'interrupted',
        });
        await waitFor(() => sink.states.at(-1)?.state === 'idle', 30_000);

        const ends = () => sink.deltas.filter((d) => d.type === 'turn.end').length;
        await adapter.send('Reply with the single word: ok');
        await waitFor(() => ends() === 2, 120_000);
        const last = reduce(sink.deltas).at(-1);
        const text = last?.blocks.find((b) => b.kind === 'text');
        expect(text?.kind === 'text' && text.text.toLowerCase()).toContain('ok');
      } finally {
        await adapter.close();
      }
    },
  );

  it(
    'em Plan, o ExitPlanMode chega como cartão de plano e aprovar não pendura',
    { timeout: T },
    async () => {
      const { sink, adapter } = haiku('plan');
      try {
        await adapter.start();
        const ask = sink.nextAsk();
        await adapter.send(
          'Make a two-step plan to change "alpha" to "beta" in notes.txt, then call ExitPlanMode with it. Do not edit anything yet.',
        );
        const request = await ask;
        expect(request.kind).toBe('plan');
        expect(request.kind === 'plan' && request.plan.length).toBeGreaterThan(5);
        // Aprovar e logo a seguir recusar a edição, para o teste não mexer no ficheiro.
        const next = sink.nextAsk();
        adapter.answerPermission(request.id, { decision: 'allow-once' });
        const edit = await Promise.race([
          next,
          waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'), 120_000).then(() => null),
        ]);
        if (edit) adapter.answerPermission(edit.id, { decision: 'deny' });
        await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'), 120_000);
        expect(sink.deltas).toContainEqual({
          type: 'settings',
          settings: { mode: expect.not.stringMatching(/^plan$/) },
        });
      } finally {
        await adapter.close();
      }
    },
  );

  it(
    'o AskUserQuestion chega como pergunta e a resposta volta ao modelo',
    { timeout: T },
    async () => {
      const { sink, adapter } = haiku();
      try {
        await adapter.start();
        const ask = sink.nextAsk();
        await adapter.send(
          'Use the AskUserQuestion tool to ask me which colour I prefer, with the options "Red" and "Blue". Then reply with only the colour I chose.',
        );
        const request = await ask;
        expect(request.kind).toBe('question');
        const question = request.kind === 'question' ? request.questions[0] : undefined;
        expect(question?.options.map((o) => o.label)).toEqual(
          expect.arrayContaining(['Red', 'Blue']),
        );
        adapter.answerPermission(request.id, {
          decision: 'answer',
          answers: { [question!.question]: 'Blue' },
        });
        await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'), 120_000);
        const text = reduce(sink.deltas)
          .at(-1)
          ?.blocks.filter((b) => b.kind === 'text')
          .map((b) => (b.kind === 'text' ? b.text : ''))
          .join(' ');
        expect(text?.toLowerCase()).toContain('blue');
      } finally {
        await adapter.close();
      }
    },
  );

  it(
    'se o claude.exe morre, a sessão fica em erro e retoma com o histórico',
    { timeout: T },
    async () => {
      const children: ChildProcess[] = [];
      const events: EngineEvent[] = [];
      const manager = new SessionManager({
        emit: (event) => events.push(event),
        adapters: {
          claude: (options, sink) =>
            new ClaudeSdkAdapter(
              {
                ...options,
                loadSettings: false,
                spawn: (o) => {
                  const child = spawn(o.command, o.args, {
                    cwd: o.cwd,
                    env: o.env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                  });
                  children.push(child);
                  return child as never;
                },
              },
              sink,
            ),
        },
      });
      const idle = (n: number) =>
        waitFor(
          () => events.filter((e) => e.type === 'session.state' && e.state === 'idle').length >= n,
          120_000,
        );
      try {
        const { session } = await manager.create({
          projectId: 'p',
          agent: 'claude',
          cwd,
          mode: 'default',
          model: 'haiku',
          effort: 'low',
        });
        await manager.send(session.id, 'Remember the code word "heron". Reply with: noted');
        await idle(2);

        children[0]!.kill('SIGKILL');
        await waitFor(
          () => events.some((e) => e.type === 'session.state' && e.state === 'error'),
          30_000,
        );
        expect(events.find((e) => e.type === 'session.state' && e.state === 'error')).toMatchObject(
          { error: CRASH_MESSAGE },
        );

        await manager.resume(session.id);
        expect(children).toHaveLength(2);
        const before = events.length;
        await manager.send(session.id, 'What was the code word? Reply with the word only.');
        await waitFor(
          () =>
            events
              .slice(before)
              .some((e) => e.type === 'session.event' && e.delta.type === 'turn.end'),
          120_000,
        );
        const text = events
          .slice(before)
          .flatMap((e) =>
            e.type === 'session.event' &&
            e.delta.type === 'block.upsert' &&
            e.delta.block.kind === 'text'
              ? [e.delta.block.text]
              : [],
          )
          .join(' ');
        expect(text.toLowerCase()).toContain('heron');
      } finally {
        await manager.disposeAll();
      }
    },
  );
});
