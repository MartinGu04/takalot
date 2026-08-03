// יומן ביקורת (system-wide audit log) page: navigation visibility, route
// protection, rendering, filters/pagination, and loading/empty states.
// Exercised through the real app (real routing/auth/demo repository), not a
// component-level mock, matching this repo's other page test conventions.
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';
import type * as hooksType from '../data/hooks';
import { DEMO_USERS } from '../data/local/seed';

let App: typeof AppType;
let hooks: typeof hooksType;
beforeEach(async () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  // Fresh module graph per test: App.tsx's QueryClient and the demo
  // repository are both module-level singletons, so a stale cache or
  // leftover mutations from an earlier test would otherwise leak in.
  const { vi } = await import('vitest');
  vi.resetModules();
  App = (await import('../App')).default;
  hooks = await import('../data/hooks');
});

async function login(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await user.click(await screen.findByTestId(testId));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
}

describe('AuditLogPage: navigation visibility', () => {
  it.each([
    ['professional_manager', 'login-u-manager'],
    ['system_admin', 'login-u-admin'],
  ])('%s sees the יומן ביקורת destination in navigation', async (_role, testId) => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, testId);
    expect(screen.getAllByRole('link', { name: 'יומן ביקורת' }).length).toBeGreaterThan(0);
  });

  it.each([
    ['shift_supervisor', 'login-u-supervisor-1'],
    ['technician', 'login-u-tech-1'],
    ['viewer', 'login-u-viewer'],
  ])('%s never sees the יומן ביקורת destination in navigation', async (_role, testId) => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, testId);
    expect(screen.queryByRole('link', { name: 'יומן ביקורת' })).not.toBeInTheDocument();
  });
});

describe('AuditLogPage: route protection', () => {
  it.each([
    ['shift_supervisor', 'login-u-supervisor-1'],
    ['technician', 'login-u-tech-1'],
    ['viewer', 'login-u-viewer'],
  ])('%s is rejected by direct navigation to /audit-log even without a nav link', async (_role, testId) => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, testId);

    // Simulate a deep link / refresh landing straight on /audit-log while
    // already authenticated (session persists in localStorage).
    window.history.pushState({}, '', '/audit-log');
    render(<App />);
    await screen.findByRole('heading', { name: 'אין הרשאה' });
    expect(screen.queryByRole('heading', { name: 'יומן ביקורת' })).not.toBeInTheDocument();
  });

  it.each([
    ['professional_manager', 'login-u-manager'],
    ['system_admin', 'login-u-admin'],
  ])('%s can reach /audit-log directly', async (_role, testId) => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, testId);

    window.history.pushState({}, '', '/audit-log');
    render(<App />);
    await screen.findByRole('heading', { name: 'יומן ביקורת' });
    expect(screen.queryByRole('heading', { name: 'אין הרשאה' })).not.toBeInTheDocument();
  });
});

async function openAuditLog(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await login(user, testId);
  await user.click(screen.getAllByRole('link', { name: 'יומן ביקורת' })[0]);
  await screen.findByRole('heading', { name: 'יומן ביקורת' });
}

