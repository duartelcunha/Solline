import { test, expect } from '@playwright/test';
import { HOODS, MOODS } from '@solline/ui/bot';
test.use({ video: 'on' });

for (const theme of ['light', 'dark'])
  test(`família completa · ${theme}`, async ({ page }, info) => {
    await page.goto(`/?scene=figures&family=1&theme=${theme}`);
    await expect(page.getByTestId('bot')).toHaveCount(Object.keys(HOODS).length * MOODS.length);
    await page.evaluate(() => document.fonts.ready);
    await info.attach('family', {
      body: await page.screenshot({
        path: info.outputPath('family.png'),
        fullPage: true,
        animations: 'disabled',
      }),
      contentType: 'image/png',
    });
  });

for (const theme of ['light', 'dark'])
  test(`figuras em tamanhos reais · ${theme}`, async ({ page }, info) => {
    await page.goto(`/?scene=figures&theme=${theme}`);
    await expect(page.getByRole('heading')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await info.attach('figures', {
      body: await page.screenshot({ path: info.outputPath('figures.png'), animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

test('movimento interrompível, reduzido ao vivo e suspenso fora de vista', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/?scene=figures');
  const bot = page.getByTestId('live-figure').getByTestId('bot');
  await expect(bot).toHaveAttribute('data-live', 'true');
  const pupils = bot.getByTestId('bot-pupils');
  await page.mouse.move(1100, 40);
  await expect
    .poll(() => pupils.evaluate((el) => getComputedStyle(el).transform))
    .not.toBe('matrix(1, 0, 0, 1, 0, 0)');
  const gaze = await pupils.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return Math.hypot(m.m41, m.m42);
  });
  expect(gaze).toBeLessThanOrEqual(6.1);
  await page.getByRole('button', { name: 'working', exact: true }).click();
  await expect
    .poll(() =>
      bot.evaluate(
        (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
      ),
    )
    .toBeGreaterThan(0);
  for (const frame of [0, 180, 400]) {
    await bot.evaluate((el, time) => {
      for (const a of el.getAnimations({ subtree: true })) {
        a.pause();
        a.currentTime = time;
      }
    }, frame);
    await info.attach(`frame-${frame}`, {
      body: await bot.screenshot({ path: info.outputPath(`frame-${frame}.png`) }),
      contentType: 'image/png',
    });
  }
  await page.getByRole('button', { name: 'needs-you', exact: true }).click();
  await page.getByRole('button', { name: 'crashed', exact: true }).click();
  await expect(bot).toHaveAttribute('data-mood', 'crashed');
  await page.getByRole('button', { name: 'working', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(bot).toHaveAttribute('data-live', 'false');
  await expect(pupils).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect.poll(() => bot.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(bot).toHaveAttribute('data-live', 'true');
  await page.getByRole('button', { name: 'Fim da galeria' }).scrollIntoViewIfNeeded();
  await expect(bot).toHaveAttribute('data-live', 'false');
  await expect.poll(() => bot.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
});
