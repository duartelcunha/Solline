import { randomUUID } from 'node:crypto';
import {
  MEMORY_MAX_CITATIONS,
  MEMORY_MAX_REASON,
  MEMORY_MAX_TEXT,
  RULE_MAX_TEXT,
  blankMemory,
  type AgentId,
  type CommandPayload,
  type MemoryCitation,
  type MemoryEvidence,
  type ProjectRulesView,
  type SpaceMemory,
  type SpacesState,
} from '@solline/protocol';
import { BrainToolError, type TurnInfo } from '../brain/tool.ts';
import type { RulesManager } from '../rules/manager.ts';
import { GENERAL_PROJECT } from '../spaces/manager.ts';
import {
  gitCommitExists,
  hashCited,
  lineCount,
  nodeFiles,
  normalizeCitedPath,
  MAX_CITED_BYTES,
  type ProjectFiles,
} from './evidence.ts';
import {
  describeCitation,
  evidenceKey,
  isFileCitation,
  citationKey,
  memoryKey,
  type FileCitation,
} from './keys.ts';
import {
  indexable,
  oneLine,
  renderHit,
  renderIndex,
  renderRead,
  type MemoryTarget,
} from './render.ts';
import { searchMemories } from './search.ts';
import { staleReason } from './staleness.ts';

/** Por turno, por sessão e por projeto: o que um agente (e o ecrã de aprovação) aguenta. */
export const PROPOSALS_PER_TURN = 5;
export const PROPOSALS_PER_SESSION = 20;
export const PENDING_PER_PROJECT = 100;
export const SEARCH_LIMIT = 8;
/** O estado só é reavaliado (ficheiros lidos) uma vez por este tempo quando a interface o pede. */
const SWEEP_EVERY_MS = 30_000;

/** Onde a memória vive: o estado dos Espaços, que já viaja, persiste e se recupera. */
export interface MemoryStore {
  snapshot(): SpacesState;
  /** Muda o estado inteiro de uma vez; se `update` lançar, nada se guarda. */
  change(update: (state: SpacesState) => void): void;
  /** A pasta de um projeto conhecido. */
  root(projectId: string): string | undefined;
}

/** Quem chama uma ferramenta de memória: tudo vem do motor, nada vem do agente. */
export interface MemoryCaller {
  sessionId: string;
  projectId: string;
  agent: AgentId;
  /** A pasta da sessão (pode ser uma worktree): onde a prova é verificada. */
  cwd: string | undefined;
  turn: TurnInfo;
}

export interface MemoryOptions {
  store: MemoryStore;
  rules?: Pick<RulesManager, 'save'> | undefined;
  now?: (() => number) | undefined;
  files?: ProjectFiles | undefined;
  commitExists?: ((cwd: string, sha: string) => Promise<boolean>) | undefined;
  onMemoryUsed?: ((sessionId: string, memoryIds: readonly string[]) => void) | undefined;
}

export interface MemoryProposal {
  text: string;
  reason: string;
  citations: readonly MemoryCitation[];
}

/** Tira o que não é texto (controlo, invisíveis) e achata espaços: uma memória é uma frase curta. */
function clean(value: string, max: number, label: string): string {
  const flat = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) throw new BrainToolError(`O ${label} está vazio.`);
  if (flat.length > max)
    throw new BrainToolError(`O ${label} tem ${flat.length} caracteres; o máximo é ${max}.`);
  return flat;
}

const WHY_MISSING: Record<'missing' | 'outside' | 'too-big' | 'binary' | 'unreadable', string> = {
  missing: 'não existe nesta pasta',
  outside: 'sai da pasta do projeto',
  'too-big': `é maior do que ${MAX_CITED_BYTES / 1_048_576} MiB`,
  binary: 'não é um ficheiro de texto',
  unreadable: 'não consegui lê-lo agora',
};

function ruleTitle(text: string): string {
  const first = text.split(/(?<=[.!?])\s|\n/)[0] ?? text;
  return oneLine(first, 80) || 'Regra da memória';
}

