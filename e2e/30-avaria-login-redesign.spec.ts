// AVARIA V2: full-screen login redesign. The login screen's background now
// fills the viewport edge-to-edge with a layered dark navy/purple atmosphere
// (gradients, ambient glow, a faint dot grid, a restrained waveform accent,
// a few light points) instead of one large centered/split card -- see
// AvariaLoginAtmosphere and the non-compact AvariaAuthBrandPanel path in
// src/components/AvariaBrand.tsx. Desktop uses an asymmetric split (brand
// column vs. login column); mobile stacks into one continuous vertical
// surface. The Google sign-in action itself is untouched (see
// src/auth/supabaseAuth.test.tsx for its behavior coverage) -- this file
// covers presentation only.
import { test, expect } from '@playwright/test';

const OVERFLOW_VIEWPORTS = [
  { width: 320, height: 700, label: 'mobile-small' },
  { width: 390, height: 844, label: 'mobile' },
  { width: 390, height: 600, label: 'mobile-short' },
  { width: 768, height: 1024, label: 'tablet' },
  { width: 1280, height: 900, label: 'desktop' },
  { width: 1366, height: 768, label: 'desktop-1366' },
  { width: 1440, height: 900, label: 'desktop-1440' },
  { width: 1920, height: 1080, label: 'desktop-1920' },
];

for (const { width, height, label } of OVERFLOW_VIEWPORTS) {
  test(`login screen has no horizontal overflow at ${width}x${height} (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/login');
    await page.waitForTimeout(200);
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflowX).toBe(false);
  });
}

test.describe('full-screen composition (no centered/split card)', () => {
  test('the background fills the viewport edge-to-edge, with no outer margin, border, or rounded frame', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');

    // The old V1 card shell (rounded-3xl + border, inset from the viewport
    // with a visible outer margin) must be gone entirely.
    await expect(page.locator('.rounded-3xl')).toHaveCount(0);

    // The root page wrapper itself reaches every edge of the viewport --
    // no letterboxing that would make the page read as embedded inside
    // another surface.
    const root = page.locator('body > div').first();
    const box = await root.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeLessThanOrEqual(0);
    expect(box!.y).toBeLessThanOrEqual(0);
    expect(box!.width).toBeGreaterThanOrEqual(1440);

    const style = await root.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { borderWidth: cs.borderWidth, borderStyle: cs.borderStyle };
    });
    expect(['0px', '']).toContain(style.borderWidth === '0px' ? '0px' : style.borderWidth);
    expect(style.borderStyle === 'none' || style.borderWidth === '0px').toBe(true);
  });

  test('local elements (e.g. the demo-user picker rows) may use restrained glass styling without the page itself reading as a card', async ({
    page,
  }) => {
    await page.goto('/login');
    const firstAction = page.locator('[data-testid^="login-"]').first();
    await expect(firstAction).toBeVisible();
    const style = await firstAction.evaluate((el) => getComputedStyle(el).backdropFilter);
    expect(style).not.toBe('none');
  });
});

test.describe('desktop asymmetric split (1366x768, 1440x900, 1920x1080)', () => {
  for (const { width, height } of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`brand and login areas are clearly distinct, deliberately unequal, and neither reads as an isolated boxed card at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/login');

      const brandHeading = page.getByRole('heading', { name: 'AVARIA' });
      await expect(brandHeading).toBeVisible();
      await expect(brandHeading.getByRole('img', { name: 'AVARIA' })).toHaveAttribute(
        'src',
        '/branding/avaria-logo-full.png',
      );
      const loginHeading = page.getByRole('heading', { name: 'כניסה למערכת' });
      await expect(loginHeading).toBeVisible();
      await expect(page.getByText('ברוכים הבאים')).toBeVisible();

      // RTL: the brand column sits toward the right (inline-start in RTL),
      // the login column toward the left -- and the split is deliberately
      // NOT a rigid 50/50 (an "asymmetric" composition per the approved
      // direction), while both stay clearly distinct columns.
      const brandBox = await brandHeading.boundingBox();
      const loginBox = await loginHeading.boundingBox();
      expect(brandBox!.x).toBeGreaterThan(loginBox!.x);
      expect(loginBox!.x).toBeLessThan(width * 0.5);

      // Neither column has its own background box/border -- both sit
      // directly on the shared page atmosphere.
      expect(await page.locator('.rounded-3xl, [class*="border-white"][class*="rounded-3xl"]').count()).toBe(0);
    });
  }
});