describe('AuditLogPage: loading, empty, and rendering', () => {
  it('shows a loading state before the first page resolves', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');
    await user.click(screen.getAllByRole('link', { name: 'יומן ביקורת' })[0]);
    // The heading commits synchronously with navigation; the query itself
    // resolves on a later microtask, so the loading state is observable
    // in between for at least one render.
    expect(await screen.findByRole('status')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('shows an empty state when a filter matches nothing', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openAuditLog(user, 'login-u-admin');

    const search = screen.getByLabelText('חיפוש');
    await user.type(search, 'no-such-entity-xyz');
    await screen.findByText('אין רישומים התואמים לסינון');
  });

  it('renders a real mutation as a labeled, human-readable event with its entity label', async () => {
    const user = userEvent.setup();
    render(<App />);
    // Generate a fresh, distinctive audit event via a real mutation, exactly
    // as a user would trigger it -- not a fixture inserted directly into the
    // audit log.
    await hooks.repo().renameSystem({ userId: DEMO_USERS.admin, role: 'system_admin' }, 'sys-alpha', 'מערכת אלפא החדשה');

    await openAuditLog(user, 'login-u-admin');
    const list = await screen.findByRole('list');
    const row = (await within(list).findByText('שינוי שם מערכת / עמדה')).closest('li');
    expect(row).toBeTruthy();
    expect(within(row!).getByText('מערכת / עמדה · מערכת אלפא החדשה')).toBeInTheDocument();
  });

  it('expands to show previous and new values, and collapses again', async () => {
    const user = userEvent.setup();
    render(<App />);
    await hooks.repo().renameSystem({ userId: DEMO_USERS.admin, role: 'system_admin' }, 'sys-alpha', 'מערכת אלפא החדשה');

    await openAuditLog(user, 'login-u-admin');
    const list = await screen.findByRole('list');
    const row = (await within(list).findByText('שינוי שם מערכת / עמדה')).closest('li');
    const toggle = within(row!).getByRole('button', { name: 'הצגת פרטים' });
    await user.click(toggle);

    expect(within(row!).getByText('לפני')).toBeInTheDocument();
    expect(within(row!).getByText('אחרי')).toBeInTheDocument();
    expect(within(row!).getByText('מערכת אלפא')).toBeInTheDocument(); // old name, in the "before" block
    expect(within(row!).getByRole('button', { name: 'הסתרת פרטים' })).toBeInTheDocument();

    await user.click(within(row!).getByRole('button', { name: 'הסתרת פרטים' }));
    expect(within(row!).queryByText('לפני')).not.toBeInTheDocument();
  });

  it('filters by entity type', async () => {
    const user = userEvent.setup();
    render(<App />);
    await hooks.repo().renameSystem({ userId: DEMO_USERS.admin, role: 'system_admin' }, 'sys-alpha', 'מערכת אלפא החדשה');
    await hooks.repo().setUserRole({ userId: DEMO_USERS.admin, role: 'system_admin' }, DEMO_USERS.tech1, 'shift_supervisor');

    await openAuditLog(user, 'login-u-admin');
    const list = await screen.findByRole('list');
    await within(list).findByText('שינוי שם מערכת / עמדה');
    await within(list).findByText('שינוי תפקיד');

    await user.selectOptions(screen.getByLabelText('סוג ישות'), 'system');
    await waitFor(() => expect(within(list).queryByText('שינוי תפקיד')).not.toBeInTheDocument());
    expect(within(list).getByText('שינוי שם מערכת / עמדה')).toBeInTheDocument();
  });
});

describe('AuditLogPage: pagination', () => {
  it('paginates once results exceed one page, and the page control moves between pages', async () => {
    const user = userEvent.setup();
    render(<App />);
    const session = { userId: DEMO_USERS.admin, role: 'system_admin' as const };
    // 30 distinct system_created events -- comfortably over the page size,
    // generated through the same repository path a real create action uses.
    for (let i = 0; i < 30; i++) {
      await hooks.repo().createSystem(session, `מערכת בדיקת עימוד ${i}`, 'other');
    }

    await openAuditLog(user, 'login-u-admin');
    const list = await screen.findByRole('list');
    await within(list).findAllByText('הוספת מערכת / עמדה');
    expect(within(list).getAllByRole('listitem')).toHaveLength(25);
    expect(screen.getByText(/עמוד 1 מתוך/)).toBeInTheDocument();

    const next = screen.getByRole('button', { name: 'הבא' });
    expect(next).toBeEnabled();
    await user.click(next);
    await waitFor(() => expect(screen.getByText(/עמוד 2 מתוך/)).toBeInTheDocument());

    const prev = screen.getByRole('button', { name: 'הקודם' });
    expect(prev).toBeEnabled();
  });

  it('does not show pagination controls when everything fits on one page', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openAuditLog(user, 'login-u-admin');
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'הבא' })).not.toBeInTheDocument();
  });
});