/**
 * A memória partilhada entre agentes: propostas com prova que o utilizador aprova, procura e
 * leitura por ferramentas, índice no arranque e "a confirmar" quando a prova muda. Nada chega a um
 * agente sem aprovação, e só uma leitura ou procura de um agente conta como uso.
 */
export class MemoryService {
  readonly #store: MemoryStore;
  readonly #rules: Pick<RulesManager, 'save'> | undefined;
  readonly #now: () => number;
  readonly #files: ProjectFiles;
  readonly #commitExists: (cwd: string, sha: string) => Promise<boolean>;
  readonly #onMemoryUsed: ((sessionId: string, memoryIds: readonly string[]) => void) | undefined;
  readonly #perSession = new Map<string, number>();
  readonly #perTurn = new Map<string, number>();
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(options: MemoryOptions) {
    this.#store = options.store;
    this.#rules = options.rules;
    this.#now = options.now ?? Date.now;
    this.#files = options.files ?? nodeFiles;
    this.#commitExists = options.commitExists ?? gitCommitExists;
    this.#onMemoryUsed = options.onMemoryUsed;
  }

  // ---- o que os agentes fazem ----

  /** Propõe uma memória: fica à espera do utilizador, nunca chega a ninguém antes. */
  async propose(caller: MemoryCaller, input: MemoryProposal): Promise<string> {
    if (caller.projectId === GENERAL_PROJECT)
      throw new BrainToolError(
        'O espaço Geral não tem projeto: propõe memórias numa sessão de um projeto.',
      );
    const cwd = caller.cwd;
    if (!cwd)
      throw new BrainToolError(
        'Não sei em que pasta estás, por isso não consigo verificar a prova.',
      );
    const text = clean(input.text, MEMORY_MAX_TEXT, 'texto');
    const reason = clean(input.reason, MEMORY_MAX_REASON, 'motivo');
    if (input.citations.length === 0)
      throw new BrainToolError('Falta a prova: cita pelo menos um ficheiro (ou commit).');
    if (input.citations.length > MEMORY_MAX_CITATIONS)
      throw new BrainToolError(`No máximo ${MEMORY_MAX_CITATIONS} citações.`);

    const turnKey = `${caller.sessionId}\0${caller.turn.id ?? ''}`;
    const state = this.#store.snapshot();
    const pendingOfSession = state.memories.filter(
      (m) => m.state === 'pending' && m.origin?.sessionId === caller.sessionId,
    ).length;
    if (
      Math.max(this.#perSession.get(caller.sessionId) ?? 0, pendingOfSession) >=
      PROPOSALS_PER_SESSION
    )
      throw new BrainToolError(
        `Já propuseste ${PROPOSALS_PER_SESSION} memórias nesta sessão. Espera que o utilizador decida.`,
      );
    if ((this.#perTurn.get(turnKey) ?? 0) >= PROPOSALS_PER_TURN)
      throw new BrainToolError(`No máximo ${PROPOSALS_PER_TURN} propostas por turno.`);
    if (
      state.memories.filter((m) => m.state === 'pending' && m.projectId === caller.projectId)
        .length >= PENDING_PER_PROJECT
    )
      throw new BrainToolError('Há propostas a mais à espera de aprovação neste projeto.');

    const here = memoryKey(caller.projectId, text);
    const everywhere = memoryKey(null, text);
    if (state.forgotten.includes(here) || state.forgotten.includes(everywhere))
      throw new BrainToolError('O utilizador já rejeitou uma memória igual a esta.');
    if (
      state.memories.some((m) => {
        const key = memoryKey(m.projectId, m.text);
        return key === here || key === everywhere;
      })
    )
      throw new BrainToolError('Já existe uma memória igual (aprovada ou à espera de aprovação).');

    const proof = await this.#prove(cwd, input.citations);
    const now = this.#now();
    let id = '';
    this.#store.change((next) => {
      id = this.#newId(next);
      next.memories.unshift(
        blankMemory({
          id,
          projectId: caller.projectId,
          text,
          reason,
          source: `Proposta do agente ${caller.agent}`,
          sourceId: caller.turn.id
            ? `chat:${caller.sessionId}:${caller.turn.id}`
            : `chat:${caller.sessionId}`,
          state: 'pending',
          createdAt: now,
          citations: proof.citations,
          evidence: proof.evidence,
          external: caller.turn.external,
          origin: {
            agent: caller.agent,
            sessionId: caller.sessionId,
            ...(caller.turn.id ? { turnId: caller.turn.id } : {}),
            projectId: caller.projectId,
          },
        }),
      );
    });
    this.#perSession.set(caller.sessionId, (this.#perSession.get(caller.sessionId) ?? 0) + 1);
    this.#perTurn.set(turnKey, (this.#perTurn.get(turnKey) ?? 0) + 1);
    return id;
  }

  /** As citações têm de existir dentro da pasta da sessão; o hash do que dizem fica como prova. */
  async #prove(
    cwd: string,
    citations: readonly MemoryCitation[],
  ): Promise<{ citations: MemoryCitation[]; evidence: MemoryEvidence[] }> {
    const kept: MemoryCitation[] = [];
    const evidence: MemoryEvidence[] = [];
    const seen = new Set<string>();
    for (const citation of citations) {
      if (!isFileCitation(citation)) {
        const sha = citation.commit.toLowerCase();
        if (seen.has(`commit ${sha}`)) continue;
        seen.add(`commit ${sha}`);
        if (!(await this.#commitExists(cwd, sha)))
          throw new BrainToolError(`O commit ${sha} não existe neste repositório.`);
        kept.push({ commit: sha });
        continue;
      }
      const relative = normalizeCitedPath(citation.path);
      if (!relative)
        throw new BrainToolError(
          `A citação "${citation.path}" tem de ser um caminho dentro do projeto (relativo, sem .. nem caminhos absolutos).`,
        );
      const read = await this.#files.read(cwd, relative);
      if (!read.ok)
        throw new BrainToolError(`O ficheiro citado ${relative} ${WHY_MISSING[read.reason]}.`);
      const normalized: FileCitation = {
        path: relative,
        ...(citation.line !== undefined ? { line: citation.line } : {}),
        ...(citation.endLine !== undefined ? { endLine: citation.endLine } : {}),
      };
      const hash = hashCited(read.text, normalized);
      if (hash === undefined)
        throw new BrainToolError(
          `O intervalo ${describeCitation(normalized)} passa do fim do ficheiro (tem ${lineCount(read.text)} linhas).`,
        );
      const key = citationKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(normalized);
      evidence.push({ ...normalized, hash });
    }
    return { citations: kept, evidence };
  }

  #newId(state: SpacesState): string {
    for (;;) {
      const id = randomUUID().replaceAll('-', '').slice(0, 8);
      if (!state.memories.some((m) => m.id.startsWith(id))) return id;
    }
  }

  /** O que um agente pode ver: as aprovadas do projeto (e as gerais), mesmo as a confirmar. */
  #readable(state: SpacesState, projectId: string): SpaceMemory[] {
    return state.memories.filter(
      (m) =>
        (m.state === 'active' || m.state === 'toConfirm') &&
        (m.projectId === null || m.projectId === projectId),
    );
  }

