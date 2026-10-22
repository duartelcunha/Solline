import { test, expect } from '@playwright/test';

test('leitura longa preserva posição e seleção quando chega conteúdo', async ({ page }, info) => {
  await page.goto('/?scene=long');
  await page.getByTestId('new-session').click();
  const conversation = page.getByTestId('conversation');
  await expect(page.getByRole('heading', { name: 'Passo 160', exact: true })).toBeAttached();
  await conversation.evaluate((el) => {
    el.scrollTop = 300;
    el.dispatchEvent(new Event('scroll'));
  });
  const before = await conversation.evaluate((el) => el.scrollTop);
  const selected = await page
    .getByTestId('assistant-text')
    .last()
    .locator('p')
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString();
    });
  expect(selected).toContain('A navegação mantém');
  await page.evaluate(() =>
    window.qa.emit({
      kind: 'event',
      type: 'session.event',
      sessionId: 'session-1',
      delta: {
        type: 'block.upsert',
        turnId: 'answer-1',
        block: {
          kind: 'text',
          id: 'arrival',
          text: 'Chegou uma atualização sem deslocar a leitura.',
          parentToolId: null,
        },
      },
    }),
  );
  await expect(page.getByTestId('jump-new')).toBeVisible();
  expect(await conversation.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
  await info.attach('reading', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByTestId('jump-new').click();
  await expect(page.getByText('Chegou uma atualização sem deslocar a leitura.')).toBeInViewport();
});

for (const theme of ['light', 'dark'] as const)
  test(`contraste dos tokens de leitura e decisões · ${theme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/?scene=permission');
    await page.getByTestId('new-session').click();
    const ratios = await page.evaluate(() => {
      const pairs = [
        ['text', 'surface'],
        ['text-muted', 'surface'],
        ['text-subtle', 'bg'],
        ['accent-text', 'accent-soft'],
        ['on-accent', 'accent'],
        ['attention', 'attention-soft'],
        ['danger', 'surface'],
      ] as const;
      const probe = document.createElement('span');
      document.body.append(probe);
      const rgb = (token: string) => {
        probe.style.color = `var(--sl-${token})`;
        return (
          getComputedStyle(probe)
            .color.match(/[\d.]+/g)
            ?.slice(0, 3)
            .map(Number) ?? []
        );
      };
      const luminance = (c: number[]) =>
        c
          .map((v) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
      const result = pairs.map(([fg, bg]) => {
        const a = luminance(rgb(fg)),
          b = luminance(rgb(bg));
        return { fg, bg, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
      probe.remove();
      return result;
    });
    await info.attach('contrast', {
      body: JSON.stringify(ratios, null, 2),
      contentType: 'application/json',
    });
    for (const pair of ratios)
      expect(pair.ratio, `${pair.fg} on ${pair.bg}`).toBeGreaterThanOrEqual(4.5);
  });

test('ampliação de layout mantém decisão e compositor acessíveis', async ({ page }, info) => {
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.goto('/?scene=permission');
  await page.getByTestId('new-session').click();
  // CSS zoom tests layout amplification. Native Electron zoom/DPI is a separate distribution check.
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1.5';
  });
  await page.getByRole('button', { name: /^Negar/ }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /^Negar/ })).toBeInViewport();
  await expect(page.getByTestId('composer-input')).toBeInViewport();
  await info.attach('zoom-150', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: /^Negar/ }).click();
  await expect(page.getByTestId('ask-resolved')).toHaveAttribute('data-status', 'denied');
});
