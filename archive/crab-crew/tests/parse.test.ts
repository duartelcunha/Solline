import { expect, test } from 'claude-code/testing'
import { EFFORTS, effortIndex, familyOf, parseNextStep } from '../hooks/card/parse'

const FOOTER = [
  '**Próximo passo**',
  '- **Tarefa**: barra de uso',
  '- **Modelo**: Opus 5.5',
  '- **Effort**: high',
  '- **Modo**: auto mode',
].join('\n')

const BODY = 'Feito. A barra já mostra o uso.\n\nResumo:\n- ponto um\n- ponto dois'

function footer(f: { task?: string; model?: string; effort?: string; mode?: string; head?: string }): string {
  return [
    f.head ?? '**Próximo passo**',
    `- **Tarefa**: ${f.task ?? 'barra de uso'}`,
    `- **Modelo**: ${f.model ?? 'Opus 5.5'}`,
    `- **Effort**: ${f.effort ?? 'high'}`,
    `- **Modo**: ${f.mode ?? 'auto mode'}`,
  ].join('\n')
}

test('the exact footer parses, body is the text before it', () => {
  const r = parseNextStep(`${BODY}\n\n${FOOTER}`)
  expect(r).toEqual({
    step: { task: 'barra de uso', model: 'opus', modelLabel: 'Opus 5.5', effort: 'high', mode: 'auto' },
    body: BODY,
  })
})

test('a footer-only message has an empty body', () => {
  expect(parseNextStep(FOOTER)?.body).toBe('')
})

test('trailing whitespace after the footer and CRLF line endings are fine', () => {
  const r = parseNextStep(`${BODY}\r\n\r\n${FOOTER.replace(/\n/g, '\r\n')}\r\n\n  \n`)
  expect(r?.step.mode).toBe('auto')
  expect(r?.body).toBe(BODY) // lines are rejoined with \n
})

test('body trailing whitespace is trimmed', () => {
  expect(parseNextStep(`texto   \n\n\n${FOOTER}`)?.body).toBe('texto')
})

test('no bold, English labels, heading variants', () => {
  const text = ['## Next step:', '* Task: ship it', '* Model: sonnet', '* Effort: low', '* Mode: plan mode'].join('\n')
  expect(parseNextStep(`x\n${text}`)?.step).toEqual({
    task: 'ship it',
    model: 'sonnet',
    modelLabel: 'sonnet',
    effort: 'low',
    mode: 'plan',
  })
})

test('colon inside the bold, numbered list, extra spaces, case-insensitive labels', () => {
  const text = [
    '**PRÓXIMO PASSO**',
    '1.   **TAREFA:**   rever o parser  ',
    '2. **modelo:** HAIKU',
    '3. **Esforço:**  MAX ',
    '4. **modo:**   Default',
  ].join('\n')
  expect(parseNextStep(text)?.step).toEqual({
    task: 'rever o parser',
    model: 'haiku',
    modelLabel: 'HAIKU',
    effort: 'max',
    mode: 'default',
  })
})

test('unaccented heading and label, fields in any order, blank lines between', () => {
  const text = ['Proximo passo', '', '- Modo: plan', '- Esforco: medium', '', '- Modelo: Fable 5.1', '- Tarefa: x'].join('\n')
  expect(parseNextStep(text)?.step).toEqual({ task: 'x', model: 'fable', modelLabel: 'Fable 5.1', effort: 'medium', mode: 'plan' })
})

test('the task may itself contain a colon', () => {
  expect(parseNextStep(footer({ task: 'fix: cache de sessões' }))?.step.task).toBe('fix: cache de sessões')
})

test('every mode spelling', () => {
  const cases: Array<[string, string]> = [
    ['plan mode', 'plan'],
    ['plan', 'plan'],
    ['Plan Mode', 'plan'],
    ['`plan mode`', 'plan'],
    ['auto mode', 'auto'],
    ['auto', 'auto'],
    ['default', 'default'],
    ['default mode', 'default'],
    ['accept edits', 'acceptEdits'],
    ['acceptEdits', 'acceptEdits'],
    ['accept-edits', 'acceptEdits'],
    ['Accept Edits mode', 'acceptEdits'],
    ['modo plan', 'plan'],
    // the visible names (Plan, Auto, Ask, Edits), any case, with or without "mode"
    ['Plan', 'plan'],
    ['Auto', 'auto'],
    ['AUTO MODE', 'auto'],
    ['Ask', 'default'],
    ['ask', 'default'],
    ['Ask mode', 'default'],
    ['ASK', 'default'],
    ['modo Ask', 'default'],
    ['Edits', 'acceptEdits'],
    ['edits', 'acceptEdits'],
    ['Edits mode', 'acceptEdits'],
    ['**Edits**', 'acceptEdits'],
    ['`edits mode`', 'acceptEdits'],
  ]
  for (const [spelling, mode] of cases) {
    expect(parseNextStep(footer({ mode: spelling }))?.step.mode).toBe(mode)
  }
})

test('every effort, plus spellings of xhigh', () => {
  for (const e of EFFORTS) expect(parseNextStep(footer({ effort: e }))?.step.effort).toBe(e)
  for (const s of ['x-high', 'X High', 'XHIGH', 'extra high']) {
    expect(parseNextStep(footer({ effort: s }))?.step.effort).toBe('xhigh')
  }
})