  /** Procura entre as memórias aprovadas; cada resultado conta como uso. */
  async search(caller: MemoryCaller, query: string): Promise<string> {
    await this.#sweepQuietly(caller.projectId);
    const hits = searchMemories(
      this.#readable(this.#store.snapshot(), caller.projectId),
      query,
      SEARCH_LIMIT,
    );
    if (hits.length === 0) return 'Nenhuma memória aprovada responde a isto.';
    const ids = hits.map((m) => m.id);
    this.#touch(ids);
    this.#onMemoryUsed?.(caller.sessionId, ids);
    return hits.map(renderHit).join('\n');
  }

  /** A memória inteira (texto, motivo, prova, origem), com o aviso se estiver a confirmar. */
  async read(caller: MemoryCaller, id: string): Promise<string> {
    await this.#sweepQuietly(caller.projectId);
    const wanted = id.trim().toLowerCase();
    const found = this.#readable(this.#store.snapshot(), caller.projectId).filter(
      (m) =>
        m.id.toLowerCase() === wanted ||
        (wanted.length >= 6 && m.id.toLowerCase().startsWith(wanted)),
    );
    const memory = found.length === 1 ? found[0] : undefined;
    if (!memory)
      throw new BrainToolError('Não há nenhuma memória aprovada com esse id neste projeto.');
    this.#touch([memory.id]);
    this.#onMemoryUsed?.(caller.sessionId, [memory.id]);
    return renderRead(memory);
  }

  #touch(ids: readonly string[]): void {
    const now = this.#now();
    const wanted = new Set(ids);
    try {
      this.#store.change((next) => {
        for (const memory of next.memories) if (wanted.has(memory.id)) memory.lastUsedAt = now;
      });
    } catch {
      // Falhar a gravar o uso nunca impede o agente de ler.
    }
  }

  /** O índice do arranque da sessão (já com o "a confirmar" avaliado), ou nada. */
  async startBlock(
    projectId: string,
    options: { target: MemoryTarget; readTool: boolean },
  ): Promise<string | undefined> {
    await this.#sweepQuietly(projectId);
    return renderIndex(indexable(this.#store.snapshot().memories, projectId), options);
  }

  // ---- o que o utilizador faz ----

  /**
   * Aprova (ou re-aprova) memórias: renova a prova e o relógio. `scope: 'global'` é decisão do
   * utilizador. Tudo ou nada: um id desconhecido não aprova nenhuma.
   */
  async approve(
    input: CommandPayload<'memory.approve'>,
    allowed: readonly SpaceMemory['state'][] = ['pending', 'toConfirm', 'active', 'disabled'],
  ): Promise<SpacesState> {
    const state = this.#store.snapshot();
    const ids = [...new Set(input.ids)];
    for (const key of Object.keys(input.edits ?? {}))
      if (!ids.includes(key))
        throw new Error('Há uma edição para uma memória que não está na lista.');
    const evidence = new Map<string, MemoryEvidence[]>();
    const memories = ids.map((id) => {
      const memory = state.memories.find((m) => m.id === id);
      if (!memory) throw new Error('Memória desconhecida.');
      if (!allowed.includes(memory.state))
        throw new Error('Esta memória não está num estado que se possa aprovar assim.');
      if (input.scope === 'project' && memory.projectId === null && !memory.origin?.projectId)
        throw new Error('Esta memória é geral e não sei de que projeto veio.');
      return memory;
    });
    if (ids.length > 1 && memories.some((memory) => memory.external))
      throw new Error('Uma memória de origem externa aprova-se uma a uma.');
    for (const memory of memories) evidence.set(memory.id, await this.#refresh(memory));
    const now = this.#now();
    this.#store.change((next) => {
      for (const id of ids) {
        const memory = next.memories.find((m) => m.id === id);
        if (!memory) throw new Error('Memória desconhecida.');
        const edit = input.edits?.[id];
        if (edit?.text !== undefined) memory.text = edit.text;
        if (edit?.reason !== undefined) memory.reason = edit.reason;
        if (input.scope === 'global' && memory.projectId !== null) {
          if (memory.origin) memory.origin.projectId ??= memory.projectId;
          memory.projectId = null;
        } else if (input.scope === 'project' && memory.projectId === null) {
          memory.projectId = memory.origin?.projectId ?? null;
        }
        memory.state = 'active';
        memory.stale = null;
        memory.approvedAt = now;
        memory.evidence = evidence.get(id) ?? memory.evidence;
      }
    });
    return this.#store.snapshot();
  }

  /** Re-aprova memórias "a confirmar": a prova de agora passa a ser a de referência. */
  confirm(ids: readonly string[]): Promise<SpacesState> {
    return this.approve({ ids: [...ids] }, ['toConfirm', 'active']);
  }

  /** O hash que a prova tem agora, ou o que já havia quando o ficheiro não está nesta pasta. */
  async #refresh(memory: SpaceMemory): Promise<MemoryEvidence[]> {
    const root = this.#rootOf(memory);
    const out: MemoryEvidence[] = [];
    for (const citation of memory.citations) {
      if (!isFileCitation(citation)) continue;
      const key = citationKey(citation);
      if (root) {
        const read = await this.#files.read(root, citation.path);
        const hash = read.ok ? hashCited(read.text, citation) : undefined;
        if (hash !== undefined) {
          out.push({ ...citation, hash });
          continue;
        }
      }
      const before = memory.evidence.find((e) => evidenceKey(e) === key);
      if (before) out.push(before);
    }
    return out;
  }

  /** "Exportar para regras": a memória aprovada passa a regra do projeto e a memória desliga-se. */
  async toRule(input: CommandPayload<'memory.toRule'>): Promise<ProjectRulesView> {
    const memory = this.#store.snapshot().memories.find((m) => m.id === input.id);
    if (!memory) throw new Error('Memória desconhecida.');
    if (memory.state !== 'active' && memory.state !== 'toConfirm')
      throw new Error('Aprova a memória antes de a passar para as regras.');
    if (memory.projectId !== null && input.projectId && input.projectId !== memory.projectId)
      throw new Error('A regra tem de ir para o projeto da memória.');
    const projectId = memory.projectId ?? input.projectId;
    if (!projectId) throw new Error('Esta memória é geral: escolhe o projeto da regra.');
    if (!this.#rules) throw new Error('As regras não estão disponíveis.');
    const text = memory.reason
      ? `${memory.text.trim()}\n\nPorquê: ${memory.reason}`
      : memory.text.trim();
    if (text.length > RULE_MAX_TEXT) throw new Error('A memória é comprida demais para uma regra.');
    const view = this.#rules.save({
      projectId,
      title: ruleTitle(memory.text),
      text,
      globs: [],
      enabled: true,
    });
    this.#store.change((next) => {
      const current = next.memories.find((m) => m.id === memory.id);
      if (current) {
        current.state = 'disabled';
        current.stale = null;
      }
    });
    return view;
  }

  // ---- "a confirmar" ----

  #rootOf(memory: SpaceMemory): string | undefined {
    const projectId = memory.projectId ?? memory.origin?.projectId;
    return projectId ? this.#store.root(projectId) : undefined;
  }

  /**
   * Passa a "a confirmar" as memórias ativas cuja prova mudou (ou que ficaram 28 dias sem uso).
   * Sem `projectId`, vê todas. Devolve se mudou alguma.
   */
  async sweep(projectId?: string): Promise<boolean> {
    const state = this.#store.snapshot();
    const now = this.#now();
    const stale = new Map<string, 'evidence' | 'age'>();
    const seen = new Map<string, Awaited<ReturnType<ProjectFiles['read']>>>();
    for (const memory of state.memories) {
      if (memory.state !== 'active') continue;
      if (projectId !== undefined && memory.projectId !== null && memory.projectId !== projectId)
        continue;
      const root = this.#rootOf(memory);
      const current = new Map<string, string | undefined>();
      if (root)
        for (const proof of memory.evidence) {
          const at = `${root}\0${proof.path}`;
          let read = seen.get(at);
          if (!read) {
            read = await this.#files.read(root, proof.path);
            seen.set(at, read);
          }
          // Um erro passageiro não conta como mudança: não se sabe, por isso não se mexe.
          if (!read.ok && read.reason === 'unreadable') continue;
          current.set(evidenceKey(proof), read.ok ? hashCited(read.text, proof) : undefined);
        }
      const reason = staleReason(memory, current, now);
      if (reason) stale.set(memory.id, reason);
    }
    if (stale.size === 0) return false;
    this.#store.change((next) => {
      for (const memory of next.memories) {
        const reason = stale.get(memory.id);
        if (reason && memory.state === 'active') {
          memory.state = 'toConfirm';
          memory.stale = reason;
        }
      }
    });
    return true;
  }

  async #sweepQuietly(projectId?: string): Promise<void> {
    try {
      await this.sweep(projectId);
    } catch {
      // Sem conseguir ver o disco ou gravar, o índice e as leituras usam o estado que há.
    }
  }

  /** Para a interface: reavalia tudo, no máximo uma vez a cada 30 segundos. */
  async sweepIfDue(): Promise<void> {
    const now = this.#now();
    if (now - this.#lastSweep < SWEEP_EVERY_MS) return;
    this.#lastSweep = now;
    await this.#sweepQuietly();
  }
}
