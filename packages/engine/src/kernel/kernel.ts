import {
  ModuleManifest as ModuleManifestSchema,
  type EngineCommandName,
  type EngineCommandPayload,
  type EngineCommandResult,
  type EngineEvent,
  type KernelHealthSnapshot,
  type ModuleHealth,
  type ModuleManifest,
  type ModuleState,
  type ResolvedModuleManifest,
} from '@solline/protocol';
import { CircuitRegistry } from './circuit-breaker.ts';
import {
  EngineEventBus,
  type EngineEventFilter,
  type EngineEventHandler,
} from './event-bus.ts';

export interface ServiceToken<T> {
  readonly id: string;
  readonly __type?: T;
}

export function createToken<T>(id: string): ServiceToken<T> {
  return { id };
}

export type EngineCommandHandler<C extends EngineCommandName = EngineCommandName> = (
  payload: EngineCommandPayload<C>,
) => Promise<EngineCommandResult<C>> | EngineCommandResult<C>;

export interface KernelContext {
  readonly circuits: CircuitRegistry;
  provide<T>(token: ServiceToken<T>, instance: T): void;
  inject<T>(token: ServiceToken<T>): T;
  tryInject<T>(token: ServiceToken<T>): T | undefined;
  emit(event: EngineEvent): void;
  on(filter: EngineEventFilter, handler: EngineEventHandler): () => void;
  registerCommand<C extends EngineCommandName>(
    name: C,
    handler: EngineCommandHandler<C>,
  ): void;
  markDegraded(error: unknown): void;
}

export interface KernelModule {
  readonly manifest: ModuleManifest;
  init(ctx: KernelContext): Promise<void> | void;
  start?(ctx: KernelContext): Promise<void> | void;
  dispose?(ctx: KernelContext): Promise<void> | void;
}

interface ModuleRecord {
  module: KernelModule;
  manifest: ResolvedModuleManifest;
  state: ModuleState;
  lastError: string | null;
  updatedAt: number;
  unsubscribers: (() => void)[];
  commands: EngineCommandName[];
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat || 'Erro desconhecido';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

/**
 * Microkernel interno do Solline: ordena módulos internos revistos por dependências, isola
 * subscritores e falhas não críticas, e expõe comandos e telemetria de saúde/circuit breakers.
 * Nunca carrega código externo nem plugins de runtime sem revisão em commit.
 */
export class EngineKernel {
  readonly bus: EngineEventBus;
  readonly circuits: CircuitRegistry;
  readonly #now: () => number;
  readonly #emitExternal: ((event: EngineEvent) => void) | undefined;
  readonly #modules = new Map<string, ModuleRecord>();
  readonly #services = new Map<string, unknown>();
  readonly #commands = new Map<EngineCommandName, { owner: string; handler: EngineCommandHandler }>();
  #order: string[] = [];

  constructor(options?: {
    bus?: EngineEventBus;
    circuits?: CircuitRegistry;
    emitExternal?: ((event: EngineEvent) => void) | undefined;
    now?: (() => number) | undefined;
  }) {
    this.#now = options?.now ?? Date.now;
    this.bus = options?.bus ?? new EngineEventBus();
    this.circuits = options?.circuits ?? new CircuitRegistry();
    this.#emitExternal = options?.emitExternal;
  }

  register(module: KernelModule): void {
    const manifest = ModuleManifestSchema.parse(module.manifest);
    if (this.#modules.has(manifest.id))
      throw new Error(`Módulo "${manifest.id}" já está registado`);
    this.#modules.set(manifest.id, {
      module,
      manifest,
      state: 'registered',
      lastError: null,
      updatedAt: this.#now(),
      unsubscribers: [],
      commands: [],
    });
  }