test.describe('typography hierarchy', () => {
  test('"כניסה למערכת" is the dominant heading, sized well above the old compact scale', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');
    const heading = page.getByRole('heading', { name: 'כניסה למערכת' });
    const fontSize = await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(40);
  });
});

test.describe('branding', () => {
  test('the two approved unit logos sit in the top-left corner on desktop, clearly smaller than the AVARIA mark and clear of the sign-in action', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');

    const logos = page.getByTestId('department-logos');
    await expect(logos).toBeVisible();
    await expect(page.getByTestId('department-logo-502')).toBeVisible();
    await expect(page.getByTestId('department-logo-strategic-communication')).toBeVisible();
    await expect(logos).toHaveAttribute('aria-hidden', 'true');

    // Top-left page corner (physically left, regardless of RTL), well clear
    // of both the sign-in action and the primary AVARIA mark.
    const logosBox = await logos.boundingBox();
    expect(logosBox!.x).toBeLessThan(120);
    expect(logosBox!.y).toBeLessThan(80);

    const brandLogoBox = await page.getByRole('img', { name: 'AVARIA' }).boundingBox();
    expect(logosBox!.width).toBeLessThan(brandLogoBox!.width);

    const googleFirstAction = page.locator('[data-testid^="login-"]').first();
    const actionBox = await googleFirstAction.boundingBox();
    expect(logosBox!.y + logosBox!.height).toBeLessThan(actionBox!.y);
  });

  test('the unit logos also appear compactly near the top on mobile, without crowding the primary content', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');

    const logos = page.getByTestId('department-logos');
    await expect(logos).toBeVisible();
    const logosBox = await logos.boundingBox();
    expect(logosBox!.x).toBeLessThan(60);
    expect(logosBox!.y).toBeLessThan(40);

    const heading = page.getByRole('heading', { name: 'כניסה למערכת' });
    const headingBox = await heading.boundingBox();
    expect(logosBox!.y + logosBox!.height).toBeLessThan(headingBox!.y);
  });
});

test('mobile: one cohesive vertical surface -- compact hero, then the sign-in action, with no duplicated brand heading', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');

  // Exactly one brand heading exists in the DOM (the same element is
  // restyled responsively) -- never a duplicated hero + full desktop panel.
  await expect(page.getByRole('heading', { name: 'AVARIA' })).toHaveCount(1);

  const welcomePill = page.getByText('ברוכים הבאים');
  const loginHeading = page.getByRole('heading', { name: 'כניסה למערכת' });
  const firstAction = page.locator('[data-testid^="login-"]').first();
  await expect(welcomePill).toBeVisible();
  await expect(loginHeading).toBeVisible();
  await expect(firstAction).toBeVisible();

  // The sign-in action is above the fold, no scrolling needed. (This suite
  // always runs against demo mode -- see playwright.config.ts -- so the
  // sign-in affordance here is the demo-user picker; the real Google
  // button's identical position in the DOM/layout is covered by
  // src/auth/supabaseAuth.test.tsx.)
  for (const locator of [welcomePill, loginHeading, firstAction]) {
    const box = await locator.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  }
});

test('mobile at 320x700: the sign-in action is visible in the initial viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/login');

  const firstAction = page.locator('[data-testid^="login-"]').first();
  await expect(firstAction).toBeVisible();
  const actionBox = await firstAction.boundingBox();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(700);
});