test('every model by name, version optional', () => {
  const cases: Array<[string, string]> = [
    ['Fable 5.1', 'fable'],
    ['Opus 5.5', 'opus'],
    ['Sonnet 5.5', 'sonnet'],
    ['Haiku 5.5', 'haiku'],
    ['Opus', 'opus'],
    ['claude-sonnet-5-5', 'sonnet'],
  ]
  for (const [label, fam] of cases) {
    const r = parseNextStep(footer({ model: label }))
    expect(r?.step.model).toBe(fam)
    expect(r?.step.modelLabel).toBe(label)
  }
})

test('no footer -> null', () => {
  expect(parseNextStep('')).toBeNull()
  expect(parseNextStep(BODY)).toBeNull()
  expect(parseNextStep('- **Tarefa**: x\n- **Modelo**: Opus\n- **Effort**: high\n- **Modo**: plan')).toBeNull()
})

test('footer not last -> null', () => {
  expect(parseNextStep(`${FOOTER}\n\nE mais uma coisa.`)).toBeNull()
  expect(parseNextStep(`${BODY}\n${FOOTER}\n\`\`\``)).toBeNull()
})

test('mid-stream partial footers -> null', () => {
  const full = `${BODY}\n\n${FOOTER}`
  const start = full.indexOf('**Próximo')
  for (let n = start; n < full.length; n++) {
    const cut = full.slice(0, n)
    // Cutting inside the last value can still read as a complete word ("auto"); everything before must not parse.
    if (cut.trimEnd().endsWith('**Modo**: auto')) continue
    expect(parseNextStep(cut)).toBeNull()
  }
  expect(parseNextStep(`${BODY}\n\n**Próximo passo**\n- **Tarefa**: barra`)).toBeNull()
  expect(parseNextStep(`${BODY}\n\n**Próximo passo**\n- **Tarefa**: barra\n- **Modelo**: Opus 5.5\n- **Effort**: high\n- **Mo`)).toBeNull()
})

test('unknown or ambiguous model -> null', () => {
  expect(parseNextStep(footer({ model: 'GPT 9' }))).toBeNull()
  expect(parseNextStep(footer({ model: 'Opus or Sonnet' }))).toBeNull()
  expect(parseNextStep(footer({ model: '' }))).toBeNull()
})

test('unknown effort or mode, empty task -> null', () => {
  expect(parseNextStep(footer({ effort: 'ultra' }))).toBeNull()
  expect(parseNextStep(footer({ effort: 'high or max' }))).toBeNull()
  expect(parseNextStep(footer({ mode: 'yolo mode' }))).toBeNull()
  expect(parseNextStep(footer({ mode: 'plan or auto' }))).toBeNull()
  expect(parseNextStep(footer({ task: '' }))).toBeNull()
})

test('duplicate, missing or unknown fields -> null', () => {
  expect(parseNextStep(`${FOOTER}\n- **Modo**: plan mode`)).toBeNull()
  expect(parseNextStep(`${FOOTER}\n- **Notas**: nada`)).toBeNull()
  expect(parseNextStep(FOOTER.replace('- **Effort**: high\n', ''))).toBeNull()
  expect(parseNextStep(`${FOOTER}\nlinha solta`)).toBeNull()
})

test('only the last footer counts', () => {
  const earlier = footer({ task: 'antiga', mode: 'plan mode' })
  const r = parseNextStep(`${earlier}\n\nmeio\n\n${footer({ task: 'nova' })}`)
  expect(r?.step.task).toBe('nova')
  expect(r?.body).toBe(`${earlier}\n\nmeio`)
})

test('familyOf', () => {
  expect(familyOf('claude-opus-5-5')).toBe('opus')
  expect(familyOf('Haiku 5.5')).toBe('haiku')
  expect(familyOf('FABLE')).toBe('fable')
  expect(familyOf('sonnet[1m]')).toBe('sonnet')
  expect(familyOf('gpt-9')).toBeNull()
  expect(familyOf('opus-sonnet')).toBeNull()
  expect(familyOf('')).toBeNull()
  expect(familyOf(null)).toBeNull()
  expect(familyOf(undefined)).toBeNull()
})

test('EFFORTS order and effortIndex', () => {
  expect([...EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(effortIndex('xhigh')).toBe(3)
  expect(effortIndex('nope')).toBe(-1)
  expect(effortIndex(null)).toBe(-1)
})

test('the task keeps its own ** and __ (dunders, kwargs, exponents); only a wrapping bold pair goes', () => {
  expect(parseNextStep(footer({ task: 'criar `__init__.py` em pkg' }))?.step.task).toBe('criar `__init__.py` em pkg')
  expect(parseNextStep(footer({ task: 'aceitar `**kwargs` no handler' }))?.step.task).toBe('aceitar `**kwargs` no handler')
  expect(parseNextStep(footer({ task: 'calcular 2**10' }))?.step.task).toBe('calcular 2**10')
  expect(parseNextStep(footer({ task: '**barra de uso**' }))?.step.task).toBe('barra de uso')
})

test('a footer inside an unclosed fence or an indented code block is not a card', () => {
  expect(parseNextStep(`Exemplo:\n\`\`\`md\n${FOOTER}`)).toBeNull()
  expect(parseNextStep('    Next step:\n    Task: x\n    Model: opus\n    Effort: high\n    Mode: plan')).toBeNull()
  expect(parseNextStep(`Exemplo:\n\`\`\`md\ncode\n\`\`\`\n\n${FOOTER}`)?.step.task).toBe('barra de uso')
})
