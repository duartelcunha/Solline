/**
 * The crew's pure decisions (hooks/crew/orchestrator.ts): the plan-mode model
 * switch, the status of an Agent call, a subagent's turn and a ToolUse row, and
 * the labels.
 */
import { expect, test } from 'claude-code/testing'
import {
  FABLE_MISSING_TOAST,
  STATUS_LABEL,
  agentCallStatus,
  agentResultModel,
  entersPlan,
  modelLabel,
  offersFable,
  oneLine,
  outputModel,
  planTarget,
  roleLabel,
  rowStatus,
  switchToast,
  toolOk,
  turnEndStatus,
} from '../hooks/crew/orchestrator'

test('planTarget: entering goes to Fable when the model row offers it (or lists nothing), else Opus with the fallback flag', () => {
  expect(planTarget('enter', ['default', 'haiku', 'sonnet', 'opus', 'fable'])).toEqual({ model: 'fable', fallback: false })
  expect(planTarget('enter', ['claude-fable-5-1', 'opus'])).toEqual({ model: 'fable', fallback: false })
  expect(planTarget('enter', ['default', 'haiku', 'sonnet', 'opus'])).toEqual({ model: 'opus', fallback: true })
  expect(planTarget('enter', [])).toEqual({ model: 'fable', fallback: false })
  expect(planTarget('enter', undefined)).toEqual({ model: 'fable', fallback: false })
  expect(planTarget('enter', null)).toEqual({ model: 'fable', fallback: false })
  // an approved plan always lands on Opus
  expect(planTarget('exit', ['fable'])).toEqual({ model: 'opus', fallback: false })
  expect(planTarget('exit', ['haiku'])).toEqual({ model: 'opus', fallback: false })
  expect(offersFable(['sonnet'])).toBe(false)
  expect(FABLE_MISSING_TOAST).toContain('Opus')
})

test('entersPlan: only the move into plan mode counts', () => {
  expect(entersPlan(null, true)).toBe(true)
  expect(entersPlan(false, true)).toBe(true)
  expect(entersPlan(true, true)).toBe(false)
  expect(entersPlan(true, false)).toBe(false)
  expect(entersPlan(null, false)).toBe(false)
})

test('switchToast reads "Fable → Opus"', () => {
  expect(switchToast('fable', 'opus')).toBe('Fable → Opus')
  expect(switchToast('sonnet', 'fable')).toBe('Sonnet → Fable')
  expect(switchToast(null, 'opus')).toBe('→ Opus')
  expect(switchToast('opus', 'opus')).toBe('→ Opus')
})

test('agentCallStatus: deny and errors end it, an interrupt text is interrupted, a background launch keeps it working', () => {
  expect(agentCallStatus({ deny: 'no' })).toBe('error')
  expect(agentCallStatus({ result: {}, text: 'boom', isError: true })).toBe('error')
  expect(agentCallStatus({ result: {}, text: 'Interrupted by user', isError: true })).toBe('interrupted')
  expect(agentCallStatus({ result: {}, text: 'request was aborted', isError: true })).toBe('interrupted')
  expect(agentCallStatus({ result: { status: 'async_launched', agentId: 'a1' }, text: '' })).toBeNull()
  expect(agentCallStatus({ result: { agentId: 'a1', content: [] }, text: 'ok' })).toBe('done')
  expect(agentCallStatus(null)).toBe('error')
  expect(agentCallStatus('x')).toBe('error')
})

test('the model an Agent result or a stored output names', () => {
  expect(agentResultModel({ result: { resolvedModel: 'claude-haiku-5-5' } })).toBe('claude-haiku-5-5')
  expect(agentResultModel({ result: { resolvedModel: ' ' } })).toBeNull()
  expect(agentResultModel({ deny: 'x' })).toBeNull()
  expect(outputModel({ resolvedModel: 'claude-sonnet-5-5' })).toBe('claude-sonnet-5-5')
  expect(outputModel(undefined)).toBeNull()
  expect(outputModel('text')).toBeNull()
})

test('toolOk: no deny and no error', () => {
  expect(toolOk({ result: {}, text: 'ok' })).toBe(true)
  expect(toolOk({ result: {}, text: 'rejected', isError: true })).toBe(false)
  expect(toolOk({ deny: 'policy' })).toBe(false)
  expect(toolOk(undefined)).toBe(false)
})

test('turnEndStatus and rowStatus', () => {
  expect(turnEndStatus({ isAborted: true, reason: 'aborted' })).toBe('interrupted')
  expect(turnEndStatus({ isAborted: false, reason: 'error' })).toBe('error')
  expect(turnEndStatus({ isAborted: false, reason: 'refusal' })).toBe('error')
  expect(turnEndStatus({ isAborted: false, reason: 'completed' })).toBe('done')
  const p = (isRunning: boolean, isErrored = false, isInterrupted = false) => ({ isRunning, isErrored, isInterrupted })
  expect(rowStatus(null, p(true))).toBe('working')
  expect(rowStatus(null, p(false))).toBe('done')
  // a background agent: the row stopped running, the crew still has it working
  expect(rowStatus('working', p(false))).toBe('working')
  expect(rowStatus('done', p(false, true))).toBe('error')
  expect(rowStatus('working', p(false, false, true))).toBe('interrupted')
  expect(STATUS_LABEL).toEqual({ working: 'a trabalhar', done: 'feito', error: 'erro', interrupted: 'interrompido' })
})

test('labels: model names by family, roles or the capped type, one-line descriptions', () => {
  expect(modelLabel('haiku')).toBe('Haiku')
  expect(modelLabel('claude-opus-5-5')).toBe('Opus')
  expect(modelLabel('')).toBe('…')
  expect(modelLabel('some-very-long-custom-model-id')).toHaveLength(18)
  expect(roleLabel('Explorer', 'Explore')).toBe('Explorer')
  expect(roleLabel(null, 'my-agent')).toBe('my-agent')
  expect(roleLabel(null, '  ')).toBe('agent')
  expect(oneLine('a\n\tb   c')).toBe('a b c')
  expect(oneLine('x'.repeat(100))).toHaveLength(80)
  expect(oneLine(42)).toBe('')
})
