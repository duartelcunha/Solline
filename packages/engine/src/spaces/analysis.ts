import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SpacesState } from '@solline/protocol';
import { type SpaceManager, digest } from './manager.ts';
import { collectProject, redact, type ContextSource } from './context.ts';

const Idea = z
  .object({
    projectId: z.string().nullable(),
    title: z.string().min(1).max(300),
    detail: z.string().min(1).max(4000),
    sources: z.array(z.string()).min(1).max(10),
  })
  .strict();
const Lesson = z
  .object({
    projectId: z.string().nullable(),
    text: z.string().min(1).max(2000),
    sources: z.array(z.string()).min(1).max(10),
  })
  .strict();
export const AnalysisOutput = z
  .object({ insights: z.array(Idea).max(8), memories: z.array(Lesson).max(8) })
  .strict();
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;
export type AnalysisRunner = (input: {
  agent: string;
  model: string;
  sources: ContextSource[];
  known: string[];
  signal: AbortSignal;
}) => Promise<AnalysisOutput>;
interface Options {
  manager: SpaceManager;
  run: AnalysisRunner;
  history(): ContextSource[];
  idle(): boolean;
  now?: () => number;
}

export class SpaceAnalysis {
  readonly #options: Options;
  #pending: Promise<SpacesState> | undefined;
  #controller: AbortController | undefined;
  #generation = 0;
  constructor(options: Options) {
    this.#options = options;
  }
  cancel(): void {
    this.#generation++;
    this.#controller?.abort();
    if (this.#options.manager.snapshot().analysis.state === 'running')
      this.#options.manager.changeAnalysis((s) => {
        s.analysis.state = 'paused';
        s.analysis.error = 'A análise foi interrompida. Podes iniciá-la de novo.';
      });
  }
  async stop(): Promise<void> {
    this.cancel();
    await this.#pending?.catch(() => undefined);
  }
  analyze(proactive: boolean): Promise<SpacesState> {
    if (this.#pending) return this.#pending;
    const generation = this.#generation;
    const work = this.#analyze(proactive).catch((error: unknown) => {
      if (
        generation === this.#generation &&
        this.#options.manager.snapshot().analysis.state !== 'paused'
      )
        this.#options.manager.changeAnalysis((s) => {
          s.analysis.state = 'paused';
          s.analysis.error =
            error instanceof Error
              ? redact(error.message)
              : 'Não foi possível analisar os projetos.';
        });
      if (proactive) return this.#options.manager.snapshot();
      throw error;
    });
    this.#pending = work;
    void work
      .finally(() => {
        if (this.#pending === work) this.#pending = undefined;
      })
      .catch(() => undefined);
    return work;
  }
  async #analyze(proactive: boolean): Promise<SpacesState> {
    const { manager } = this.#options;
    const state = manager.snapshot();
    const { settings } = state;
    const now = this.#options.now?.() ?? Date.now();
    if (
      proactive &&
      (settings.analysisMode !== 'proactive' ||
        state.analysis.state === 'paused' ||
        !this.#options.idle() ||
        (state.analysis.lastAt !== null && now - state.analysis.lastAt < 86_400_000))
    )
      return state;
    if (!settings.agent) {
      if (proactive) return state;
      throw new Error('Escolhe um agente de análise.');
    }
    const projects = manager.projects();
    if (!projects.length) {
      if (proactive) return state;
      throw new Error('Escolhe pelo menos um projeto de confiança.');
    }
    const generation = this.#generation;
    const collected = await Promise.all(projects.map(collectProject));
    if (generation !== this.#generation) return manager.snapshot();
    const files = Object.assign({}, ...collected.map((c) => c.files)) as Record<string, string>;
    const authorized = new Set(projects.map((p) => p.id));
    const history = this.#options
      .history()
      .filter((s) => s.projectId === null || authorized.has(s.projectId))
      .slice(-100)
      .map((s) => ({ ...s, text: redact(s.text).slice(0, 8000) }));
    const fingerprint = digest(JSON.stringify({ files, history }));
    if (
      fingerprint === state.analysis.fingerprint &&
      Object.entries(files).every(([id, hash]) => state.analysis.files[id] === hash)
    )
      return manager.snapshot();
    let remaining = 100_000;
    const sources = [
      ...history,
      ...collected
        .flatMap((c) => c.sources)
        .filter((s) => state.analysis.files[s.id] !== files[s.id]),
    ].flatMap((s) => {
      if (remaining <= 0) return [];
      if (s.text.length > remaining) return [];
      remaining -= s.text.length;
      return [s];
    });
    // Removed files are represented by their absence; no model call is needed without evidence.
    if (!sources.length) return manager.snapshot();
    const sourceMap = new Map(sources.map((s) => [s.id, s]));
    const valid = (projectId: string | null, ids: string[]) =>
      (projectId === null || authorized.has(projectId)) &&
      ids.every(
        (id) =>
          sourceMap.has(id) &&
          (projectId === null ||
            sourceMap.get(id)?.projectId === projectId ||
            sourceMap.get(id)?.projectId === null),
      );
    this.#controller = new AbortController();
    const timeout = setTimeout(() => this.#controller?.abort(), 120_000);
    manager.changeAnalysis((s) => {
      s.analysis = { ...s.analysis, state: 'running', error: null, lastAt: now };
    });
    try {
      const output = AnalysisOutput.parse(
        await this.#options.run({
          agent: settings.agent,
          model: settings.model,
          sources,
          known: state.insights.map((i) => `${i.projectId ?? 'Geral'}: ${i.title} (${i.state})`),
          signal: this.#controller.signal,
        }),
      );
      if (generation !== this.#generation) return manager.snapshot();
      if (this.#controller.signal.aborted) throw new Error('A análise excedeu o tempo disponível.');
      manager.changeAnalysis((s) => {
        for (const idea of output.insights) {
          if (!valid(idea.projectId, idea.sources)) continue;
          const key = digest(`${idea.projectId ?? ''}:${idea.title.trim().toLowerCase()}`);
          if (s.insights.some((i) => i.fingerprint === key)) continue;
          s.insights.unshift({
            ...idea,
            evidence: idea.sources.flatMap((id) => {
              const source = sourceMap.get(id);
              return source ? [{ id, text: source.text.slice(0, 4000) }] : [];
            }),
            id: randomUUID(),
            fingerprint: key,
            state: 'suggested',
            createdAt: now,
          });
        }
        for (const lesson of output.memories) {
          if (!valid(lesson.projectId, lesson.sources)) continue;
          const key = digest(`${lesson.projectId ?? ''}:${lesson.text.trim().toLowerCase()}`);
          if (
            s.forgotten.includes(key) ||
            s.memories.some(
              (m) => digest(`${m.projectId ?? ''}:${m.text.trim().toLowerCase()}`) === key,
            )
          )
            continue;
          // Project evidence cannot silently become a global rule.
          if (
            lesson.projectId === null &&
            lesson.sources.some((id) => sourceMap.get(id)?.projectId !== null)
          )
            continue;
          s.memories.unshift({
            id: randomUUID(),
            projectId: lesson.projectId,
            text: lesson.text,
            source: lesson.sources.join(', '),
            sourceId: lesson.sources[0] ?? null,
            state: settings.learningMode === 'automatic' ? 'active' : 'pending',
            createdAt: now,
          });
        }
        const reviewed = Object.fromEntries(
          Object.entries(state.analysis.files).filter(([id, hash]) => files[id] === hash),
        );
        for (const source of sources) {
          const hash = files[source.id];
          if (hash) reviewed[source.id] = hash;
        }
        s.analysis = { state: 'idle', error: null, lastAt: now, fingerprint, files: reviewed };
      });
    } catch (error) {
      if (generation === this.#generation)
        manager.changeAnalysis((s) => {
          s.analysis.state = 'paused';
          s.analysis.error = error instanceof Error ? error.message : String(error);
        });
      if (!proactive && generation === this.#generation) throw error;
    } finally {
      clearTimeout(timeout);
      this.#controller = undefined;
    }
    return manager.snapshot();
  }
}
