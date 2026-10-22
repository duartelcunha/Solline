import { expect, test, type Page } from '@playwright/test';
import { permission } from '../fixtures';

async function open(page: Page, scene = 'conversation') {
  await page.goto(`/?scene=${scene}`);
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-title')).toContainText('Melhora a navegação');
}

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.qa.failures)).toEqual([]);
  expect(await page.evaluate(() => window.qa.subscriptions())).toBe(1);
  expect(await page.evaluate(() => window.qa.windowSubscriptions())).toBe(1);
  expect(await page.evaluate(() => window.qa.closeSubscriptions())).toBe(1);
});

test('pedido pendente preserva leitura e foco até ao salto explícito', async ({ page }) => {
  await open(page, 'long');
  const conversation = page.getByTestId('conversation');
  const composer = page.getByTestId('composer-input');
  await composer.focus();
  await conversation.evaluate((el) => {
    el.scrollTop = 300;
    el.dispatchEvent(new Event('scroll'));
  });
  const before = await conversation.evaluate((el) => el.scrollTop);
  await page.evaluate(
    (block) =>
      window.qa.emit({
        kind: 'event',
        type: 'permission.request',
        sessionId: 'session-1',
        turnId: 'answer-1',
        request: block,
      }),
    permission,
  );
  const jump = page.getByTestId('jump-new');
  await expect(jump).toHaveText('Precisa de ti');
  await expect(composer).toBeFocused();
  expect(await conversation.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
  // Keyboard activation lands immediately and moves focus to the decision region.
  await jump.focus();
  await jump.press('Enter');
  const card = page.locator(`[data-ask="${permission.id}"]`);
  await expect(card).toBeInViewport();
  await expect(card).toBeFocused();
});

test('recarregar recupera conversa e rascunho sem reenviar', async ({ page }) => {
  await open(page);
  const composer = page.getByTestId('composer-input');
  await composer.fill('Rascunho que continua aqui.');
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.solline.recovery.ui()).drafts['session-1']?.text),
    )
    .toBe('Rascunho que continua aqui.');
  await page.reload();
  await expect(page.getByTestId('session-title')).toContainText('Melhora a navegação');
  await expect(page.getByTestId('composer-input')).toHaveValue('Rascunho que continua aqui.');
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  expect(
    await page.evaluate(() => window.qa.journal.filter((e) => e.name === 'session.send')),
  ).toEqual([]);
});

test('envio sem confirmação recupera texto e nunca o repete', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.qa.hold('session.send'));
  await page.getByTestId('composer-input').fill('Confirmar antes de repetir.');
  await page.getByTestId('composer-input').press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.solline.recovery.ui()).drafts['session-1']?.pendingSend,
      ),
    )
    .toBe('Confirmar antes de repetir.');
  await page.reload();
  await expect(page.getByTestId('composer-input')).toHaveValue('Confirmar antes de repetir.');
  expect(
    await page.evaluate(() => window.qa.journal.filter((e) => e.name === 'session.send')),
  ).toEqual([]);
});

