import { test, expect } from '@playwright/test';
import { loginAs, DEMO_USERS } from './helpers';

async function openActiveIncident(page: import('@playwright/test').Page) {
  await loginAs(page, DEMO_USERS.admin);
  await page.getByRole('link', { name: /2026-001/ }).click();
  await expect(page.getByRole('heading', { name: /2026-001/ })).toBeVisible();
}

test('incident actions expose the approved hierarchy and overflow grouping', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openActiveIncident(page);

  const actions = page.getByRole('region', { name: 'פעולות תקלה' });
  await expect(actions.getByRole('button', { name: 'עדכון תקלה' })).toHaveClass(/bg-brand-600/);
  await expect(actions.getByRole('button', { name: 'סגירת תקלה' })).toHaveClass(/bg-surface/);
  await expect(actions.getByRole('button', { name: 'שינוי גורם מטפל' })).toHaveClass(/bg-surface/);
  await expect(actions.getByRole('button', { name: 'ייצוא PDF' })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'ביטול תקלה' })).toHaveCount(0);

  await actions.getByRole('button', { name: 'פעולות נוספות' }).click();
  const menu = page.getByRole('menu', { name: 'פעולות נוספות לתקלה' });
  await expect(menu.getByRole('menuitem', { name: 'ייצוא PDF' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'ביטול תקלה' })).toHaveClass(/text-red-700/);
});

test('incident actions stack cleanly and the overflow stays on-screen on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openActiveIncident(page);

  const actions = page.getByRole('region', { name: 'פעולות תקלה' });
  const updateBox = await actions.getByRole('button', { name: 'עדכון תקלה' }).boundingBox();
  const closeBox = await actions.getByRole('button', { name: 'סגירת תקלה' }).boundingBox();
  const assignBox = await actions.getByRole('button', { name: 'שינוי גורם מטפל' }).boundingBox();
  const moreButton = actions.getByRole('button', { name: 'פעולות נוספות' });
  const moreBox = await moreButton.boundingBox();
  const actionsBox = await actions.boundingBox();

  expect(updateBox && closeBox && assignBox && moreBox && actionsBox).toBeTruthy();
  if (updateBox && closeBox && assignBox && moreBox && actionsBox) {
    for (const button of [updateBox, closeBox, assignBox, moreBox]) {
      expect(button.width).toBeGreaterThan(actionsBox.width - 32);
    }
    expect(closeBox.y).toBeGreaterThan(updateBox.y);
    expect(assignBox.y).toBeGreaterThan(closeBox.y);
    expect(moreBox.y).toBeGreaterThan(assignBox.y);
  }

  await moreButton.click();
  const menuBox = await page.getByRole('menu', { name: 'פעולות נוספות לתקלה' }).boundingBox();
  expect(menuBox).toBeTruthy();
  if (menuBox) {
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(900);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
