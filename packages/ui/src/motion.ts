/**
 * Motion system da Solline: os mesmos tokens do motion.css, uma mola interruptível e as
 * regras de quando animar. Sem React e sem DOM obrigatório, para se testar em Node.
 *
 * Regras (valem para toda a app):
 * 1. Nada anima numa ação de teclado: o que se faz cem vezes por dia tem de ser instantâneo.
 * 2. Animações de interface abaixo de 300 ms. Entradas com ease-out, movimento no ecrã com
 *    in-out, e a saída sempre mais rápida do que a entrada.
 * 3. O que se arrasta ou se interrompe usa uma mola (parte do valor e da velocidade atuais).
 * 4. Com prefers-reduced-motion, o movimento passa a opacidade; a informação fica toda.
 * 5. Só transform e opacity. Nada entra a partir de scale(0).
 */

export const EASE = {
  /** Entradas e respostas: começa rápido, assenta devagar. */
  out: [0.23, 1, 0.32, 1],
  /** Algo que já está no ecrã e muda de sítio. */
  inOut: [0.77, 0, 0.175, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export const DURATION = {
  /** Feedback de premir. */
  press: 120,
  /** Saídas e pequenas mudanças (hover, cor). */
  exit: 140,
  fast: 160,
  /** Entradas normais. */
  base: 200,
  /** Painéis e o que percorre mais distância. */
  slow: 260,
} as const;

/** O teto das animações de interface. */
export const MAX_UI_DURATION = 300;

export function cssEase(curve: readonly [number, number, number, number]): string {
  return `cubic-bezier(${curve.join(', ')})`;
}

// --- Molas -------------------------------------------------------------------------------

/**
 * Parâmetros à maneira da Apple: dampingRatio 1 não passa do alvo; abaixo de 1 passa e
 * volta. response é o tempo (s) que a mola leva a chegar perto do alvo, não uma duração.
 */
export interface SpringParams {
  dampingRatio: number;
  response: number;
}

export const SPRING = {
  /** Por omissão: chega sem passar do alvo. */
  settle: { dampingRatio: 1, response: 0.32 },
  /** Depois de um gesto com velocidade (soltar um arrasto): um pouco de vida. */
  release: { dampingRatio: 0.82, response: 0.3 },
} as const satisfies Record<string, SpringParams>;

export interface SpringState {
  value: number;
  /** Unidades por segundo. */
  velocity: number;
}

/**
 * Um passo da mola (massa 1), em subpassos de 4 ms para ficar estável mesmo quando um
 * frame demora mais.
 */
export function stepSpring(
  state: SpringState,
  target: number,
  params: SpringParams,
  dtSeconds: number,
): SpringState {
  const stiffness = (2 * Math.PI) ** 2 / params.response ** 2;
  const damping = (4 * Math.PI * params.dampingRatio) / params.response;
  let { value, velocity } = state;
  let left = Math.min(dtSeconds, 0.064);
  while (left > 0) {
    const dt = Math.min(left, 0.004);
    const force = -stiffness * (value - target) - damping * velocity;
    velocity += force * dt;
    value += velocity * dt;
    left -= dt;
  }
  return { value, velocity };
}

export function isSettled(state: SpringState, target: number, precision = 0.1): boolean {
  return Math.abs(state.value - target) < precision && Math.abs(state.velocity) < precision * 10;
}

/** Onde um gesto ia parar, como o scroll: valor atual mais a projeção da velocidade. */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Resistência progressiva depois de um limite (em vez de uma parede). */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

type Frame = (callback: (time: number) => void) => number;
type CancelFrame = (handle: number) => void;

/**
 * Uma mola viva: to() muda o alvo a meio sem perder a velocidade, jump() salta sem animar
 * (teclado, movimento reduzido). onUpdate escreve no DOM direto, sem passar pelo React.
 */
export class Spring {
  #state: SpringState;
  #target: number;
  #params: SpringParams;
  #handle: number | null = null;
  #last: number | null = null;
  /** Quem recebe cada valor; pode mudar a meio (por exemplo a cada render do React). */
  onUpdate: (value: number) => void;
  readonly #onRest: (() => void) | undefined;
  readonly #frame: Frame;
  readonly #cancel: CancelFrame;

  constructor(options: {
    value: number;
    onUpdate: (value: number) => void;
    onRest?: () => void;
    params?: SpringParams;
    /** Para testes: o relógio dos frames. */
    frame?: Frame;
    cancelFrame?: CancelFrame;
  }) {
    this.#state = { value: options.value, velocity: 0 };
    this.#target = options.value;
    this.#params = options.params ?? SPRING.settle;
    this.onUpdate = options.onUpdate;
    this.#onRest = options.onRest;
    this.#frame = options.frame ?? ((cb) => requestAnimationFrame(cb));
    this.#cancel = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));
  }

  get value(): number {
    return this.#state.value;
  }

  get velocity(): number {
    return this.#state.velocity;
  }

  get target(): number {
    return this.#target;
  }

  get animating(): boolean {
    return this.#handle !== null;
  }

  /** Vai para o alvo a partir de onde está agora, com a velocidade que já tem (ou a dada). */
  to(target: number, options: { velocity?: number; params?: SpringParams } = {}): void {
    this.#target = target;
    if (options.velocity !== undefined) this.#state.velocity = options.velocity;
    if (options.params) this.#params = options.params;
    if (this.#handle === null) {
      this.#last = null;
      this.#handle = this.#frame(this.#tick);
    }
  }

  /** Salta para o valor sem animar e pára. */
  jump(value: number): void {
    this.stop();
    this.#state = { value, velocity: 0 };
    this.#target = value;
    this.onUpdate(value);
  }

  stop(): void {
    if (this.#handle !== null) this.#cancel(this.#handle);
    this.#handle = null;
    this.#last = null;
  }

  readonly #tick = (time: number): void => {
    const dt = this.#last === null ? 1 / 60 : (time - this.#last) / 1000;
    this.#last = time;
    this.#state = stepSpring(this.#state, this.#target, this.#params, dt);
    if (isSettled(this.#state, this.#target)) {
      this.#state = { value: this.#target, velocity: 0 };
      this.#handle = null;
      this.#last = null;
      this.onUpdate(this.#target);
      this.#onRest?.();
      return;
    }
    this.onUpdate(this.#state.value);
    this.#handle = this.#frame(this.#tick);
  };
}

// --- Quando animar -----------------------------------------------------------------------

/** O utilizador pediu menos movimento ao sistema. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Visible is not necessarily focused: a restored window may still be behind another app. */
export function isForeground(doc: Pick<Document, 'hidden' | 'hasFocus'> = document): boolean {
  return !doc.hidden && doc.hasFocus();
}

let lastInput: 'keyboard' | 'pointer' = 'pointer';

/**
 * Segue se a última ação foi de teclado ou de rato/toque e marca-o no <html>
 * (data-input). Liga-se uma vez no arranque da interface; devolve a função para desligar.
 */
export function trackInputModality(root: HTMLElement = document.documentElement): () => void {
  const keyboard = (event: KeyboardEvent) => {
    // Só teclas que fazem coisas; uma tecla modificadora sozinha não muda nada.
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    lastInput = 'keyboard';
    root.dataset.input = 'keyboard';
  };
  const pointer = () => {
    lastInput = 'pointer';
    root.dataset.input = 'pointer';
  };
  window.addEventListener('keydown', keyboard, true);
  window.addEventListener('pointerdown', pointer, true);
  return () => {
    window.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('pointerdown', pointer, true);
  };
}

/** A última ação foi de teclado: o que ela provocar aparece sem animar. */
export function lastInputWasKeyboard(): boolean {
  return lastInput === 'keyboard';
}

/**
 * Deve esta mudança animar? Não, se veio do teclado (um click com detail 0 também é
 * teclado: Enter ou espaço num botão). Com movimento reduzido anima, mas só em opacidade.
 */
export function shouldAnimate(event?: { detail?: number } | null): boolean {
  if (event && event.detail === 0) return false;
  return !lastInputWasKeyboard();
}

/**
 * Marca o <html> com data-ambient="paused" enquanto a janela está escondida ou sem foco: o
 * que se repete (os pontos de "a trabalhar", a fenda de "a ler") fica parado e não gasta
 * nada. Muda uma vez por evento, nunca por frame.
 */
export function trackAmbient(doc: Document = document, win: Window = window): () => void {
  const update = () => {
    const paused = !isForeground(doc);
    doc.documentElement.dataset.ambient = paused ? 'paused' : 'running';
  };
  update();
  doc.addEventListener('visibilitychange', update);
  win.addEventListener('focus', update);
  win.addEventListener('blur', update);
  return () => {
    doc.removeEventListener('visibilitychange', update);
    win.removeEventListener('focus', update);
    win.removeEventListener('blur', update);
  };
}