test('controlos respondem ao canto e reentrada sem ativar ações ocultas', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  const controls = page.getByTestId('window-controls');
  const width = await page.evaluate(() => innerWidth);
  await expect(controls).toHaveAttribute('data-open', 'false');
  await expect(page.getByRole('button', { name: 'Fechar janela' })).toBeHidden();
  await page.mouse.move(width - 2, 2);
  await expect(controls).toHaveAttribute('data-open', 'true');
  await page.mouse.move(400, 400);
  await page.clock.runFor(239);
  await page.mouse.move(width - 2, 2);
  await page.clock.runFor(500);
  await expect(controls).toHaveAttribute('data-open', 'true');
  await page.mouse.move(400, 400);
  await page.clock.runFor(240);
  await expect(controls).toHaveAttribute('data-open', 'false');
  expect(await page.evaluate(() => window.qa.journal.filter((e) => e.kind === 'window'))).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  for (const zoom of [1, 1.25]) {
    test(`aproximação contínua · ${theme} · zoom ${zoom}`, async ({ page }, info) => {
      await open(page);
      await page.evaluate(({ theme, zoom }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.zoom = String(zoom);
      }, { theme, zoom });
      const controls = page.getByTestId('window-controls');
      const box = await controls.boundingBox();
      if (!box) throw new Error('Control region missing');
      const width = await page.evaluate(() => innerWidth);
      for (const [x, y] of [
        [width - 2, 2], // client corner, including the former 10px gap
        [box.x + 12, 2], // top
        [width - 2, box.height - 4], // right
        [box.x + 2, box.height - 2], // diagonal from content
      ] as const) {
        await page.mouse.move(400, 400);
        await expect(controls).toHaveAttribute('data-open', 'false');
        await page.mouse.move(x, y, { steps: 12 });
        await expect(controls).toHaveAttribute('data-open', 'true');
      }
      await page.mouse.move(400, 400);
      await expect(page.locator('.window-actions')).toHaveCSS('opacity', '0');
      // Sample the browser's actual CSS transitions at 80ms, rather than relying
      // on screenshot transport timing. This instrument changes no application state.
      await controls.evaluate((el) => {
        const observer = new MutationObserver(() => {
          if (el.getAttribute('data-open') !== 'true') return;
          observer.disconnect();
          const animations = el.getAnimations({ subtree: true });
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = 80;
          }
          el.setAttribute('data-qa-sample', String(animations.length));
        });
        observer.observe(el, { attributes: true, attributeFilter: ['data-open'] });
      });
      await page.mouse.move(width - 2, 2);
      await expect(controls).toHaveAttribute('data-qa-sample', /^[1-9]\d*$/);
      const opacity = await page.locator('.window-actions').evaluate((el) => Number(getComputedStyle(el).opacity));
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(1);
      await controls.screenshot({ path: info.outputPath('opening-80ms.png') });
      await controls.evaluate((el) => {
        for (const animation of el.getAnimations({ subtree: true })) animation.play();
        el.removeAttribute('data-qa-sample');
      });
      await expect(page.locator('.window-actions')).toHaveCSS('opacity', '1');
      await controls.screenshot({ path: info.outputPath('settled.png') });
      const maximize = page.getByRole('button', { name: 'Maximizar janela', exact: true });
      await expect(maximize.locator('svg')).toHaveClass(/lucide-maximize-2/);
      await maximize.click();
      await expect(page.getByRole('button', { name: 'Restaurar tamanho da janela' }).locator('svg')).toHaveClass(/lucide-minimize-2/);
      await page.getByRole('button', { name: 'Restaurar tamanho da janela' }).click();
      await expect(maximize).toBeVisible();
    });
  }
}

test('cabeçalho estreito conserva conteúdo fora da zona invisível com zoom', async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 780 });
  await open(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1.25';
    const title = document.querySelector('[data-testid="session-title"]');
    if (title) title.textContent = 'Uma sessão com um título muito extenso para verificar seleção e controlos';
  });
  const controls = await page.getByTestId('window-controls').boundingBox();
  if (!controls) throw new Error('Control region missing');
  for (const child of await page.locator('.session-header > *').all()) {
    const box = await child.boundingBox();
    if (!box) throw new Error('Header content missing');
    expect(box.x + box.width).toBeLessThanOrEqual(controls.x);
  }
  await page.screenshot({ path: info.outputPath('narrow-header.png') });
});

