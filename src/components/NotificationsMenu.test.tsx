// The redesigned bell notification center: filters (הכול / דורש פעולה /
// עדכונים), click-to-read-and-navigate, סימון הכול כנקרא, empty states per
// filter, and narrow-viewport rendering. Exercised through the real app
// with the demo repository and its real seeded notifications (see
// src/data/local/seed.ts: ntf-2 is tech1's unread personal incident_assigned
// notification (action_required); ntf-3 is the manager's read operational
// incident_opened notification (update)).
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';
import type { AppError as AppErrorType } from '../data/repository';

let App: typeof AppType;
let hooks: typeof import('../data/hooks');
let AppError: typeof AppErrorType;
beforeEach(async () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  vi.resetModules();
  App = (await import('../App')).default;
  hooks = await import('../data/hooks');
  AppError = (await import('../data/repository')).AppError;
});

async function loginAs(userTestId: string) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByTestId(userTestId));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
  return user;
}

function panel() {
  return document.querySelector('.popover-panel') as HTMLElement;
}

describe('NotificationsMenu: bell badge and popover', () => {
  it('shows the unread count for tech1 (one unread action_required notification), and the panel lists it under הכול', async () => {
    const user = await loginAs('login-u-tech-1');
    const bell = screen.getByTestId('notifications-button');
    expect(bell).toHaveAccessibleName(/התראות \(1 שלא נקראו\)/);

    await user.click(bell);
    const p = within(panel());
    expect(p.getByText('תקלה הוקצתה אליך')).toBeVisible();
    expect(p.getByText(/הוקצתה אליך לאחר פתיחה מחדש/)).toBeVisible();
  });

  it('filters: דורש פעולה shows the personal notification, עדכונים shows an empty state for a user with no update-category rows', async () => {
    const user = await loginAs('login-u-tech-1');
    await user.click(screen.getByTestId('notifications-button'));
    const p = within(panel());

    await user.click(p.getByRole('button', { name: 'עדכונים' }));
    expect(p.getByText('אין עדכונים.')).toBeVisible();
    expect(p.queryByText('תקלה הוקצתה אליך')).not.toBeInTheDocument();

    await user.click(p.getByRole('button', { name: 'דורש פעולה' }));
    expect(p.getByText('תקלה הוקצתה אליך')).toBeVisible();

    await user.click(p.getByRole('button', { name: 'הכול' }));
    expect(p.getByText('תקלה הוקצתה אליך')).toBeVisible();
  });

  it('filters: עדכונים shows the operational notification for the manager, דורש פעולה shows its own empty state', async () => {
    const user = await loginAs('login-u-manager');
    await user.click(screen.getByTestId('notifications-button'));
    const p = within(panel());

    expect(p.getByText('תקלה נפתחה')).toBeVisible();

    await user.click(p.getByRole('button', { name: 'דורש פעולה' }));
    expect(p.getByText('אין התראות שדורשות פעולה.')).toBeVisible();
    expect(p.queryByText('תקלה נפתחה')).not.toBeInTheDocument();

    await user.click(p.getByRole('button', { name: 'עדכונים' }));
    expect(p.getByText('תקלה נפתחה')).toBeVisible();
  });

  it('clicking an item marks it read, closes the popover, and navigates to its incident', async () => {
    const user = await loginAs('login-u-tech-1');
    await user.click(screen.getByTestId('notifications-button'));
    const p = within(panel());

    await user.click(p.getByText(/הוקצתה אליך לאחר פתיחה מחדש/));

    expect(document.querySelector('.popover-panel')).not.toBeInTheDocument();
    // IncidentDetailPage's heading is "{number} · {systemName}" -- inc-7 is 2026-007.
    await screen.findByRole('heading', { name: /2026-007/ });
    expect(screen.getByTestId('notifications-button')).toHaveAccessibleName('התראות');
  });

  it('סימון הכול כנקרא clears the badge without navigating away', async () => {
    const user = await loginAs('login-u-tech-1');
    await user.click(screen.getByTestId('notifications-button'));
    const p = within(panel());

    await user.click(p.getByRole('button', { name: 'סימון הכול כנקרא' }));

    expect(screen.getByTestId('notifications-button')).toHaveAccessibleName('התראות');
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
  });

  it('shows the empty state for הכול when the signed-in user has no notifications at all', async () => {
    const user = await loginAs('login-u-viewer');
    await user.click(screen.getByTestId('notifications-button'));
    const p = within(panel());
    expect(p.getByText('אין התראות.')).toBeVisible();
  });

  it('Escape and outside-click close the popover', async () => {
    const user = await loginAs('login-u-tech-1');
    await user.click(screen.getByTestId('notifications-button'));
    expect(panel()).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(document.querySelector('.popover-panel')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('notifications-button'));
    expect(panel()).toBeInTheDocument();
    await user.click(document.body);
    expect(document.querySelector('.popover-panel')).not.toBeInTheDocument();
  });

  it('never renders update_overdue rows, even when one exists in storage', async () => {
    const seeding = render(<App />);
    const seedUser = userEvent.setup();
    await seedUser.click(await screen.findByTestId('login-u-tech-1'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    seeding.unmount();

    const raw = JSON.parse(localStorage.getItem('takalot-demo-db-v1')!);
    raw.notifications.push({
      id: 'ntf-legacy-overdue-ui',
      userId: 'u-tech-1',
      type: 'update_overdue',
      category: 'action_required',
      incidentId: 'inc-1',
      handoverId: null,
      text: 'עבר מועד העדכון לתקלה.',
      read: false,
      createdAt: new Date().toISOString(),
    });
    localStorage.setItem('takalot-demo-db-v1', JSON.stringify(raw));
    window.history.pushState({}, '', '/');
    vi.resetModules();
    App = (await import('../App')).default;

    // The demo session (separate localStorage key from the demo database)
    // is still tech1's from the seeding render above, so this second render
    // lands straight on the dashboard -- no login click needed.
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    await user.click(screen.getByTestId('notifications-button'));
    expect(within(panel()).queryByText('עבר מועד העדכון לתקלה.')).not.toBeInTheDocument();
  });

  it('renders without horizontal overflow on a narrow mobile viewport', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    try {
      const user = await loginAs('login-u-tech-1');
      await user.click(screen.getByTestId('notifications-button'));
      const el = panel();
      expect(el).toBeInTheDocument();
      const width = parseFloat(el.style.width);
      expect(width).toBeLessThanOrEqual(360);
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: originalWidth });
      window.dispatchEvent(new Event('resize'));
    }
  });
});

