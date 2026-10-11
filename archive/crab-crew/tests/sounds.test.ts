import { expect, test } from 'claude-code/testing'
import {
  CHIME_MIN_MS,
  SOUND_ASSETS,
  SOUND_KINDS,
  TAP_DEBOUNCE_MS,
  isApprovalNotification,
  isSoundKind,
  shouldChime,
  shouldTap,
} from '../hooks/crew/sounds'

const base = { session_id: 's', transcript_path: '/t', cwd: '/c' }

test('sound kinds and their assets', () => {
  expect([...SOUND_KINDS]).toEqual(['click', 'chime', 'tap'])
  expect(SOUND_ASSETS).toEqual({ click: 'assets/click.wav', chime: 'assets/chime.wav', tap: 'assets/tap.wav' })
  expect(isSoundKind('chime')).toBe(true)
  expect(isSoundKind('boom')).toBe(false)
  expect(isSoundKind(3)).toBe(false)
})

test('chime only at two minutes or more', () => {
  expect(CHIME_MIN_MS).toBe(120000)
  expect(shouldChime(119999)).toBe(false)
  expect(shouldChime(120000)).toBe(true)
  expect(shouldChime(600000)).toBe(true)
  expect(shouldChime(0)).toBe(false)
  expect(shouldChime(Number.NaN)).toBe(false)
  expect(shouldChime(Number.POSITIVE_INFINITY)).toBe(false)
})

test('PermissionRequest always means approval', () => {
  expect(isApprovalNotification({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} })).toBe(true)
})

test('Notification: permission / idle / elicitation types tap, others do not', () => {
  const n = (notification_type: string, message = 'x') => ({ ...base, hook_event_name: 'Notification', message, notification_type })
  expect(isApprovalNotification(n('permission_prompt'))).toBe(true)
  expect(isApprovalNotification(n('idle_prompt'))).toBe(true)
  expect(isApprovalNotification(n('elicitation_dialog'))).toBe(true)
  expect(isApprovalNotification(n('auth_success', 'Claude needs your permission'))).toBe(false)
  // no type: the message decides
  expect(isApprovalNotification(n('', 'Claude needs your permission to use Bash'))).toBe(true)
  expect(isApprovalNotification(n('', 'Claude is waiting for your input'))).toBe(true)
  expect(isApprovalNotification(n('', 'Build finished'))).toBe(false)
})

test('other events and junk never tap', () => {
  expect(isApprovalNotification({ ...base, hook_event_name: 'Stop' })).toBe(false)
  expect(isApprovalNotification(null)).toBe(false)
  expect(isApprovalNotification('PermissionRequest')).toBe(false)
  expect(isApprovalNotification({})).toBe(false)
})

test('one tap per approval: a second signal inside the window is skipped', () => {
  expect(TAP_DEBOUNCE_MS).toBe(1500)
  expect(shouldTap(null, 10_000)).toBe(true)
  expect(shouldTap(undefined, 10_000)).toBe(true)
  expect(shouldTap(10_000, 10_500)).toBe(false)
  expect(shouldTap(10_000, 11_499)).toBe(false)
  expect(shouldTap(10_000, 11_500)).toBe(true)
  expect(shouldTap(10_000, 10_100, 50)).toBe(true)
  // a clock that went back never silences taps for good
  expect(shouldTap(50_000, 1_000)).toBe(true)
})
