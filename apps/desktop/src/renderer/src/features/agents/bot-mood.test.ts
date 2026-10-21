import { describe, expect, it } from 'vitest';
import { DONE_MS, SLEEP_MS, hoodOf, moodOf, nextMoodChange } from './bot-mood.ts';

const at = (
  state: Parameters<typeof moodOf>[0]['state'],
  since = 0,
  ended: number | null = null,
) => ({
  state,
  stateSince: since,
  turnEndedAt: ended,
});

describe('o humor do bot', () => {
  it('segue o estado da sessão', () => {
    expect(moodOf(at('running'), 10)).toBe('working');
    expect(moodOf(at('starting'), 10)).toBe('working');
    expect(moodOf(at('needs-you'), 10)).toBe('needs-you');
    expect(moodOf(at('error'), 10)).toBe('crashed');
    expect(moodOf(at('idle'), 10)).toBe('waiting');
  });

  it('fica contente logo a seguir a um turno e volta à espera', () => {
    const idle = at('idle', 1_000, 1_000);
    expect(moodOf(idle, 1_000 + DONE_MS - 1)).toBe('done');
    expect(moodOf(idle, 1_000 + DONE_MS)).toBe('waiting');
    expect(nextMoodChange(idle, 1_100)).toBe(1_000 + DONE_MS);
  });

  it('adormece parado há muito tempo', () => {
    expect(moodOf(at('idle', 0), SLEEP_MS)).toBe('sleeping');
    expect(nextMoodChange(at('idle', 0), 5)).toBe(SLEEP_MS);
    expect(nextMoodChange(at('running', 0), 5)).toBeNull();
  });

  it('a cor do capuz vem do agente', () => {
    expect(hoodOf('claude')).toBe('claude');
    expect(hoodOf('codex')).toBe('codex');
    expect(hoodOf('opencode', 'acp')).toBe('acp');
    expect(hoodOf('outro', 'claude-sdk')).toBe('other');
  });
});