test('clique durante abertura ativa maximizar uma única vez', async ({ page }) => {
  await open(page);
  await page.mouse.move((await page.evaluate(() => innerWidth)) - 2, 2);
  await page.getByRole('button', { name: 'Maximizar janela', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restaurar tamanho da janela', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.qa.journal.filter((e) => e.kind === 'window' && e.name === 'toggle-maximize'))).toHaveLength(1);
});

test('controlos revelam por proximidade, mantêm foco e saem por Escape', async ({ page }) => {
  await page.clock.install();
  await open(page);
  const controls = page.getByTestId('window-controls');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  await expect(controls).toHaveAttribute('data-open', 'false');
  await controls.hover();
  await expect(controls).toHaveAttribute('data-open', 'true');
  await page.mouse.move(400, 400);
  await page.clock.runFor(239);
  await expect(controls).toHaveAttribute('data-open', 'true');
  await page.clock.runFor(1);
  await expect(controls).toHaveAttribute('data-open', 'false');
  await controls.hover();
  await page.getByRole('button', { name: 'Maximizar janela', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restaurar tamanho da janela' })).toBeVisible();
  await page.mouse.move(400, 400);
  await page.clock.runFor(500);
  // Focus inside retains the controls even after their pointer exit delay.
  await expect(page.getByRole('button', { name: 'Restaurar tamanho da janela' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(controls).toHaveAttribute('data-open', 'false');
  await expect(
    page.getByRole('button', { name: 'Controlos da janela', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Minimizar janela' })).toBeFocused();
});

test('Escape de um modal mantém a janela aberta e devolve o foco', async ({ page }) => {
  await open(page);
  const trigger = page.getByTestId('sidebar-agents');
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.qa.windowState().closed)).toBe(false);
  expect(await page.evaluate(() => window.qa.journal.filter((e) => e.kind === 'window'))).toEqual(
    [],
  );
});

test('controlos recolhem depois de largar um gesto fora da zona', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  const controls = page.getByTestId('window-controls');
  const box = await controls.boundingBox();
  if (!box) throw new Error('Control region missing');
  // Its left proximity margin reveals the buttons without focusing or activating one.
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(400, 400);
  await page.clock.runFor(500);
  await expect(controls).toHaveAttribute('data-open', 'true');
  await page.mouse.up();
  await page.clock.runFor(239);
  await expect(controls).toHaveAttribute('data-open', 'true');
  await page.clock.runFor(1);
  await expect(controls).toHaveAttribute('data-open', 'false');
  // A completed gesture cannot poison the next ordinary proximity interaction.
  await controls.hover();
  await page.mouse.move(400, 400);
  await page.clock.runFor(240);
  await expect(controls).toHaveAttribute('data-open', 'false');
  expect(
    await page.evaluate(() => window.qa.journal.filter((entry) => entry.kind === 'window')),
  ).toEqual([]);
});

test('fecho espera pela persistência do rascunho', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.qa.hold('recovery.saveDraft'));
  await page.getByTestId('composer-input').fill('Guardar antes de fechar.');
  await page.getByTestId('window-controls').hover();
  await page.getByRole('button', { name: 'Fechar janela' }).click();
  expect(await page.evaluate(() => window.qa.windowState().closeRequested)).toBe(true);
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
  await page.evaluate(() => {
    void window.qa.confirmClose();
  });
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  await page.keyboard.type('Texto tardio que não pode entrar.');
  await expect(page.getByTestId('composer-input')).toHaveValue('Guardar antes de fechar.');
  expect(await page.evaluate(() => window.qa.windowState().closed)).toBe(false);
  await page.evaluate(() => window.qa.release('recovery.saveDraft'));
  await expect.poll(() => page.evaluate(() => window.qa.windowState().closed)).toBe(true);
  expect(
    await page.evaluate(async () => (await window.solline.recovery.ui()).drafts['session-1']?.text),
  ).toBe('Guardar antes de fechar.');
});

test('falha no fecho descongela a edição e permite corrigir o rascunho', async ({ page }) => {
  await open(page);
  await page.getByTestId('composer-input').fill('Primeiro rascunho.');
  await page.evaluate(async () => {
    await window.solline.window.action('close');
    window.qa.cancelClose();
  });
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
  await page.evaluate(async () => {
    await window.solline.window.action('close');
    window.qa.fail('engine.flush');
    await window.qa.confirmClose().catch(() => undefined);
  });
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
  await page.getByTestId('composer-input').fill('Rascunho corrigido.');
  expect(await page.evaluate(() => window.qa.windowState().closed)).toBe(false);
});

test('falha de recuperação mantém a saída explícita acessível', async ({ page }) => {
  await page.goto('/?scene=conversation&failRecovery=1');
  const recover = page.getByRole('button', { name: 'Recuperar interface' });
  await expect(recover).toBeVisible();
  await expect(recover).toBeEnabled();
  await recover.click();
  expect(await page.evaluate(() => window.qa.recoveryOpened())).toBe(true);
  expect(
    await page.evaluate(() => window.qa.journal.filter((e) => e.name === 'recovery-open')),
  ).toHaveLength(1);
  await page.getByTestId('window-controls').hover();
  await expect(page.getByRole('button', { name: 'Fechar janela' })).toBeEnabled();
});

test.describe('ponteiro tátil', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('ações permanecem visíveis com alvos de 44px', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('window-controls')).toHaveAttribute('data-coarse', 'true');
    await expect(page.getByTestId('window-controls')).toHaveAttribute('data-open', 'true');
    for (const name of ['Minimizar janela', 'Maximizar janela', 'Fechar janela']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
  });
});
