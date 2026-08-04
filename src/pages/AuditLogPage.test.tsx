// יומן ביקורת (system-wide audit log) page: navigation visibility, route
// protection, rendering, filters/pagination, and loading/empty states.
// Exercised through the real app (real routing/auth/demo repository), not a
// component-level mock, matching this repo's other page test conventions.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
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

describe('AuditLogPage: date filter clear (iPhone Safari native "איפוס" regression)', () => {
  // Regression for a bug where the מתאריך/עד תאריך date inputs used
  // `defaultValue` (uncontrolled): a defaultValue is only ever applied at
  // mount, so once the URL-derived filter value changed to empty, React
  // never pushed that change back onto the DOM node -- on iPhone Safari,
  // using the native date picker's "איפוס" action left the field showing
  // its previous value (or restored it on a later re-render) even though
  // the underlying filter state had already cleared. The fix makes the
  // inputs controlled (`value`), so the DOM is forced to match state on
  // every render. Each test below dispatches an empty-value change event
  // directly -- exactly what the native picker's clear action produces --
  // rather than relying on jsdom's (unreliable) native date-picker
  // simulation, and proves the QUERY itself (not just the field) is
  // cleared behaviorally: a bound chosen to exclude every existing row
  // must produce the empty state, and clearing it must bring every row
  // back -- a stale filter still silently applied would leave the list
  // empty even after the field and URL look cleared.
  it('clearing מתאריך empties the field, removes it from the URL, and lets the query see all rows again', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openAuditLog(user, 'login-u-admin');

    // Baseline: at least one row is visible unfiltered.
    await screen.findByRole('list');

    const fromInput = screen.getByLabelText('מתאריך') as HTMLInputElement;
    // A far-future lower bound excludes every existing row -- proves the
    // date constraint really reaches the query, not just the URL.
    fireEvent.change(fromInput, { target: { value: '2099-01-01' } });
    await waitFor(() => expect(fromInput).toHaveValue('2099-01-01'));
    expect(new URLSearchParams(window.location.search).get('from')).toBe('2099-01-01');
    await screen.findByText('אין רישומים התואמים לסינון');

    // Simulate the native picker's clear action: it dispatches a change
    // event with an empty value, the same as this fireEvent call.
    fireEvent.change(fromInput, { target: { value: '' } });

    // The field itself must visibly empty -- the actual regression.
    await waitFor(() => expect(fromInput).toHaveValue(''));
    // Removed from local/URL state, not just left blank on screen.
    expect(new URLSearchParams(window.location.search).has('from')).toBe(false);
    // The audit query must refresh without the date constraint: rows that
    // the far-future bound excluded must reappear.
    await screen.findByRole('list');
    expect(screen.queryByText('אין רישומים התואמים לסינון')).not.toBeInTheDocument();
  });

  it('clearing עד תאריך empties the field, removes it from the URL, and lets the query see all rows again', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openAuditLog(user, 'login-u-admin');

    await screen.findByRole('list');

    const toInput = screen.getByLabelText('עד תאריך') as HTMLInputElement;
    // A far-past upper bound excludes every existing row.
    fireEvent.change(toInput, { target: { value: '1990-01-01' } });
    await waitFor(() => expect(toInput).toHaveValue('1990-01-01'));
    expect(new URLSearchParams(window.location.search).get('to')).toBe('1990-01-01');
    await screen.findByText('אין רישומים התואמים לסינון');

    fireEvent.change(toInput, { target: { value: '' } });

    await waitFor(() => expect(toInput).toHaveValue(''));
    expect(new URLSearchParams(window.location.search).has('to')).toBe(false);
    await screen.findByRole('list');
    expect(screen.queryByText('אין רישומים התואמים לסינון')).not.toBeInTheDocument();
  });

  it('clearing one date field never alters the other', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openAuditLog(user, 'login-u-admin');

    const fromInput = screen.getByLabelText('מתאריך') as HTMLInputElement;
    const toInput = screen.getByLabelText('עד תאריך') as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: '2020-01-15' } });
    await waitFor(() => expect(fromInput).toHaveValue('2020-01-15'));
    fireEvent.change(toInput, { target: { value: '2020-01-20' } });
    await waitFor(() => expect(toInput).toHaveValue('2020-01-20'));

    fireEvent.change(fromInput, { target: { value: '' } });

    await waitFor(() => expect(fromInput).toHaveValue(''));
    // עד תאריך is completely untouched by clearing מתאריך.
    expect(toInput).toHaveValue('2020-01-20');
    expect(new URLSearchParams(window.location.search).get('to')).toBe('2020-01-20');
    expect(new URLSearchParams(window.location.search).has('from')).toBe(false);
  });
});
