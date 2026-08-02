// ניתוחים (Analytics): the ניתוח תקלות operational analytics page, exposed
// to every authenticated role with no capability gate (same access as the
// former דוחות placeholder it replaces). Exercised through the real app
// (real routing/auth guard, real local/demo repository and RPC-equivalent
// analytics computation), not a page-level unit mock.
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

async function login(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await user.click(await screen.findByTestId(testId));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
}

async function goToAnalytics(user: ReturnType<typeof userEvent.setup>) {
  const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
  await user.click(within(sidebar).getByRole('link', { name: 'ניתוחים' }));
  await screen.findByRole('heading', { name: 'ניתוח תקלות' });
}

describe('Analytics navigation destination', () => {
  it('renders the ניתוחים destination in both the desktop sidebar and the mobile bottom nav for an authenticated user', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');

    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    expect(within(sidebar).getByRole('link', { name: 'ניתוחים' })).toBeInTheDocument();

    const bottomNav = screen.getByRole('navigation', { name: 'ניווט תחתון' });
    expect(within(bottomNav).getByRole('link', { name: 'ניתוחים' })).toBeInTheDocument();
  });

  it.each([
    ['system_admin', 'login-u-admin'],
    ['professional_manager', 'login-u-manager'],
    ['shift_supervisor', 'login-u-supervisor-1'],
    ['technician', 'login-u-tech-1'],
    ['viewer', 'login-u-viewer'],
  ])('exposes ניתוחים to the %s role with no restriction', async (_role, testId) => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, testId);

    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    expect(within(sidebar).getByRole('link', { name: 'ניתוחים' })).toBeInTheDocument();
  });

  it('navigates to the analytics route and marks active-route state correctly', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');

    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    const analyticsLink = within(sidebar).getByRole('link', { name: 'ניתוחים' });
    expect(analyticsLink).not.toHaveAttribute('aria-current', 'page');
    const dashboardLink = within(sidebar).getByRole('link', { name: 'מצב נוכחי' });
    expect(dashboardLink).toHaveAttribute('aria-current', 'page');

    await user.click(analyticsLink);
    await screen.findByRole('heading', { name: 'ניתוח תקלות' });

    expect(analyticsLink).toHaveAttribute('aria-current', 'page');
    expect(dashboardLink).not.toHaveAttribute('aria-current', 'page');
  });

  it('is reachable by direct route access for an already-authenticated session', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-supervisor-1');

    // Simulate a deep link / refresh landing straight on /reports.
    window.history.pushState({}, '', '/reports');
    render(<App />);

    await screen.findByRole('heading', { name: 'ניתוח תקלות' });
    expect(screen.queryByText('אין הרשאה')).not.toBeInTheDocument();
  });

  it('redirects an unauthenticated direct visit to /reports to the login screen', async () => {
    window.history.pushState({}, '', '/reports');
    render(<App />);

    await screen.findByRole('heading', { name: 'AVARIA' });
    expect(screen.queryByRole('heading', { name: 'ניתוח תקלות' })).not.toBeInTheDocument();
  });
});

describe('Analytics page content', () => {
  it('renders the subtitle, all six KPI labels, the trend chart section and the top-systems section against real seeded data', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');
    await goToAnalytics(user);

    expect(screen.getByText('מגמות, ביצועים ונקודות שדורשות תשומת לב')).toBeInTheDocument();

    for (const label of ['נפתחו בתקופה', 'נסגרו בתקופה', 'זמן ממוצע לסגירה', 'פתוחות עכשיו', 'כמה זמן הן פתוחות', 'נפתחו מחדש']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    expect(screen.getByRole('heading', { name: 'פתיחת וסגירת תקלות' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'מערכות עם הכי הרבה תקלות' })).toBeInTheDocument();

    // Out-of-scope terms must never appear on this page.
    expect(screen.queryByText('עדכונים באיחור')).not.toBeInTheDocument();
    expect(screen.queryByText('העברת משמרת')).not.toBeInTheDocument();
  });

  it('defaults to a 30-day period with no system/location/severity filter applied', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');
    await goToAnalytics(user);

    const periodGroup = screen.getByRole('group', { name: 'תקופה' });
    expect(within(periodGroup).getByRole('button', { name: '30 ימים' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(periodGroup).getByRole('button', { name: '7 ימים' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(periodGroup).getByRole('button', { name: '90 ימים' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('changing the period updates the URL and the pressed segmented-control state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');
    await goToAnalytics(user);

    const periodGroup = screen.getByRole('group', { name: 'תקופה' });
    await user.click(within(periodGroup).getByRole('button', { name: '7 ימים' }));

    expect(within(periodGroup).getByRole('button', { name: '7 ימים' })).toHaveAttribute('aria-pressed', 'true');
    expect(new URLSearchParams(window.location.search).get('period')).toBe('7');
  });

  it('reset clears the URL filter params and restores the default period', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');
    await goToAnalytics(user);

    const periodGroup = screen.getByRole('group', { name: 'תקופה' });
    await user.click(within(periodGroup).getByRole('button', { name: '90 ימים' }));
    expect(new URLSearchParams(window.location.search).get('period')).toBe('90');

    await user.click(screen.getByRole('button', { name: 'איפוס סינונים' }));

    expect(window.location.search).toBe('');
    expect(within(periodGroup).getByRole('button', { name: '30 ימים' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Analytics page: malformed URL filter params fall back safely', () => {
  async function loginThenVisit(user: ReturnType<typeof userEvent.setup>, query: string) {
    await login(user, 'login-u-viewer');
    window.history.pushState({}, '', `/reports${query}`);
    render(<App />);
    await screen.findByRole('heading', { name: 'ניתוח תקלות' });
  }

  it('an invalid period value falls back to 30 days and is stripped from the URL, without rendering the error state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?period=999');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const periodGroup = screen.getByRole('group', { name: 'תקופה' });
    expect(within(periodGroup).getByRole('button', { name: '30 ימים' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('period')).toBe(false));
    expect(screen.getByText('נפתחו בתקופה')).toBeInTheDocument();
  });

  it('an invalid severity value is ignored and stripped from the URL, without rendering the error state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?severity=bogus');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('severity')).toBe(false));
    expect(screen.getByText('נפתחו בתקופה')).toBeInTheDocument();
  });

  it('a malformed system UUID is ignored and stripped from the URL, without rendering the error state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?system=not-a-uuid');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('system')).toBe(false));
    expect(screen.getByText('נפתחו בתקופה')).toBeInTheDocument();
  });

  it('a malformed location UUID is ignored and stripped from the URL, without rendering the error state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?location=not-a-uuid');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('location')).toBe(false));
    expect(screen.getByText('נפתחו בתקופה')).toBeInTheDocument();
  });

  it('a valid filter alongside an invalid one is preserved while only the invalid one is stripped', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?period=7&severity=bogus');

    await waitFor(() => expect(new URLSearchParams(window.location.search).has('severity')).toBe(false));
    expect(new URLSearchParams(window.location.search).get('period')).toBe('7');
    const periodGroup = screen.getByRole('group', { name: 'תקופה' });
    expect(within(periodGroup).getByRole('button', { name: '7 ימים' })).toHaveAttribute('aria-pressed', 'true');
  });
});
