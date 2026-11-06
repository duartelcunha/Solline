import { createHash } from 'node:crypto';

/**
 * Tarefas reais do repositório, pela ordem em que entraram. O índice módulo 3 igual a 2 é
 * avaliação; o resto é afinação. A divisão fica congelada antes de qualquer medição.
 */
export type Split = 'tuning' | 'eval';

export interface Task {
  id: string;
  /** Commit curto que entregou a tarefa. */
  source: string;
  milestone: string;
  split: Split;
  title: string;
  /** O pedido, como se fosse para refazer a partir do pai desse commit. */
  prompt: string;
  acceptance: readonly string[];
}

interface Draft {
  source: string;
  milestone: string;
  title: string;
  prompt: string;
  acceptance: readonly string[];
}

export function splitFor(index: number): Split {
  return index % 3 === 2 ? 'eval' : 'tuning';
}

const DRAFTS: readonly Draft[] = [
  {
    source: '5977972',
    milestone: 'M0',
    title: 'Contrato tipado da ponte',
    prompt:
      'Define a ponte entre o motor e a interface com payloads validados, sem a interface falar com o SDK.',
    acceptance: ['Cada comando tem payload e resultado validados.', 'Um campo a mais é recusado.'],
  },
  {
    source: '355c6e6',
    milestone: 'M0',
    title: 'Motor com ping',
    prompt: 'O motor responde a um ping e a verificação do SDK corre em streaming-input.',
    acceptance: [
      'O ping devolve a versão do motor.',
      'A verificação do SDK não bloqueia o arranque à espera do processo inteiro.',
    ],
  },
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
    source: '4eb9f42',
    milestone: 'M1',
    title: 'Contrato de conversa neutro',
    prompt:
      'Normaliza a conversa para blocos que qualquer agente possa encher, sem tipos do SDK na interface.',
    acceptance: [
      'Texto, ferramenta, permissão, plano e pergunta cabem no mesmo contrato.',
      'A interface não importa o SDK para ler um turno.',
    ],
  },
  {
    source: '6abd2b3',
    milestone: 'M1',
    title: 'Adaptador do Claude',
    prompt: 'Liga o Claude pelo SDK, com permissionMode explícito e o ambiente saneado.',
    acceptance: [
      'A sessão passa permissionMode e não usa bypass.',
      'O ambiente da sessão não herda variáveis de uma sessão anfitriã do Claude Code.',
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
    source: 'c2d336e',
    milestone: 'M1',
    title: 'IPC, CSP e fuses',
    prompt:
      'Aceita IPC só da janela principal, nega permissões do browser e desliga runAsNode, NODE_OPTIONS e inspect no build.',
    acceptance: [
      'Um frame que não seja a janela principal não manda comandos.',
      'O build desliga runAsNode, NODE_OPTIONS e inspect.',
    ],
  },
  {
    source: '07f8c58',
    milestone: 'M1',
    title: 'Projeto sem confiança',
    prompt: 'Num projeto sem confiança, o Claude só lê as definições do utilizador.',
    acceptance: [
      'Sem confiança, settingSources fica só com user.',
      'A pasta do projeto não entra como fonte de definições.',
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
    source: '6118a97',
    milestone: 'M1',
    title: 'Codex pelo app-server',
    prompt:
      'Liga o Codex pelo app-server, com tipos gerados da versão revista, e não por uma chave de API.',
    acceptance: [
      'A sessão do Codex abre pelo app-server.',
      'Não há campo para colar uma chave de API.',
    ],
  },
  {
    source: '1a5d100',
    milestone: 'M1',
    title: 'ACP e OpenCode',
    prompt: 'Acrescenta um adaptador ACP genérico e o OpenCode no catálogo, na versão revista.',
    acceptance: [
      'Um agente fora da versão revista não fica pronto.',
      'Não há forma na interface de apontar um executável à mão.',
    ],
  },
  {
    source: 'daba860',
    milestone: 'M1',
    title: 'Servidores MCP por sessão',
    prompt:
      'Permite ligar servidores MCP revistos a uma sessão, sem a interface inventar o comando.',
    acceptance: [
      'A sessão recebe a lista de servidores que o motor aprovou.',
      'Um servidor que executa código não ganha permissão automática.',
    ],
  },
  {
    source: 'acc1f11',
    milestone: 'M1',
    title: 'Sem agentes só com chave',
    prompt:
      'Tira os perfis que só entram com chave de API. Ficam os agentes com login pela subscrição.',
    acceptance: [
      'DeepSeek, GLM e Kimi deixam de ser perfis de arranque.',
      'A Solline não lê nem guarda tokens de login.',
    ],
  },
  {
    source: '133243e',
    milestone: 'M1',
    title: 'Entrar com ChatGPT',
    prompt:
      'O login do Codex faz-se pelo próprio agente, dentro da app, e as variáveis escolhidas não saem do motor.',
    acceptance: [
      'Há um gesto de login que o agente conduz.',
      'A interface vê nomes de variáveis, nunca os valores.',
    ],
  },
  {
    source: '66c33d2',
    milestone: 'M2',
    title: 'Checkpoint por turno',
    prompt:
      'Guarda um checkpoint escondido em cada turno e permite rever hunks e rebobinar ficheiros.',
    acceptance: [
      'Cada turno que muda ficheiros fica com um checkpoint, mesmo que o agente não saiba rebobinar.',
      'Rebobinar os ficheiros volta a esse checkpoint.',
    ],
  },
  {
    source: '8bd9dee',
    milestone: 'M2',
    title: 'Painel de diff e linha do tempo',
    prompt: 'Mostra o diff hunk a hunk e uma linha do tempo que rebobina.',
    acceptance: [
      'Dá para aceitar, rejeitar ou comentar um hunk.',
      'Arrastar a linha do tempo escolhe o turno sem saltar a conversa sozinho.',
    ],
  },
  {
    source: '78d0c55',
    milestone: 'M2',
    title: 'Git pelo caminho absoluto',
    prompt:
      'Todas as chamadas git do motor usam o executável resolvido, nunca um git solto da pasta.',
    acceptance: [
      'resolveGit() devolve um caminho absoluto ou null.',
      'Se a resolução falha, a operação não chama git pelo nome.',
    ],
  },
  {
    source: '4b770d2',
    milestone: 'M2',
    title: 'Segunda opinião no fim do turno',
    prompt:
      'No fim de um turno que muda ficheiros, um revisor só de leitura deixa achados presos às linhas.',
    acceptance: [
      'O revisor não escreve no projeto.',
      'Cada achado tem caminho, gravidade e uma frase.',
    ],
  },
  {
    source: '766de82',
    milestone: 'M3',
    title: 'Verificações do projeto',
    prompt:
      'No fim de um turno que muda ficheiros, corre as verificações do projeto se ele for de confiança.',
    acceptance: [
      'Sem confiança, nenhum comando de verificação corre.',
      'Uma falha mostra o fim da saída e não se manda ao agente sozinha.',
    ],
  },
  {
    source: 'ab20ca8',
    milestone: 'M3',
    title: 'Worktree por sessão a mais',
    prompt: 'A segunda sessão de um projeto git ganha worktree e branch próprios.',
    acceptance: [
      'A primeira sessão pode ficar na pasta do projeto.',
      'A sessão seguinte trabalha numa worktree, com branch solline/.',
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
    source: '6e1742a',
    milestone: 'M3',
    title: 'Fila e guiar',
    prompt:
      'Permite escrever com o agente a trabalhar: Enter põe na fila e, nos agentes que aceitam, Ctrl+Enter guia o turno.',
    acceptance: [
      'Uma mensagem durante o turno entra na fila e não corta o turno.',
      'Guiar agora só aparece quando o agente declara essa capacidade.',
    ],
  },
  {
    source: '4ca9475',
    milestone: 'M3',
    title: 'Preparar a worktree e as portas',
    prompt:
      'Prepara cada worktree com um comando aprovado uma vez e reserva um bloco de portas à sessão.',
    acceptance: [
      'O comando de preparação não corre antes da aprovação.',
      'Cada sessão recebe um bloco de portas livres, visíveis nas variáveis da verificação.',
    ],
  },
  {
    source: '27fc37c',
    milestone: 'M4',
    title: 'Verificador e juiz cego',
    prompt:
      'Separa as pistas pela execução das verificações e só chama um juiz cego quando ficam empatadas.',
    acceptance: [
      'O juiz não vê o nome do agente nem o texto que ele disse de si.',
      'Se as duas ordens do juiz discordam, a decisão volta à pessoa.',
    ],
  },
  {
    source: '0841fbe',
    milestone: 'M4',
    title: 'Corridas no motor',
    prompt: 'Abre de duas a quatro pistas do mesmo pedido, cada uma na sua worktree.',
    acceptance: [
      'Menos de duas ou mais de quatro pistas é recusado.',
      'Uma pista não escreve na worktree de outra.',
    ],
  },
  {
    source: 'e90c140',
    milestone: 'M4',
    title: 'Vista da corrida',
    prompt: 'Mostra as pistas lado a lado, com o pedido num só sítio.',
    acceptance: ['As pistas vêem-se ao mesmo tempo.', 'O pedido não é reescrito em cada pista.'],
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
    source: '3bc49db',
    milestone: 'M4',
    title: 'Montar hunk a hunk',
    prompt:
      'Deixa escolher hunks de várias pistas e montar um resultado, sem ficar com uma tentativa inteira por omissão.',
    acceptance: [
      'Dá para escolher hunks de pistas diferentes.',
      'Montar não faz push nem merge para o branch principal.',
    ],
  },
  {
    source: 'db90059',
    milestone: 'M4.5',
    title: 'Planeador da repartição',
    prompt:
      'Parte um pedido grande só quando as partes não se tocam, e o planeador pode dizer para não partir.',
    acceptance: [
      'O planeador é só de leitura.',
      'Um plano com partes que se tocam não lança tudo em paralelo.',
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
    source: 'c5cd4b1',
    milestone: 'M4.5',
    title: 'Integrar as partes',
    prompt: 'Junta as partes uma a uma e corre o verificador depois de cada junção.',
    acceptance: [
      'A integração é em série, não tudo ao mesmo tempo.',
      'Um conflito abre uma sessão normal para o resolver, sem fundir à força.',
    ],
  },
  {
    source: '7717cbe',
    milestone: 'M5',
    title: 'Segunda opinião de outro fabricante',
    prompt: 'Pede a revisão do diff a um agente de outro fabricante, a pedido e antes de trazer.',
    acceptance: [
      'O revisor por omissão não é o mesmo fabricante do autor, quando há outro disponível.',
      'Os achados trazem prioridade e confiança, e corrigir um é um gesto explícito.',
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
    source: 'c82e85d',
    milestone: 'M5',
    title: 'Bifurcar de um turno',
    prompt:
      'Abre uma sessão nova a partir do fim de um turno, na worktree dela, sem mexer na sessão de origem.',
    acceptance: [
      'A sessão de origem fica no mesmo sítio.',
      'Sem checkpoint nesse turno, a bifurcação falha e não abre sessão.',
    ],
  },
  {
    source: '852abe3',
    milestone: 'M5',
    title: 'Mapa da linhagem',
    prompt: 'Mostra que sessão nasceu de qual, e de que checkpoint.',
    acceptance: [
      'Uma passagem e uma bifurcação aparecem ligadas à origem.',
      'O mapa não escreve no projeto.',
    ],
  },
  {
    source: 'd600d31',
    milestone: 'M6',
    title: 'Servidor MCP da Solline',
    prompt:
      'Expõe as ferramentas da Solline aos agentes por um servidor MCP do motor, com um hello antes de aceitar o resto.',
    acceptance: [
      'Antes do hello autenticado, o canal não aceita um pedido de ferramenta.',
      'O servidor corre no motor, não num processo com os segredos na linha de comando.',
    ],
  },
  {
    source: 'aaee58a',
    milestone: 'M6',
    title: 'Regras escritas uma vez',
    prompt:
      'Guarda regras gerais e por projeto no estado da Solline e entrega-as a cada agente, sem as escrever na pasta.',
    acceptance: [
      'A mesma regra chega ao Claude e ao Codex.',
      'Gravar uma regra não cria CLAUDE.md nem AGENTS.md no projeto.',
    ],
  },
  {
    source: 'e75edf6',
    milestone: 'M6',
    title: 'Memória com prova',
    prompt: 'Uma memória nova fica pendente até ser aprovada, com a prova de onde veio.',
    acceptance: [
      'Sem aprovação, a memória não entra no índice que os agentes recebem.',
      'A prova continua visível no momento de aprovar.',
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
    source: '8c75748',
    milestone: 'M6',
    title: 'Catálogo MCP global',
    prompt:
      'O catálogo MCP é global, com aprovação do spec exato, impressão das ferramentas e segredos no cofre.',
    acceptance: [
      'Mudar o spec aprovado pede nova aprovação.',
      'Um segredo não aparece na linha de comando nem na impressão.',
    ],
  },
  {
    source: '9a85f61',
    milestone: 'M6',
    title: 'Regras nativas e consulta fechada',
    prompt:
      'Fecha as regras nativas, tira o Bash às consultas do Claude e impede uma consulta de passar o testemunho.',
    acceptance: [
      'As sessões não carregam CLAUDE.md nem AGENTS.md.',
      'Uma consulta não passa o testemunho e o Bash está nas ferramentas recusadas.',
      'Aprovar várias memórias de uma vez falha se alguma for externa.',
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
  split: splitFor(index),
  ...draft,
}));

/**
 * Selo do texto congelado em 2026-11-06, antes de qualquer medição.
 * Mudar um critério obriga a mudar este valor de propósito.
 */
export const FROZEN_SEAL = '986cf8c93c32a205740141f05aae9a07f91c58f8cd4853f181673c3bdb6136df';

/** Selo do texto. Não inclui FROZEN_SEAL. */
export function corpusSeal(tasks: readonly Task[] = CORPUS): string {
  const body = JSON.stringify(
    tasks.map((task) => ({
      id: task.id,
      source: task.source,
      milestone: task.milestone,
      split: task.split,
      title: task.title,
      prompt: task.prompt,
      acceptance: [...task.acceptance],
    })),
  );
  return createHash('sha256').update(body).digest('hex');
}
