import { expect, it } from 'vitest';
import { engineTimeout } from './engine-timeouts.ts';

it('a ponte espera pelo arranque e pela análise sem antecipar o prazo do motor', () => {
  expect(engineTimeout('spaces.dispatch')).toBeGreaterThanOrEqual(engineTimeout('session.start'));
  // The analyzer can spend 120 seconds on the provider, after context collection and detection.
  expect(engineTimeout('spaces.analyze')).toBeGreaterThanOrEqual(180_000);
  expect(engineTimeout('spaces.tick')).toBe(engineTimeout('spaces.analyze'));
  expect(engineTimeout('engine.ping')).toBe(5_000);
  expect(engineTimeout('session.send')).toBe(20_000);
});
