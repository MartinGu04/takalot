// The redesigned bell notification center: filters (הכול / דורש פעולה /
// עדכונים), click-to-read-and-navigate, סימון הכול כנקרא, empty states per
// filter, and narrow-viewport rendering. Exercised through the real app
// with the demo repository and its real seeded notifications (see
// src/data/local/seed.ts: ntf-2 is tech1's unread personal incident_assigned
// notification (action_required); ntf-3 is the manager's read operational
// incident_opened notification (update)).
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';

let App: typeof AppType;
beforeEach(async () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  vi.resetModules();
  App = (await import('../App')).default;
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
