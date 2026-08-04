// The system_admin-only "עדכונים תפעוליים" opt-in switch: role gating on
// both desktop (Sidebar account card) and mobile (user menu), persisted
// initial state, successful/failed toggling, pending-disable, and switch
// accessibility semantics. Exercised through the real app with the demo
// repository (see src/data/local/seed.ts: DEMO_USERS.admin starts OFF).
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

function desktopSidebar(): HTMLElement {
  return document.querySelector('aside') as HTMLElement;
}

async function openMobileUserMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'תפריט משתמש' }));
  return document.querySelector('.popover-panel') as HTMLElement;
}

describe('OperationalNotificationsSwitch: role gating', () => {
  it('renders for system_admin on the desktop sidebar, OFF by default', async () => {
    await loginAs('login-u-admin');
    const sidebar = within(desktopSidebar());
    expect(sidebar.getByText('עדכונים תפעוליים')).toBeVisible();
    expect(sidebar.getByText('פתיחה, עדכון, סגירה, פתיחה מחדש וביטול תקלות')).toBeVisible();
    const toggle = sidebar.getByRole('switch', { name: 'עדכונים תפעוליים' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('renders for system_admin inside the mobile user menu, after the display-theme row', async () => {
    const user = await loginAs('login-u-admin');
    const panel = await openMobileUserMenu(user);
    const p = within(panel);
    const rows = Array.from(panel.querySelectorAll('span, button')).map((el) => el.textContent);
    const themeIndex = rows.findIndex((t) => t === 'מצב תצוגה');
    const switchLabelIndex = rows.findIndex((t) => t === 'עדכונים תפעוליים');
    expect(themeIndex).toBeGreaterThan(-1);
    expect(switchLabelIndex).toBeGreaterThan(themeIndex);
    expect(p.getByRole('switch', { name: 'עדכונים תפעוליים' })).toBeInTheDocument();
  });

  it.each([
    ['professional_manager', 'login-u-manager'],
    ['shift_supervisor', 'login-u-supervisor-1'],
    ['technician', 'login-u-tech-1'],
    ['viewer', 'login-u-viewer'],
  ])('does not render for %s, on desktop or in the mobile user menu', async (_role, testId) => {
    const user = await loginAs(testId);
    expect(screen.queryByText('עדכונים תפעוליים')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'עדכונים תפעוליים' })).not.toBeInTheDocument();

    const mobileMenuButton = screen.queryByRole('button', { name: 'תפריט משתמש' });
    if (mobileMenuButton) {
      await user.click(mobileMenuButton);
      expect(screen.queryByText('עדכונים תפעוליים')).not.toBeInTheDocument();
    }
  });
});

describe('OperationalNotificationsSwitch: initial state reflects persisted data', () => {
  it('shows ON when the seeded profile already has the preference enabled', async () => {
    const seedUser = userEvent.setup();
    const seeding = render(<App />);
    await seedUser.click(await screen.findByTestId('login-u-admin'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    seeding.unmount();

    const raw = JSON.parse(localStorage.getItem('takalot-demo-db-v1')!);
    const admin = raw.profiles.find((p: { id: string }) => p.id === 'u-admin');
    admin.operationalNotificationsEnabled = true;
    localStorage.setItem('takalot-demo-db-v1', JSON.stringify(raw));
    window.history.pushState({}, '', '/');
    vi.resetModules();
    App = (await import('../App')).default;

    render(<App />);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    const toggle = within(desktopSidebar()).getByRole('switch', { name: 'עדכונים תפעוליים' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});

describe('OperationalNotificationsSwitch: toggling', () => {
  it('a successful toggle persists through the repository and updates the UI immediately, without reload', async () => {
    const user = await loginAs('login-u-admin');
    const toggle = within(desktopSidebar()).getByRole('switch', { name: 'עדכונים תפעוליים' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    const raw = JSON.parse(localStorage.getItem('takalot-demo-db-v1')!);
    const admin = raw.profiles.find((p: { id: string }) => p.id === 'u-admin');
    expect(admin.operationalNotificationsEnabled).toBe(true);
  });

  it('a failed toggle restores the previous visual state and shows the app error toast', async () => {
    const user = await loginAs('login-u-admin');
    const toggle = within(desktopSidebar()).getByRole('switch', { name: 'עדכונים תפעוליים' });
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

  it('disables the switch while the mutation is pending, and re-enables it after it settles', async () => {
    const user = await loginAs('login-u-admin');
    const toggle = within(desktopSidebar()).getByRole('switch', { name: 'עדכונים תפעוליים' });

    let resolveMutation!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveMutation = resolve;
    });
    vi.spyOn(hooks.repo(), 'setMyOperationalNotificationsEnabled').mockReturnValueOnce(pending as never);

    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());

    resolveMutation({
      id: 'u-admin',
      fullName: 'אלון ברק (דמו)',
      role: 'system_admin',
      active: true,
      createdAt: new Date().toISOString(),
      operationalNotificationsEnabled: true,
    });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });
});

describe('OperationalNotificationsSwitch: accessibility', () => {
  it('exposes correct switch semantics and is keyboard operable', async () => {
    const user = await loginAs('login-u-admin');
    const toggle = within(desktopSidebar()).getByRole('switch', { name: 'עדכונים תפעוליים' });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    toggle.focus();
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });
});
