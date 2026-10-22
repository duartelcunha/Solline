import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NavigationPreferences, NavigationUpdate, defaultNavigation } from '@solline/protocol';

/** Public UI preferences only: identifiers and startup choice, never content or credentials. */
export class NavigationPreferencesStore {
  #state = defaultNavigation();
  #loaded?: Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  async read(): Promise<NavigationPreferences> {
    this.#loaded ??= this.#load();
    await this.#loaded;
    await this.#tail;
    return structuredClone(this.#state);
  }

  async #load(): Promise<void> {
    try {
      const bytes = await readFile(this.file, 'utf8');
      this.#state = NavigationPreferences.parse(JSON.parse(bytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async update(raw: NavigationUpdate): Promise<NavigationPreferences> {
    const patch = NavigationUpdate.parse(raw);
    this.#loaded ??= this.#load();
    await this.#loaded;
    const operation = this.#tail.then(async () => {
      const next = NavigationPreferences.parse({ ...this.#state, ...patch });
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = this.file + '.next';
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      this.#state = next;
      return structuredClone(next);
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}