  /**
   * Corre `init` de todos os módulos de forma síncrona (para preservar o construtor síncrono do
   * `Engine`). Módulos com arranque assíncrono colocam esse trabalho em `start()`.
   */
  initSync(): void {
    this.#order = this.#resolveOrder();
    for (const id of this.#order) {
      const record = this.#requireRecord(id);
      if (record.state === 'disabled') continue;
      if (this.#hasFailedCriticalDep(record)) {
        this.#failNonCritical(record, new Error('Dependência indisponível'));
        continue;
      }
      try {
        const result = record.module.init(this.#contextFor(record));
        if (isThenable(result))
          throw new Error(`Módulo "${id}": init() devolveu uma Promise durante initSync()`);
        record.state = 'initialized';
        record.lastError = null;
        record.updatedAt = this.#now();
      } catch (error) {
        if (record.manifest.critical) {
          record.state = 'degraded';
          record.lastError = messageOf(error);
          record.updatedAt = this.#now();
          throw error;
        }
        this.#failNonCritical(record, error);
      }
    }
  }

  async init(): Promise<void> {
    this.#order = this.#resolveOrder();
    for (const id of this.#order) {
      const record = this.#requireRecord(id);
      if (record.state === 'disabled') continue;
      if (this.#hasFailedCriticalDep(record)) {
        this.#failNonCritical(record, new Error('Dependência indisponível'));
        continue;
      }
      try {
        await record.module.init(this.#contextFor(record));
        record.state = 'initialized';
        record.lastError = null;
        record.updatedAt = this.#now();
      } catch (error) {
        if (record.manifest.critical) {
          record.state = 'degraded';
          record.lastError = messageOf(error);
          record.updatedAt = this.#now();
          throw error;
        }
        this.#failNonCritical(record, error);
      }
    }
  }

  async start(): Promise<void> {
    if (this.#order.length === 0 && this.#modules.size > 0) this.#order = this.#resolveOrder();
    for (const id of this.#order) {
      const record = this.#requireRecord(id);
      if (record.state !== 'initialized') continue;
      try {
        await record.module.start?.(this.#contextFor(record));
        record.state = 'running';
        record.lastError = null;
        record.updatedAt = this.#now();
      } catch (error) {
        if (record.manifest.critical) {
          record.state = 'degraded';
          record.lastError = messageOf(error);
          record.updatedAt = this.#now();
          throw error;
        }
        this.#failNonCritical(record, error);
      }
    }
  }

  async boot(): Promise<void> {
    await this.init();
    await this.start();
  }

  async shutdown(): Promise<void> {
    const order =
      this.#order.length > 0 ? [...this.#order].reverse() : [...this.#modules.keys()].reverse();
    for (const id of order) {
      const record = this.#modules.get(id);
      if (!record) continue;
      if (record.state === 'initialized' || record.state === 'running' || record.state === 'degraded') {
        try {
          await record.module.dispose?.(this.#contextFor(record));
        } catch {
          // Todo o módulo tem direito a tentar fechar mesmo que um falhe.
        }
      }
      this.#cleanupSubscriptions(record);
      if (record.state !== 'disabled') {
        record.state = 'stopped';
        record.updatedAt = this.#now();
      }
    }
  }

  async setModuleEnabled(id: string, enabled: boolean): Promise<ModuleHealth> {
    const record = this.#modules.get(id);
    if (!record) throw new Error(`Módulo desconhecido: ${id}`);
    if (record.manifest.critical || !record.manifest.toggleable)
      throw new Error(`O módulo "${id}" é essencial e não pode ser desligado`);
    if (!enabled) {
      if (record.state !== 'disabled') {
        try {
          await record.module.dispose?.(this.#contextFor(record));
        } catch (error) {
          record.lastError = messageOf(error);
        }
        this.#cleanupScope(record);
        record.state = 'disabled';
        record.updatedAt = this.#now();
      }
      return this.#healthOf(record);
    }
    if (record.state === 'disabled') {
      if (this.#hasFailedCriticalDep(record)) {
        this.#failNonCritical(record, new Error('Dependência indisponível'));
        return this.#healthOf(record);
      }
      try {
        await record.module.init(this.#contextFor(record));
        record.state = 'initialized';
        await record.module.start?.(this.#contextFor(record));
        record.state = 'running';
        record.lastError = null;
      } catch (error) {
        this.#failNonCritical(record, error);
      }
      record.updatedAt = this.#now();
    }
    return this.#healthOf(record);
  }

  markDegraded(id: string, error: unknown): void {
    const record = this.#modules.get(id);
    if (!record || record.state === 'stopped' || record.state === 'disabled') return;
    record.state = 'degraded';
    record.lastError = messageOf(error);
    record.updatedAt = this.#now();
  }

  inject<T>(token: ServiceToken<T>): T {
    if (!this.#services.has(token.id))
      throw new Error(`Serviço em falta no kernel: ${token.id}`);
    return this.#services.get(token.id) as T;
  }

  tryInject<T>(token: ServiceToken<T>): T | undefined {
    return this.#services.get(token.id) as T | undefined;
  }

  hasCommand(name: EngineCommandName): boolean {
    return this.#commands.has(name);
  }

  getCommand<C extends EngineCommandName>(name: C): EngineCommandHandler<C> | undefined {
    const entry = this.#commands.get(name);
    if (!entry) return undefined;
    const record = this.#modules.get(entry.owner);
    if (record?.state === 'disabled' || record?.state === 'degraded') return undefined;
    return entry.handler as EngineCommandHandler<C>;
  }

  moduleHealth(id: string): ModuleHealth | undefined {
    const record = this.#modules.get(id);
    return record ? this.#healthOf(record) : undefined;
  }

  health(): KernelHealthSnapshot {
    return {
      modules: [...this.#modules.values()].map((record) => this.#healthOf(record)),
      circuits: this.circuits.snapshots(),
    };
  }

  #healthOf(record: ModuleRecord): ModuleHealth {
    return {
      id: record.manifest.id,
      version: record.manifest.version,
      state: record.state,
      critical: record.manifest.critical,
      toggleable: record.manifest.toggleable,
      lastError: record.lastError,
      updatedAt: record.updatedAt,
    };
  }

  #requireRecord(id: string): ModuleRecord {
    const record = this.#modules.get(id);
    if (!record) throw new Error(`Módulo desconhecido: ${id}`);
    return record;
  }

  #hasFailedCriticalDep(record: ModuleRecord): boolean {
    if (record.manifest.critical) return false;
    return record.manifest.dependsOn.some((depId) => {
      const dep = this.#modules.get(depId);
      return !dep || dep.state === 'degraded' || dep.state === 'disabled' || dep.state === 'stopped';
    });
  }

  #failNonCritical(record: ModuleRecord, error: unknown): void {
    this.#cleanupScope(record);
    record.state = 'degraded';
    record.lastError = messageOf(error);
    record.updatedAt = this.#now();
  }

  #cleanupSubscriptions(record: ModuleRecord): void {
    for (const unsubscribe of record.unsubscribers) unsubscribe();
    record.unsubscribers.length = 0;
  }

  #cleanupScope(record: ModuleRecord): void {
    this.#cleanupSubscriptions(record);
    for (const command of record.commands) {
      if (this.#commands.get(command)?.owner === record.manifest.id)
        this.#commands.delete(command);
    }
    record.commands.length = 0;
  }

  #contextFor(record: ModuleRecord): KernelContext {
    return {
      circuits: this.circuits,
      provide: (token, instance) => {
        this.#services.set(token.id, instance);
      },
      inject: (token) => this.inject(token),
      tryInject: (token) => this.tryInject(token),
      emit: (event) => {
        if (this.#emitExternal) this.#emitExternal(event);
        else this.bus.emit(event);
      },
      on: (filter, handler) => {
        const off = this.bus.on(filter, (event) => {
          try {
            handler(event);
          } catch (error) {
            if (!record.manifest.critical) this.markDegraded(record.manifest.id, error);
            else throw error;
          }
        });
        record.unsubscribers.push(off);
        return off;
      },
      registerCommand: (name, handler) => {
        if (this.#commands.has(name))
          throw new Error(`Comando "${name}" já registado por "${this.#commands.get(name)?.owner}"`);
        if (record.manifest.commands.length > 0 && !record.manifest.commands.includes(name))
          throw new Error(`Comando "${name}" não declarado no manifesto de "${record.manifest.id}"`);
        this.#commands.set(name, { owner: record.manifest.id, handler: handler as EngineCommandHandler });
        record.commands.push(name);
      },
      markDegraded: (error) => this.markDegraded(record.manifest.id, error),
    };
  }

  #resolveOrder(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Ciclo de dependências entre módulos em "${id}"`);
      const record = this.#modules.get(id);
      if (!record) throw new Error(`Dependência de módulo desconhecida: ${id}`);
      visiting.add(id);
      for (const dep of record.manifest.dependsOn) {
        if (!this.#modules.has(dep))
          throw new Error(`Módulo "${id}" depende de "${dep}", que não está registado`);
        visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
      sorted.push(id);
    };

    for (const id of this.#modules.keys()) visit(id);
    return sorted;
  }
}