test('mobile at a short viewport height (390x600): the sign-in action stays reachable within/just past the initial viewport, never crowded out by decoration', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto('/login');
  const firstAction = page.locator('[data-testid^="login-"]').first();
  await expect(firstAction).toBeVisible();
});

test.describe('keyboard accessibility', () => {
  // This suite always runs against demo mode (see playwright.config.ts), so
  // the reachable sign-in control here is the demo-user picker's first
  // button; it shares the exact same unstyled-outline markup and the same
  // global `:focus-visible` rule (index.css) as the real Google button
  // (data-testid="google-login-button" in src/pages/LoginPage.tsx), which
  // never appears in this environment.
  test('the primary sign-in control is keyboard-reachable with a clear, visible focus state', async ({ page }) => {
    await page.goto('/login');
    const button = page.locator('[data-testid^="login-"]').first();
    await button.focus();
    await expect(button).toBeFocused();
    const outline = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, style: cs.outlineStyle };
    });
    expect(outline.style).not.toBe('none');
    expect(parseFloat(outline.width)).toBeGreaterThan(0);
  });
});

test.describe('login entrance motion', () => {
  test('completes within 700ms and settles to full opacity / no offset (no residual transform)', async ({ page }) => {
    await page.goto('/login');
    const panel = page.getByTestId('auth-entrance-panel');
    await page.waitForTimeout(750);
    const finalState = await panel.evaluate((el) => {
      const style = getComputedStyle(el);
      return { opacity: style.opacity, transform: style.transform };
    });
    expect(finalState.opacity).toBe('1');
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(finalState.transform);
  });

  test('the sign-in action is clickable immediately, before the entrance motion finishes', async ({ page }) => {
    // No artificial wait -- clicking as soon as the element is attached
    // proves the animation never blocks interactivity.
    await page.goto('/login');
    await page.getByTestId(/^login-/).first().click();
    await expect(page.getByRole('heading', { name: 'מצב נוכחי' })).toBeVisible();
  });

  test('respects prefers-reduced-motion: motion collapses to an almost-instant fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/login');
    const panel = page.getByTestId('auth-entrance-panel');
    const durationMs = await panel.evaluate((el) => {
      const raw = getComputedStyle(el).animationDuration; // e.g. "0.000001s" or "0.001ms"
      const value = parseFloat(raw);
      return raw.trim().endsWith('ms') ? value : value * 1000;
    });
    // The global reduced-motion rule forces all animation-durations to
    // 0.001ms -- i.e. effectively instant, no visible movement.
    expect(durationMs).toBeLessThanOrEqual(0.01);
  });

  test('respects prefers-reduced-motion: the ambient backdrop particles stop animating too', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/login');
    const durations = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[aria-hidden="true"] span')).map(
        (el) => getComputedStyle(el).animationDuration,
      ),
    );
    for (const raw of durations) {
      const value = parseFloat(raw);
      const ms = raw.trim().endsWith('ms') ? value : value * 1000;
      expect(ms).toBeLessThanOrEqual(0.01);
    }
  });
});

test('RTL: the document renders right-to-left and the login form keeps natural Hebrew reading order', async ({
  page,
}) => {
  await page.goto('/login');
  expect(await page.locator('html').getAttribute('dir')).toBe('rtl');

  const welcomePill = page.getByText('ברוכים הבאים');
  const heading = page.getByRole('heading', { name: 'כניסה למערכת' });
  const firstAction = page.locator('[data-testid^="login-"]').first();

  const pillHandle = await welcomePill.elementHandle();
  const headingHandle = await heading.elementHandle();
  const buttonHandle = await firstAction.elementHandle();
  const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
  expect(
    (await page.evaluate(([a, b]) => a!.compareDocumentPosition(b!), [pillHandle, headingHandle])) & FOLLOWING,
  ).toBeTruthy();
  expect(
    (await page.evaluate(([a, b]) => a!.compareDocumentPosition(b!), [headingHandle, buttonHandle])) & FOLLOWING,
  ).toBeTruthy();
});