// The system_admin-only "עדכונים תפעוליים" preference now lives behind a
// gear button inside this popover's own header, opening a separate
// "הגדרות התראות" Dialog -- not the Sidebar account card or the mobile
// user menu (see Sidebar.tsx / Layout.tsx, which no longer reference
// OperationalNotificationsSwitch at all).
describe('NotificationsMenu: system_admin operational-notifications settings gear', () => {
  it('the gear renders only for system_admin, and is absent for every other role', async () => {
    for (const [testId, expectGear] of [
      ['login-u-admin', true],
      ['login-u-manager', false],
      ['login-u-supervisor-1', false],
      ['login-u-tech-1', false],
      ['login-u-viewer', false],
    ] as const) {
      localStorage.clear();
      window.history.pushState({}, '', '/');
      vi.resetModules();
      App = (await import('../App')).default;
      const user = userEvent.setup();
      const rendered = render(<App />);
      await user.click(await screen.findByTestId(testId));
      await screen.findByRole('heading', { name: 'מצב נוכחי' });
      await user.click(screen.getByTestId('notifications-button'));
      const gear = within(panel()).queryByRole('button', { name: 'הגדרות התראות' });
      if (expectGear) expect(gear).toBeVisible();
      else expect(gear).not.toBeInTheDocument();
      rendered.unmount();
    }
  });

  it('the gear stays visible when the signed-in admin has no notifications at all', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(screen.getByTestId('notifications-button'));
    const p = within(panel());
    expect(p.getByText('אין התראות.')).toBeVisible();
    expect(p.getByRole('button', { name: 'הגדרות התראות' })).toBeVisible();
  });

  it('clicking the gear closes the bell popover and opens the הגדרות התראות dialog, with the current OFF state', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(screen.getByTestId('notifications-button'));
    await user.click(within(panel()).getByRole('button', { name: 'הגדרות התראות' }));

    expect(document.querySelector('.popover-panel')).not.toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'הגדרות התראות' });
    expect(within(dialog).getByText('עדכונים תפעוליים')).toBeVisible();
    expect(within(dialog).getByText('פתיחה, עדכון, סגירה, פתיחה מחדש וביטול תקלות')).toBeVisible();
    const toggle = within(dialog).getByRole('switch', { name: 'עדכונים תפעוליים' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the persisted ON state when the profile already has the preference enabled', async () => {
    const seedUser = userEvent.setup();
    const seeding = render(<App />);
    await seedUser.click(await screen.findByTestId('login-u-admin'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    seeding.unmount();

    const raw = JSON.parse(localStorage.getItem('takalot-demo-db-v1')!);
    raw.profiles.find((p: { id: string }) => p.id === 'u-admin').operationalNotificationsEnabled = true;
    localStorage.setItem('takalot-demo-db-v1', JSON.stringify(raw));
    window.history.pushState({}, '', '/');
    vi.resetModules();
    App = (await import('../App')).default;

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    await user.click(screen.getByTestId('notifications-button'));
    await user.click(within(panel()).getByRole('button', { name: 'הגדרות התראות' }));

    const toggle = within(screen.getByRole('dialog', { name: 'הגדרות התראות' })).getByRole('switch', {
      name: 'עדכונים תפעוליים',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('a successful toggle inside the dialog persists through the repository and updates immediately', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(screen.getByTestId('notifications-button'));
    await user.click(within(panel()).getByRole('button', { name: 'הגדרות התראות' }));
    const dialog = screen.getByRole('dialog', { name: 'הגדרות התראות' });
    const toggle = within(dialog).getByRole('switch', { name: 'עדכונים תפעוליים' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    const raw = JSON.parse(localStorage.getItem('takalot-demo-db-v1')!);
    expect(raw.profiles.find((p: { id: string }) => p.id === 'u-admin').operationalNotificationsEnabled).toBe(true);
  });

  it('a failed toggle restores the previous state and surfaces the app error toast', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(screen.getByTestId('notifications-button'));
    await user.click(within(panel()).getByRole('button', { name: 'הגדרות התראות' }));
    const dialog = screen.getByRole('dialog', { name: 'הגדרות התראות' });
    const toggle = within(dialog).getByRole('switch', { name: 'עדכונים תפעוליים' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    const failure = new AppError('NETWORK', 'אירעה שגיאה בלתי צפויה מול השרת. הנתונים לא נשמרו — ניתן לנסות שוב.');
    const spy = vi
      .spyOn(hooks.repo(), 'setMyOperationalNotificationsEnabled')
      .mockRejectedValueOnce(failure);

    await user.click(toggle);
    await screen.findByText(failure.message);

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(screen.getByTestId('notifications-button'));
    await user.click(within(panel()).getByRole('button', { name: 'הגדרות התראות' }));
    expect(screen.getByRole('dialog', { name: 'הגדרות התראות' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'הגדרות התראות' })).not.toBeInTheDocument();
  });

  it('closes on an outside (backdrop) click, consistent with every other dialog in the app', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(screen.getByTestId('notifications-button'));
    await user.click(within(panel()).getByRole('button', { name: 'הגדרות התראות' }));
    const dialog = screen.getByRole('dialog', { name: 'הגדרות התראות' });
    const overlay = dialog.parentElement as HTMLElement;

    await user.click(overlay);
    expect(screen.queryByRole('dialog', { name: 'הגדרות התראות' })).not.toBeInTheDocument();
  });

  it('does not overflow a narrow mobile viewport, and never opens two competing floating panels at once', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    try {
      const user = await loginAs('login-u-admin');
      await user.click(screen.getByTestId('notifications-button'));
      expect(panel()).toBeInTheDocument();

      await user.click(within(panel()).getByRole('button', { name: 'הגדרות התראות' }));
      // The bell popover is gone the instant the dialog opens -- only one
      // floating panel is ever visible.
      expect(document.querySelector('.popover-panel')).not.toBeInTheDocument();

      // jsdom performs no real CSS layout, so a computed-pixel-width
      // assertion here would be meaningless -- instead this asserts the
      // structural class (`w-full`, the shared Dialog primitive's own
      // mobile-safe sizing, already used by every other dialog in the app)
      // that is what actually prevents horizontal overflow on a narrow
      // viewport.
      const dialog = screen.getByRole('dialog', { name: 'הגדרות התראות' });
      expect(dialog).toBeInTheDocument();
      expect(dialog.className).toMatch(/\bw-full\b/);
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: originalWidth });
      window.dispatchEvent(new Event('resize'));
    }
  });
});

// נקה הכל: persistent per-user dismissal, distinct from marking read. See
// migration 0048_notification_dismissal.sql (notifications.dismissed_at) and
// LocalDemoRepository.clearNotifications.
describe('NotificationsMenu: נקה הכל (clear all notifications)', () => {
  it('is hidden when the signed-in user has no notifications at all', async () => {
    const user = await loginAs('login-u-viewer');
    await user.click(screen.getByTestId('notifications-button'));
    const p = within(panel());
    expect(p.getByText('אין התראות.')).toBeVisible();
    expect(p.queryByRole('button', { name: 'ניקוי כל ההתראות' })).not.toBeInTheDocument();
  });

  it('appears when visible notifications exist; clearing empties every tab, zeroes the badge, shows a success toast, and persists across a fresh fetch', async () => {
    const seeding = render(<App />);
    const seedUser = userEvent.setup();
    await seedUser.click(await screen.findByTestId('login-u-tech-1'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    await seedUser.click(screen.getByTestId('notifications-button'));
    let p = within(panel());
    const clearButton = p.getByRole('button', { name: 'ניקוי כל ההתראות' });
    expect(clearButton).toBeVisible();

    await seedUser.click(clearButton);
    await screen.findByText('ההתראות נוקו');

    expect(screen.getByTestId('notifications-button')).toHaveAccessibleName('התראות');
    p = within(panel());
    expect(p.getByText('אין התראות.')).toBeVisible();
    expect(p.queryByRole('button', { name: 'ניקוי כל ההתראות' })).not.toBeInTheDocument();

    await seedUser.click(p.getByRole('button', { name: 'דורש פעולה' }));
    expect(within(panel()).getByText('אין התראות שדורשות פעולה.')).toBeVisible();
    await seedUser.click(within(panel()).getByRole('button', { name: 'עדכונים' }));
    expect(within(panel()).getByText('אין עדכונים.')).toBeVisible();
    seeding.unmount();

    // Persistence across a fresh repository fetch: unmount and re-render
    // (same technique as the update_overdue regression test above) --
    // the already-authenticated session survives separately from the
    // cleared demo database, so this lands straight back on the dashboard.
    window.history.pushState({}, '', '/');
    vi.resetModules();
    App = (await import('../App')).default;
    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    expect(screen.getByTestId('notifications-button')).toHaveAccessibleName('התראות');
    await userEvent.setup().click(screen.getByTestId('notifications-button'));
    expect(within(panel()).getByText('אין התראות.')).toBeVisible();
  });

  it('clearing affects only the current user -- another user’s notifications are unaffected', async () => {
    const seeding = render(<App />);
    const seedUser = userEvent.setup();
    await seedUser.click(await screen.findByTestId('login-u-tech-1'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    await seedUser.click(screen.getByTestId('notifications-button'));
    await seedUser.click(within(panel()).getByRole('button', { name: 'ניקוי כל ההתראות' }));
    await screen.findByText('ההתראות נוקו');
    seeding.unmount();

    // Sign out of tech1's persisted demo session (without touching the demo
    // database itself, which is where the just-cleared/still-active
    // notification rows live) so the login screen reappears for switching
    // to a different user.
    localStorage.removeItem('takalot-demo-session-user');
    window.history.pushState({}, '', '/');
    vi.resetModules();
    App = (await import('../App')).default;
    const manager = await loginAs('login-u-manager');
    await manager.click(screen.getByTestId('notifications-button'));
    expect(within(panel()).getByText('תקלה נפתחה')).toBeVisible();
  });

  it('a notification created after clearing appears normally', async () => {
    const seeding = render(<App />);
    const seedUser = userEvent.setup();
    await seedUser.click(await screen.findByTestId('login-u-tech-1'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    await seedUser.click(screen.getByTestId('notifications-button'));
    await seedUser.click(within(panel()).getByRole('button', { name: 'ניקוי כל ההתראות' }));
    await screen.findByText('ההתראות נוקו');
    seeding.unmount();

    const raw = JSON.parse(localStorage.getItem('takalot-demo-db-v1')!);
    raw.notifications.push({
      id: 'ntf-after-clear',
      userId: 'u-tech-1',
      type: 'incident_assigned',
      category: 'action_required',
      incidentId: 'inc-1',
      handoverId: null,
      text: 'תקלה חדשה הוקצתה אליך.',
      read: false,
      createdAt: new Date().toISOString(),
    });
    localStorage.setItem('takalot-demo-db-v1', JSON.stringify(raw));
    window.history.pushState({}, '', '/');
    vi.resetModules();
    App = (await import('../App')).default;
    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    await userEvent.setup().click(screen.getByTestId('notifications-button'));
    expect(within(panel()).getByText('תקלה חדשה הוקצתה אליך.')).toBeVisible();
  });

  it('mark-as-read keeps working after נקה הכל is used', async () => {
    const seeding = render(<App />);
    const seedUser = userEvent.setup();
    await seedUser.click(await screen.findByTestId('login-u-tech-1'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    await seedUser.click(screen.getByTestId('notifications-button'));
    await seedUser.click(within(panel()).getByRole('button', { name: 'ניקוי כל ההתראות' }));
    await screen.findByText('ההתראות נוקו');
    seeding.unmount();

    const raw = JSON.parse(localStorage.getItem('takalot-demo-db-v1')!);
    raw.notifications.push({
      id: 'ntf-mark-read-after-clear',
      userId: 'u-tech-1',
      type: 'incident_assigned',
      category: 'action_required',
      incidentId: 'inc-1',
      handoverId: null,
      text: 'התראה נוספת.',
      read: false,
      createdAt: new Date().toISOString(),
    });
    localStorage.setItem('takalot-demo-db-v1', JSON.stringify(raw));
    window.history.pushState({}, '', '/');
    vi.resetModules();
    App = (await import('../App')).default;
    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    const freshUser = userEvent.setup();
    expect(screen.getByTestId('notifications-button')).toHaveAccessibleName(/1 שלא נקראו/);
    await freshUser.click(screen.getByTestId('notifications-button'));
    await freshUser.click(within(panel()).getByRole('button', { name: 'סימון הכול כנקרא' }));
    expect(screen.getByTestId('notifications-button')).toHaveAccessibleName('התראות');
  });

  it('while clearing, the button disables and shows a loading label, preventing repeated submissions', async () => {
    const user = await loginAs('login-u-tech-1');
    let resolveClear: () => void = () => {};
    const spy = vi.spyOn(hooks.repo(), 'clearNotifications').mockImplementation(
      () => new Promise<void>((resolve) => { resolveClear = resolve; }),
    );

    await user.click(screen.getByTestId('notifications-button'));
    const clearButton = within(panel()).getByRole('button', { name: 'ניקוי כל ההתראות' });
    await user.click(clearButton);

    expect(clearButton).toBeDisabled();
    expect(clearButton).toHaveTextContent('מנקה');
    expect(spy).toHaveBeenCalledTimes(1);

    // A second click while pending must not fire a second call.
    await user.click(clearButton);
    expect(spy).toHaveBeenCalledTimes(1);

    resolveClear();
    await screen.findByText('ההתראות נוקו');
    await waitFor(() => expect(clearButton).not.toBeDisabled());
    expect(clearButton).toHaveTextContent('נקה הכל');
  });

  it('a failed clear preserves the current notifications and shows an understandable error', async () => {
    const user = await loginAs('login-u-tech-1');
    const failure = new AppError('NETWORK', 'אירעה שגיאה בלתי צפויה מול השרת. הנתונים לא נשמרו — ניתן לנסות שוב.');
    const spy = vi.spyOn(hooks.repo(), 'clearNotifications').mockRejectedValueOnce(failure);

    await user.click(screen.getByTestId('notifications-button'));
    await user.click(within(panel()).getByRole('button', { name: 'ניקוי כל ההתראות' }));
    await screen.findByText(failure.message);

    expect(spy).toHaveBeenCalledTimes(1);
    const p = within(panel());
    expect(p.getByText('תקלה הוקצתה אליך')).toBeVisible();
    expect(screen.getByTestId('notifications-button')).toHaveAccessibleName(/1 שלא נקראו/);
  });

  it('does not overflow a narrow mobile viewport', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    try {
      const user = await loginAs('login-u-tech-1');
      await user.click(screen.getByTestId('notifications-button'));
      const el = panel();
      expect(el).toBeInTheDocument();
      expect(within(el).getByRole('button', { name: 'ניקוי כל ההתראות' })).toBeVisible();
      const width = parseFloat(el.style.width);
      expect(width).toBeLessThanOrEqual(360);
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: originalWidth });
      window.dispatchEvent(new Event('resize'));
    }
  });
});
