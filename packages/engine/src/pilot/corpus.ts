import { createHash } from 'node:crypto';

/**
 * Dez tarefas reais do repositório, para avaliação. Não há conjunto de afinação.
 * O texto fica selado antes de qualquer medição.
 */
export interface Task {
  id: string;
  /** Commit curto que entregou a tarefa. */
  source: string;
  milestone: string;
  title: string;
  /** O pedido, como se fosse para refazer a partir do pai desse commit. */
  prompt: string;
  acceptance: readonly string[];
}

const DRAFTS: readonly Omit<Task, 'id'>[] = [
  {
    source: '32a5893',
    milestone: 'M0',
    title: 'Janela e motor fora do renderer',
    prompt: 'Abre a janela de desktop e corre o motor num utilityProcess, ligado por MessagePort.',
    acceptance: [
      'O renderer não carrega o SDK nem o Node.',
      'O motor arranca num utilityProcess e a janela fala com ele por MessagePort.',
    ],
  },
  {
    source: 'ea833dc',
    milestone: 'M1',
    title: 'Conversa em streaming',
    prompt:
      'Mostra a conversa à medida que chega, com permissões e a escolha de modelo, esforço e modo.',
    acceptance: [
      'Os blocos aparecem durante o turno, sem esperar pelo fim.',
      'Modelo, esforço e modo só oferecem o que o agente declarou.',
    ],
  },
  {
    source: 'fde9e21',
    milestone: 'M1',
    title: 'Agentes como dados',
    prompt:
      'Expõe cada agente como dados: transporte, estado nesta máquina, modelos, modos e o que sabe reportar.',
    acceptance: [
      'A interface escolhe o agente a partir da lista do motor.',
      'Custo, contexto e retoma só aparecem quando o agente os reporta.',
    ],
  },
  {
    source: '66c33d2',
    milestone: 'M2',
    title: 'Checkpoint por turno',
    prompt: 'Guarda um checkpoint escondido em cada turno e permite rever hunks e rebobinar ficheiros.',
    acceptance: [
      'Cada turno que muda ficheiros fica com um checkpoint, mesmo que o agente não saiba rebobinar.',
      'Rebobinar os ficheiros volta a esse checkpoint.',
    ],
  },
  {
    source: 'aaf4afd',
    milestone: 'M3',
    title: 'A mesa',
    prompt: 'A vista principal mostra um cartão vivo por sessão, ordenado pelo que precisa de ti.',
    acceptance: [
      'Cada sessão aberta tem um cartão.',
      'Uma sessão que precisa de ti fica à frente de uma que está só a trabalhar.',
    ],
  },
  {
    source: '9fb1cb0',
    milestone: 'M4',
    title: 'Ordenar pela execução',
    prompt:
      'Ordena a corrida primeiro pelas verificações contra a base e pelo consenso, e o juiz só nos empates.',
    acceptance: [
      'Uma pista com verificações melhores fica à frente sem chamar o juiz.',
      'O juiz não corre quando a execução já separa as pistas.',
    ],
  },
  {
    source: 'd2e0e09',
    milestone: 'M4.5',
    title: 'Lançar a repartição',
    prompt:
      'Lança as partes por fases, com contrato, resumo do que os outros mudaram e aviso de escrita fora do âmbito.',
    acceptance: [
      'Cada parte tem âmbito e verificação no contrato.',
      'Escrever fora do âmbito produz um aviso e não é apagado em silêncio.',
    ],
  },
  {
    source: 'f2465d1',
    milestone: 'M5',
    title: 'Passagem de testemunho',
    prompt:
      'Resume a sessão num ponto de partida editável para outro agente, sem enviar esse rascunho sozinho.',
    acceptance: [
      'O rascunho pode ser editado antes de abrir a sessão nova.',
      'Cancelar o rascunho não abre sessão.',
    ],
  },
  {
    source: 'd6fa3d2',
    milestone: 'M6',
    title: 'Perguntar e delegar',
    prompt:
      'Um agente pode pedir uma consulta só de leitura ou delegar uma subtarefa, ambas com cartão de aprovação.',
    acceptance: [
      'A consulta abre em modo de leitura, na pasta de quem perguntou.',
      'A delegação não começa antes do cartão ser aceite.',
    ],
  },
  {
    source: 'ca95a44',
    milestone: 'M7',
    title: 'Do pedido ao PR',
    prompt:
      'Abre uma sessão a partir de uma issue do GitHub, grava um commit com a mensagem escrita, abre o PR depois de confirmação e arquiva a sessão quando o PR entra.',
    acceptance: [
      'Escolher uma issue abre sessão com worktree, título e primeira mensagem com número, título e corpo cortado.',
      'O commit não faz merge nem push. O push só segue depois da confirmação nativa com repositório e branch.',
      'Ler a CI não escreve. Um PR merged arquiva a sessão. Não há ciclo de correção.',
    ],
  },
];

export const CORPUS: readonly Task[] = DRAFTS.map((draft, index) => ({
  id: `t${String(index + 1).padStart(2, '0')}`,
  ...draft,
}));

/**
 * Selo do texto congelado antes de qualquer medição.
 * Mudar um critério obriga a mudar este valor de propósito.
 */
export const FROZEN_SEAL = '6957e7e133bc689c0a33844de2e10dc6206d54ceb9cb5c7f95d1410d5eeb8e34';

/** Selo do texto. Não inclui FROZEN_SEAL. */
export function corpusSeal(tasks: readonly Task[] = CORPUS): string {
  const body = JSON.stringify(
    tasks.map((task) => ({
      id: task.id,
      source: task.source,
      milestone: task.milestone,
      title: task.title,
      prompt: task.prompt,
      acceptance: [...task.acceptance],
    })),
  );
  return createHash('sha256').update(body).digest('hex');
}
