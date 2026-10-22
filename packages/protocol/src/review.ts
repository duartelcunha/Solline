import { z } from 'zod';

/**
 * Rever e desfazer, igual para qualquer agente. O motor guarda um checkpoint escondido antes
 * e depois de cada turno (um git sombra fora do projeto) e a interface só vê isto: a linha do
 * tempo, os diffs já partidos em hunks e as ações sobre eles.
 */

export const FileStatus = z.enum(['added', 'modified', 'deleted']);
export type FileStatus = z.infer<typeof FileStatus>;

/** Uma linha do diff. Os números são da versão antiga e da nova (null do lado que não tem). */
export const DiffLine = z.object({
  kind: z.enum(['context', 'add', 'del']),
  text: z.string(),
  oldNo: z.number().int().nullable(),
  newNo: z.number().int().nullable(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const Hunk = z.object({
  /** Muda quando o conteúdo do hunk muda: uma ação sobre um id velho é recusada. */
  id: z.string(),
  header: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  lines: z.array(DiffLine),
});
export type Hunk = z.infer<typeof Hunk>;

export const FileDiff = z.object({
  path: z.string(),
  status: FileStatus,
  binary: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
  hunks: z.array(Hunk),
  /** Ficheiro grande demais para mostrar linha a linha; as ações ao ficheiro inteiro valem. */
  truncated: z.boolean().optional(),
});
export type FileDiff = z.infer<typeof FileDiff>;

/** Contas rápidas de um conjunto de alterações, para a linha do tempo e os medidores. */
export const DiffStats = z.object({
  files: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type DiffStats = z.infer<typeof DiffStats>;

/**
 * O que comparar. review: o que ainda não aceitaste contra o disco · turn: o que um turno
 * mudou · session: tudo desde o início da sessão.
 */
export const DiffScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('review') }).strict(),
  z.object({ kind: z.literal('turn'), turnId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('session') }).strict(),
]);
export type DiffScope = z.infer<typeof DiffScope>;

/** Um turno na linha do tempo: o estado do disco antes e o que mudou até ao fim. */
export const Checkpoint = z.object({
  /** Id do turno do utilizador que abriu este checkpoint. */
  turnId: z.string(),
  index: z.number().int(),
  /** A primeira linha da mensagem. */
  title: z.string(),
  at: z.number(),
  /** running: o turno ainda corre (o diff vai mudando). */
  state: z.enum(['running', 'done', 'interrupted']),
  stats: DiffStats,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/** Como esta sessão rebobina a conversa: no próprio agente, ou numa sessão nova com resumo. */
export const ConversationRewind = z.enum(['agent', 'summary']);
export type ConversationRewind = z.infer<typeof ConversationRewind>;

export const Timeline = z.object({
  /** false quando não há git nesta máquina ou a pasta não deixa guardar checkpoints. */
  available: z.boolean(),
  reason: z.string().optional(),
  checkpoints: z.array(Checkpoint),
  /** O que está por rever (aceitar ou rejeitar) neste momento. */
  pending: DiffStats,
  /** A ação que "Desfazer" desfaz, numa frase; null se não houver nenhuma. */
  undo: z.string().nullable(),
  conversationRewind: ConversationRewind,
  /** O turno para onde os ficheiros foram rebobinados por último, enquanto nada mudar depois. */
  rewoundTo: z.string().nullable(),
});
export type Timeline = z.infer<typeof Timeline>;

const SessionRef = { sessionId: z.string().min(1) };
const Path = z.string().min(1).max(4096);

export const ReviewAction = z.enum(['accept', 'reject']);
export type ReviewAction = z.infer<typeof ReviewAction>;

/** Um comentário numa linha do diff de rever; seguem todos juntos como a próxima mensagem. */
export const ReviewComment = z
  .object({
    path: Path,
    /** Linha do lado novo (ou do antigo, numa linha apagada). */
    line: z.number().int().min(1),
    side: z.enum(['old', 'new']),
    text: z.string().min(1).max(10_000),
  })
  .strict();
export type ReviewComment = z.infer<typeof ReviewComment>;

export const reviewCommandSchemas = {
  /** A linha do tempo atual (também chega em session.timeline sempre que muda). */
  'review.timeline': {
    payload: z.object(SessionRef).strict(),
    result: Timeline,
  },
  'review.diff': {
    payload: z.object({ ...SessionRef, scope: DiffScope }).strict(),
    result: z.object({ files: z.array(FileDiff) }),
  },
  /**
   * Aceitar fica com a alteração e tira-a de rever; rejeitar volta a pô-la como estava no
   * disco. Sem hunkId, vale para o ficheiro inteiro; sem path, para tudo o que está por rever.
   */
  'review.apply': {
    payload: z
      .object({
        ...SessionRef,
        action: ReviewAction,
        path: Path.optional(),
        hunkId: z.string().min(1).max(128).optional(),
      })
      .strict(),
    result: Timeline,
  },
  /** Desfaz a última ação de rever ou de rebobinar ficheiros. */
  'review.undo': { payload: z.object(SessionRef).strict(), result: Timeline },
  /** Manda os comentários (e uma nota opcional) como a próxima mensagem para o agente. */
  'review.comment': {
    payload: z
      .object({
        ...SessionRef,
        comments: z.array(ReviewComment).min(1).max(50),
        note: z.string().max(20_000).optional(),
      })
      .strict(),
    result: z.object({ turnId: z.string() }),
  },
  /**
   * Volta ao estado de antes de um turno: os ficheiros, a conversa ou os dois. A conversa
   * rebobina no agente quando ele sabe; nos outros abre-se uma sessão nova com um resumo.
   */
  'session.rewind': {
    payload: z
      .object({
        ...SessionRef,
        turnId: z.string().min(1).max(64),
        files: z.boolean(),
        conversation: z.boolean(),
      })
      .strict()
      .refine((p) => p.files || p.conversation, 'Escolhe ficheiros, conversa ou os dois'),
    result: z.object({
      timeline: Timeline,
      /** A mensagem desse turno, para voltar à caixa de texto quando a conversa rebobina. */
      text: z.string().nullable(),
      conversation: ConversationRewind.nullable(),
    }),
  },
} as const;
