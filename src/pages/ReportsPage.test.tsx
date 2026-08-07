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
  it('renders the subtitle, all six KPI labels, the trend chart section and both ranking sections against real seeded data', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');
    await goToAnalytics(user);

    expect(screen.getByText('מגמות, ביצועים ונקודות שדורשות תשומת לב')).toBeInTheDocument();

    // "נפתחו בתקופה" and "זמן טיפול חציוני" legitimately also label a column
    // in each ranking panel below (RankingList) -- getAllByText, not
    // getByText, for every label in this shared loop.
    for (const label of ['נפתחו בתקופה', 'נסגרו בתקופה', 'זמן טיפול חציוני', 'פתוחות עכשיו', 'משך פתיחה ממוצע', 'נפתחו מחדש']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    expect(screen.getByRole('heading', { name: 'פתיחת וסגירת תקלות' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'מערכות עם הכי הרבה תקלות' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'מיקומים עם הכי הרבה תקלות' })).toBeInTheDocument();

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

describe('Analytics page: system/location ranking panels', () => {
  it('renders both panel titles and their subtitle, and lays them out in a responsive side-by-side/stacked grid', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');
    await goToAnalytics(user);

    const systemsHeading = screen.getByRole('heading', { name: 'מערכות עם הכי הרבה תקלות' });
    const locationsHeading = screen.getByRole('heading', { name: 'מיקומים עם הכי הרבה תקלות' });
    expect(systemsHeading).toBeInTheDocument();
    expect(locationsHeading).toBeInTheDocument();

    // Same subtitle text for both panels -- one occurrence each.
    expect(screen.getAllByText('דירוג לפי מספר התקלות שנפתחו בתקופה שנבחרה')).toHaveLength(2);

    // Both panel <section>s share one responsive grid wrapper: stacked by
    // default, side by side from lg: up -- never a separate desktop-only
    // vs. mobile-only DOM branch.
    const systemsSection = systemsHeading.closest('section') as HTMLElement;
    const locationsSection = locationsHeading.closest('section') as HTMLElement;
    const wrapper = systemsSection.parentElement as HTMLElement;
    expect(wrapper).toContainElement(locationsSection);
    expect(wrapper.className).toMatch(/\bgrid\b/);
    expect(wrapper.className).toMatch(/\blg:grid-cols-2\b/);
  });

  it('changing a filter (period) refetches the same analytics query and both ranking panels stay in sync with it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');
    await goToAnalytics(user);

    const systemsHeading = screen.getByRole('heading', { name: 'מערכות עם הכי הרבה תקלות' });
    const locationsHeading = screen.getByRole('heading', { name: 'מיקומים עם הכי הרבה תקלות' });

    const periodGroup = screen.getByRole('group', { name: 'תקופה' });
    await user.click(within(periodGroup).getByRole('button', { name: '7 ימים' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('period')).toBe('7'));

    // Both panels are still present and rendering (their own row content or
    // their own independent empty state) after the SAME single analytics
    // query re-ran for the new period -- neither panel silently disappears
    // or breaks the other.
    expect(screen.getByRole('heading', { name: 'מערכות עם הכי הרבה תקלות' })).toBe(systemsHeading);
    expect(screen.getByRole('heading', { name: 'מיקומים עם הכי הרבה תקלות' })).toBe(locationsHeading);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
    expect(screen.getAllByText('נפתחו בתקופה').length).toBeGreaterThan(0);
  });

  it('an invalid severity value is ignored and stripped from the URL, without rendering the error state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?severity=bogus');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('severity')).toBe(false));
    expect(screen.getAllByText('נפתחו בתקופה').length).toBeGreaterThan(0);
  });

  it('a malformed system UUID is ignored and stripped from the URL, without rendering the error state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?system=not-a-uuid');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('system')).toBe(false));
    expect(screen.getAllByText('נפתחו בתקופה').length).toBeGreaterThan(0);
  });

  it('a malformed location UUID is ignored and stripped from the URL, without rendering the error state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?location=not-a-uuid');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('location')).toBe(false));
    expect(screen.getAllByText('נפתחו בתקופה').length).toBeGreaterThan(0);
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

  it('a comma-joined severity list with one bad entry keeps the valid entries and strips only the bad one', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?severity=critical,bogus,high');

    await waitFor(() => expect(new URLSearchParams(window.location.search).get('severity')).toBe('critical,high'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an invalid domain entry is stripped per-entry from a comma-joined list', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?domain=equipment,not-a-real-domain');

    await waitFor(() => expect(new URLSearchParams(window.location.search).get('domain')).toBe('equipment'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an unclassified param value other than "1" is stripped, without rejecting the rest of the URL', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginThenVisit(user, '?unclassified=yes');

    await waitFor(() => expect(new URLSearchParams(window.location.search).has('unclassified')).toBe(false));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Analytics page: multi-select filter URL round-trip', () => {
  it('picking severity, domain, confirmed-cause and treatment-outcome filters through the UI persists them all in the URL', async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await login(user, 'login-u-viewer');
    await goToAnalytics(user);

    await user.selectOptions(screen.getByLabelText('סינון לפי חומרה'), 'critical');
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('severity')).toBe('critical'));

    await user.click(screen.getByRole('button', { name: /^סינון מתקדם/ }));
    await user.selectOptions(screen.getByLabelText('סינון לפי תחום'), 'equipment');
    await user.click(screen.getByText('לא סווג בעת פתיחת התקלה'));
    await user.selectOptions(screen.getByLabelText('סינון לפי גורם שאומת'), 'equipment');
    await user.selectOptions(screen.getByLabelText('סינון לפי תוצאת טיפול'), 'permanent_resolution');

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get('domain')).toBe('equipment');
      expect(params.get('unclassified')).toBe('1');
      expect(params.get('confirmedCause')).toBe('equipment');
      expect(params.get('treatmentOutcome')).toBe('permanent_resolution');
    });

    // A reload from this exact URL must reproduce the same applied chips
    // (round-trip), not just accept the write side. Unmount the first tree
    // first -- otherwise both trees stay mounted side by side and every
    // query below matches twice, which isn't the real reload scenario this
    // test wants (a single fresh app instance reading a URL it didn't write).
    first.unmount();
    render(<App />);
    await screen.findByRole('heading', { name: 'ניתוח תקלות' });
    expect(screen.getByRole('button', { name: 'הסרת סינון: קריטית' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^סינון מתקדם/ }));
    expect(screen.getAllByRole('button', { name: 'הסרת סינון: ציוד או חומרה' })).toHaveLength(2);
    expect(screen.getByText('לא סווג בעת פתיחת התקלה').closest('button')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Analytics page: personalization ("התאמת התצוגה")', () => {
  it.each([
    ['system_admin', 'login-u-admin', true],
    ['professional_manager', 'login-u-manager', true],
    ['shift_supervisor', 'login-u-supervisor-1', true],
    ['technician', 'login-u-tech-1', false],
    ['viewer', 'login-u-viewer', false],
  ])('the "התאמת התצוגה" trigger is rendered for %s exactly when eligible', async (_role, testId, eligible) => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, testId);
    await goToAnalytics(user);

    const trigger = screen.queryByRole('button', { name: 'התאמת התצוגה' });
    if (eligible) expect(trigger).toBeInTheDocument();
    else expect(trigger).not.toBeInTheDocument();
  });

  it('a shift_supervisor with no stored preference sees exactly their role default modules (trend + age distribution, not the rankings/closures/external panels)', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-supervisor-1');
    await goToAnalytics(user);

    expect(await screen.findByRole('heading', { name: 'פתיחת וסגירת תקלות' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'גיל תקלות פתוחות' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'מערכות עם הכי הרבה תקלות' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'מיקומים עם הכי הרבה תקלות' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'סיווג סגירות' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'מעורבות גורם חיצוני' })).not.toBeInTheDocument();

    // The KPI row itself is never personalizable -- always present regardless.
    expect(screen.getAllByText('נפתחו בתקופה').length).toBeGreaterThan(0);
  });

  it('turning a module off, saving, and reloading persists the choice (round-trips through the repository, not just local component state)', async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await login(user, 'login-u-admin'); // system_admin starts with every module visible
    await goToAnalytics(user);

    expect(await screen.findByRole('heading', { name: 'סיווג סגירות' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'התאמת התצוגה' }));
    const dialog = screen.getByRole('dialog', { name: 'התאמת התצוגה' });
    await user.click(within(dialog).getByRole('switch', { name: 'סיווג סגירות' }));
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'סיווג סגירות' })).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Reload from scratch (fresh app instance) -- the hidden module must
    // still be hidden, proving it was actually persisted, not just held in
    // this render's component state.
    first.unmount();
    render(<App />);
    await screen.findByRole('heading', { name: 'ניתוח תקלות' });
    expect(screen.queryByRole('heading', { name: 'סיווג סגירות' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'מעורבות גורם חיצוני' })).toBeInTheDocument();
  });

  // Deliberately does NOT assume system_admin starts with every module
  // visible: the repository and the QueryClient in App.tsx are both
  // module-level singletons (see src/data/index.ts's cached `instance` and
  // App.tsx's module-scope `queryClient`), so `localStorage.clear()` in
  // beforeEach resets the persisted bytes but not an already-constructed
  // demo repository's in-memory state or the query cache -- a prior test
  // in this file that mutated u-admin's stored preference is still in
  // effect here. Toggling one switch to an arbitrary state and then
  // resetting proves the reset behavior regardless of that ambient state:
  // the outcome (every module visible) is deterministic either way.
  it('"אפס לברירת מחדל" followed by "שמירה" restores every module for a system_admin, regardless of the draft in progress', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');
    await goToAnalytics(user);

    await user.click(screen.getByRole('button', { name: 'התאמת התצוגה' }));
    const dialog = screen.getByRole('dialog', { name: 'התאמת התצוגה' });
    await user.click(within(dialog).getByRole('switch', { name: 'סיווג סגירות' }));
    await user.click(within(dialog).getByRole('button', { name: 'אפס לברירת מחדל' }));
    for (const label of [
      'פתיחת וסגירת תקלות',
      'גיל תקלות פתוחות',
      'מערכות עם הכי הרבה תקלות',
      'מיקומים עם הכי הרבה תקלות',
      'סיווג סגירות',
      'מעורבות גורם חיצוני',
    ]) {
      expect(within(dialog).getByRole('switch', { name: label })).toHaveAttribute('aria-checked', 'true');
    }
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'סיווג סגירות' })).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'מעורבות גורם חיצוני' })).toBeInTheDocument();
  });

  // Uses professional_manager (u-manager), not system_admin -- a user no
  // other test in this describe block mutates -- so this test's starting
  // assumption ("סיווג סגירות" visible by role default) holds regardless of
  // what any earlier test did to a DIFFERENT user, for the same singleton-
  // sharing reason noted above.
  it('cancelling the dialog leaves the page exactly as it was, with no module hidden or shown', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-manager');
    await goToAnalytics(user);

    expect(await screen.findByRole('heading', { name: 'סיווג סגירות' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'התאמת התצוגה' }));
    const dialog = screen.getByRole('dialog', { name: 'התאמת התצוגה' });
    await user.click(within(dialog).getByRole('switch', { name: 'סיווג סגירות' }));
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'סיווג סגירות' })).toBeInTheDocument();
  });
});
