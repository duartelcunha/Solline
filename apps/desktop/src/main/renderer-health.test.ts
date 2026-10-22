import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RendererHealth } from './renderer-health';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const send = vi.fn();
  const failed = vi.fn();
  const recovered = vi.fn();
  const health = new RendererHealth(send, failed, recovered);
  return { health, send, failed, recovered };
}

it('reports an unanswered probe once at the deadline, without flooding a blocked renderer', () => {
  const { health, send, failed } = fixture();
  health.start();
  health.start();
  vi.advanceTimersByTime(7999);
  expect(failed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(failed).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(60_000);
  expect(send).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledOnce();
  health.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('accepts only the current token and a late reply recovers without an automatic action', () => {
  const { health, send, failed, recovered } = fixture();
  health.start();
  const token = send.mock.calls[0]?.[0];
  health.acknowledge('forged');
  health.acknowledge({ token });
  vi.advanceTimersByTime(8000);
  expect(failed).toHaveBeenCalledOnce();
  health.acknowledge(token);
  expect(recovered).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(2000);
  const second = send.mock.calls[1]?.[0];
  expect(second).not.toBe(token);
  health.acknowledge(token);
  vi.advanceTimersByTime(8000);
  expect(failed).toHaveBeenCalledTimes(2);
  health.stop();
});

it('healthy round trips cancel deadlines and stay bounded to one timer', () => {
  const { health, send, failed } = fixture();
  health.start();
  for (let i = 0; i < 20; i++) {
    health.acknowledge(send.mock.lastCall?.[0]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
  }
  expect(failed).not.toHaveBeenCalled();
  health.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('suspension/navigation invalidates old acknowledgements and leaves no timer', () => {
  const { health, send, failed, recovered } = fixture();
  health.start();
  const old = send.mock.lastCall?.[0];
  health.stop();
  health.acknowledge(old);
  vi.advanceTimersByTime(30_000);
  expect(failed).not.toHaveBeenCalled();
  expect(recovered).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  health.start();
  expect(send.mock.lastCall?.[0]).not.toBe(old);
  health.acknowledge(old);
  vi.advanceTimersByTime(8000);
  expect(failed).toHaveBeenCalledOnce();
  health.stop();
});

it('restarts a probe after system sleep/main-loop delay instead of blaming the renderer', () => {
  const { health, send, failed } = fixture();
  health.start();
  vi.setSystemTime(Date.now() + 60_000);
  vi.advanceTimersByTime(8000);
  expect(failed).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(2);
  health.stop();
});

it('cleans up when a destroyed target refuses delivery', () => {
  const { health, send, failed } = fixture();
  send.mockImplementation(() => {
    throw new Error('destroyed');
  });
  health.start();
  vi.advanceTimersByTime(30_000);
  expect(failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
