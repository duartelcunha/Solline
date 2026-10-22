import { test, expect } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [
    { width: 760, height: 520 },
    { width: 1200, height: 780 },
    { width: 1600, height: 1000 },
  ]) {
    for (const scene of ['welcome', 'permission', 'review', 'question']) {
      test(`${scene} · ${theme} · ${viewport.width}`, async ({ page }, info) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`/?scene=${scene}`);
        if (scene !== 'welcome') {
          await page.getByTestId('new-session').click();
          await expect(page.getByTestId('session-title')).toContainText('Melhora a navegação');
        } else await expect(page.getByTestId('familiar')).toBeVisible();
        if (scene === 'review') {
          await page.getByTestId('review-toggle').click();
          await expect(page.getByTestId('diff-hunk')).toBeVisible();
        }
        if (scene === 'permission') await expect(page.getByTestId('permission-card')).toBeVisible();
        if (scene === 'question') await expect(page.getByTestId('question-card')).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        if (scene === 'permission' || scene === 'question') {
          const card = page.getByTestId(`${scene}-card`);
          const box = await page.getByTestId('conversation').boundingBox();
          const buttons = await card.getByRole('button').all();
          if (!box) throw new Error('Conversation bounds missing');
          for (const button of buttons) {
            const rect = await button.boundingBox();
            if (!rect) throw new Error('Decision bounds missing');
            expect(rect.y).toBeGreaterThanOrEqual(box.y);
            expect(rect.y + rect.height).toBeLessThanOrEqual(box.y + box.height + 1);
          }
        }
        await expect(page.locator('.app-shell')).toHaveCSS('display', 'grid');
        await expect(page.locator('main')).toHaveCSS('display', 'flex');
        const bounds = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          height: document.documentElement.scrollHeight,
          viewportHeight: innerHeight,
        }));
        expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
        expect(bounds.height).toBeLessThanOrEqual(bounds.viewportHeight);
        expect(errors).toEqual([]);
        expect(
          await page.evaluate(
            () => (window as unknown as { qa: { failures: string[] } }).qa.failures,
          ),
        ).toEqual([]);
        await info.attach('appearance', {
          body: await page.screenshot({
            path: info.outputPath('appearance.png'),
            animations: 'disabled',
          }),
          contentType: 'image/png',
        });
      });
    }
  }
}
