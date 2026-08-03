// Incident-creation vertical slice (Chapter 2): real app, real demo
// repository -- exercises UI -> repository -> local "RPC" -> refetch ->
// display -> timeline end to end, mirroring the established pattern from
// IncidentDetailPage.test.tsx / ArchivePage.test.tsx.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';

let App: typeof AppType;
beforeEach(async () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  vi.resetModules();
  App = (await import('../App')).default;
});

function main(): HTMLElement {
  return document.querySelector('main') as HTMLElement;
}

async function loginAs(userTestId: string) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByTestId(userTestId));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
  return user;
}

async function goToCreatePage(user: ReturnType<typeof userEvent.setup>) {
  const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' }).closest('aside') as HTMLElement;
  await user.click(within(sidebar).getByRole('link', { name: 'פתיחת תקלה' }));
  await within(main()).findByRole('heading', { name: 'פתיחת תקלה' });
}

async function fillMinimalValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText(/^מערכת \/ עמדה/), 'sys-alpha');
  await user.selectOptions(screen.getByLabelText(/^מיקום/), 'loc-1');
  await user.type(screen.getByLabelText(/^תיאור התקלה/), 'תקלה לצורך בדיקה אוטומטית');
  await user.type(screen.getByLabelText(/^השפעה מבצעית/), 'השפעה לצורך בדיקה אוטומטית');
  await user.type(screen.getByLabelText(/^פעולות שבוצעו עד כה/), 'נבדק ראשונית לצורך הבדיקה');
  await user.selectOptions(screen.getByLabelText(/^בעל אחריות פנימי/), 'u-tech-1');
}

// A successful creation stays on this page and shows the WhatsApp
// notification-copy modal (NotificationCopyDialog) before navigating to the
// new incident's own detail page -- every "successful creation" test below
// must dismiss it (via the escape action, no clipboard involved) to reach
// the post-navigation page the rest of the assertions target.
async function dismissCreationNotification(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole('dialog', { name: 'התקלה נפתחה בהצלחה' });
  await user.click(within(dialog).getByRole('button', { name: 'המשך ללא העתקה' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'התקלה נפתחה בהצלחה' })).not.toBeInTheDocument());
  // The detail page is lazy-loaded (App.tsx) -- on its first visit in a
  // fresh test, React keeps this now-hidden create page (modal included)
  // mounted behind the route Suspense fallback for a tick while the chunk
  // resolves. getByText queries ignore visibility, so a query for the
  // detail page's own "...נפתחה בהצלחה" banner could otherwise still match
  // the hidden modal's identically-worded title. Waiting for the generic
  // route-level fallback ("טוען…", App.tsx's <Suspense>) to clear first
  // guarantees the swap is actually done.
  await waitFor(() => expect(screen.queryByText('טוען…')).not.toBeInTheDocument());
}

describe('IncidentCreatePage: access control', () => {
  it('an operational role sees the creation CTA and can open the form', async () => {
    const user = await loginAs('login-u-admin');
    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' }).closest('aside') as HTMLElement;
    expect(within(sidebar).getByRole('link', { name: 'פתיחת תקלה' })).toBeInTheDocument();
    await goToCreatePage(user);
    expect(screen.getByRole('button', { name: 'פתיחת תקלה' })).toBeInTheDocument();
  });

  it('a technician (migration 0037: create_incident is now granted) sees the CTA and can open the form', async () => {
    const user = await loginAs('login-u-tech-1');
    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' }).closest('aside') as HTMLElement;
    expect(within(sidebar).getByRole('link', { name: 'פתיחת תקלה' })).toBeInTheDocument();
    await goToCreatePage(user);
    expect(screen.getByRole('button', { name: 'פתיחת תקלה' })).toBeInTheDocument();
  });

  it('a viewer is also forbidden on direct navigation to the creation route', async () => {
    await loginAs('login-u-viewer');
    window.history.pushState({}, '', '/incidents/new');
    render(<App />);
    expect(await screen.findByText('אין הרשאה')).toBeInTheDocument();
  });
});

describe('IncidentCreatePage: form behavior', () => {
  it('offers only active reference data, grouped by category in the fixed order', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);

    const systemSelect = screen.getByLabelText(/^מערכת \/ עמדה/);
    const locationSelect = screen.getByLabelText(/^מיקום/);

    const systemValues = within(systemSelect)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    const locationValues = within(locationSelect)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);

    // sys-alpha=platforms, sys-beta/sys-pos-a=station_systems, sys-gamma=computing
    // (seed.ts) -- fixed category order: platforms, station_systems, computing,
    // infrastructure, other.
    expect(systemValues).toEqual(['', 'sys-alpha', 'sys-beta', 'sys-pos-a', 'sys-gamma']);
    expect(systemValues).not.toContain('sys-pos-b'); // seeded inactive historical value

    // loc-1/loc-control=unit_internal, loc-2=field_side, loc-3=external_bases --
    // fixed category order: unit_internal, field_side, external_bases,
    // external_sites, other.
    expect(locationValues).toEqual(['', 'loc-1', 'loc-control', 'loc-2', 'loc-3']);

    // Options are grouped under <optgroup> headers using the exact fixed
    // Hebrew category labels, in the fixed order -- not a flat list.
    const systemGroupLabels = within(systemSelect)
      .getAllByRole('group')
      .map((group) => group.getAttribute('label'));
    expect(systemGroupLabels).toEqual(['פלטפורמות', 'מערכות תחנה', 'מחשוב']);

    const locationGroupLabels = within(locationSelect)
      .getAllByRole('group')
      .map((group) => group.getAttribute('label'));
    expect(locationGroupLabels).toEqual(['פנים יחידתי', 'צד שטח', 'בסיסים חיצוניים']);
  });

  it('defaults the actual discovery-time field to now', async () => {
    const before = Date.now();
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    const input = screen.getByLabelText(/^מועד גילוי התקלה בפועל/) as HTMLInputElement;
    expect(input.value).not.toBe('');
    // "YYYY-MM-DDTHH:mm" (Asia/Jerusalem wall clock) -- reconstruct as UTC-ish
    // for a loose sanity check rather than asserting an exact string.
    const [datePart, timePart] = input.value.split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);
    const asUtcGuess = Date.UTC(y, m - 1, d, hh, mm);
    // Within a few hours either side covers any timezone offset ambiguity
    // while still proving this is "now", not a stale or empty default.
    expect(Math.abs(asUtcGuess - before)).toBeLessThan(4 * 3600_000);
  });

  it('does not offer an inactive person as the internal owner', async () => {
    // Wrap (not replace) listProfiles: the login screen's own demo user
    // picker calls this same repository method first, so the real seeded
    // users must remain available -- only an extra inactive profile is
    // appended for this assertion.
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const original = LocalDemoRepository.prototype.listProfiles;
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'listProfiles')
      .mockImplementation(async function (this: InstanceType<typeof LocalDemoRepository>, ...args) {
        const real = await original.apply(this, args);
        return [
          ...real,
          { id: 'inactive-test', fullName: 'לא פעיל לבדיקה', role: 'technician', active: false, createdAt: new Date().toISOString() },
        ];
      });
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    const ownerSelect = await screen.findByLabelText(/^בעל אחריות פנימי/);
    const optionLabels = within(ownerSelect).getAllByRole('option').map((o) => o.textContent);
    expect(optionLabels).toContain('עומר פרץ (דמו)'); // active, still offered
    expect(optionLabels).not.toContain('לא פעיל לבדיקה');
    spy.mockRestore();
  });

  it('requires an internal owner before submission', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await user.selectOptions(screen.getByLabelText(/^מערכת \/ עמדה/), 'sys-alpha');
    await user.selectOptions(screen.getByLabelText(/^מיקום/), 'loc-1');
    await user.type(screen.getByLabelText(/^תיאור התקלה/), 'תקלה לצורך בדיקה');
    await user.type(screen.getByLabelText(/^השפעה מבצעית/), 'השפעה לצורך בדיקה');
    await user.type(screen.getByLabelText(/^פעולות שבוצעו עד כה/), 'נבדק ראשונית');
    // The owner now defaults to the signed-in user, so "leaving it
    // unselected" must be done explicitly -- clearing a default is itself a
    // manual choice the app must respect (never silently re-forced).
    const ownerSelect = screen.getByLabelText(/^בעל אחריות פנימי/);
    await waitFor(() => expect(ownerSelect).toHaveValue('u-admin'));
    await user.selectOptions(ownerSelect, '');
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    expect(await screen.findByText('יש לבחור בעל אחריות פנימי')).toBeInTheDocument();
    // Submission never happened -- still on the creation page.
    expect(screen.getByRole('heading', { name: 'פתיחת תקלה' })).toBeInTheDocument();
  });

  it('rejects a whitespace-only required field', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await user.selectOptions(screen.getByLabelText(/^מערכת \/ עמדה/), 'sys-alpha');
    await user.selectOptions(screen.getByLabelText(/^מיקום/), 'loc-1');
    await user.type(screen.getByLabelText(/^תיאור התקלה/), '   ');
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    expect(await screen.findByText('יש להזין תיאור')).toBeInTheDocument();
  });

  it('has no status picker and no next-update-ETA fields -- both concepts were removed from this form', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    expect(screen.queryByLabelText(/^סטטוס נוכחי/)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'יש צפי לעדכון הבא' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^צפי לעדכון הבא/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/נימוק ל"ללא צפי כרגע"/)).not.toBeInTheDocument();
  });

  it('creates every new incident directly as בטיפול (in_progress), with no status choice exposed', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    await dismissCreationNotification(user);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('פתיחת תקלה'));
    expect(within(main()).getAllByText('בטיפול').length).toBeGreaterThan(0);
  });

  it('disables the submit button while submitting, preventing a duplicate call', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const original = LocalDemoRepository.prototype.createIncident;
    let resolveCall: (() => void) | undefined;
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'createIncident')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof LocalDemoRepository>,
        ...args: Parameters<typeof original>
      ) {
        await new Promise<void>((resolve) => {
          resolveCall = resolve;
        });
        return original.apply(this, args);
      });

    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));

    const pendingButton = await screen.findByRole('button', { name: 'שומר…' });
    expect(pendingButton).toBeDisabled();
    expect(spy).toHaveBeenCalledTimes(1);
    await user.click(pendingButton);
    expect(spy).toHaveBeenCalledTimes(1);

    resolveCall?.();
    await dismissCreationNotification(user);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'פתיחת תקלה' })).not.toBeInTheDocument());
  });

  it('preserves entered values and shows a clean Hebrew error (no raw database error) on failure', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const { AppError } = await import('../data/repository');
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'createIncident')
      .mockRejectedValueOnce(new AppError('VALIDATION', 'הגורם המטפל שנבחר אינו פעיל.'));

    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));

    expect(await screen.findByText('הגורם המטפל שנבחר אינו פעיל.')).toBeInTheDocument();
    expect(screen.queryByText(/postgres/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sqlstate/i)).not.toBeInTheDocument();
    expect((screen.getByLabelText(/^תיאור התקלה/) as HTMLTextAreaElement).value).toBe(
      'תקלה לצורך בדיקה אוטומטית',
    );
    spy.mockRestore();
  });
});

describe('IncidentCreatePage: successful creation end-to-end', () => {
  it('creates the incident, shows the generated number, records the timeline, and the incident is open', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    await dismissCreationNotification(user);

    // Success: navigated to the new incident's own detail page with a
    // prominent banner naming the generated number.
    const banner = await screen.findByText(/נפתחה בהצלחה/);
    const numberMatch = banner.textContent?.match(/\d{4}-\d{3}/);
    expect(numberMatch).toBeTruthy();
    const number = numberMatch![0];

    expect(within(main()).getByText('תקלה לצורך בדיקה אוטומטית')).toBeInTheDocument();
    expect(within(main()).getByText('עומר פרץ (דמו)')).toBeInTheDocument(); // internal owner displayed

    const timeline = (await within(main()).findByText('ציר זמן')).closest('section') as HTMLElement;
    expect(within(timeline).getByText('פתיחת תקלה')).toBeInTheDocument();
    expect(within(timeline).getByText(/נבדק ראשונית לצורך הבדיקה/)).toBeInTheDocument();

    // Neither opening-time question was touched -- both default to לא, with
    // no dependent value, on the details page and in the opening history.
    expect(within(main()).getByText('תקשוב למבצעים')).toBeInTheDocument();
    expect(within(main()).getByText('WISDOM')).toBeInTheDocument();
    expect(within(timeline).getByText(/תקשוב למבצעים: לא/)).toBeInTheDocument();
    expect(within(timeline).getByText(/WISDOM: לא/)).toBeInTheDocument();

    // Open-incident views: the new incident shows up on the active list.
    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    await user.click(within(sidebar).getByRole('link', { name: 'תקלות' }));
    await within(main()).findByRole('heading', { name: 'תקלות' });
    expect(within(main()).getByText(number)).toBeInTheDocument();
  });

  it('an optional "הערה נוספת" persists and appears under the created event, distinct from the generated opening note', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.type(screen.getByLabelText('הערה נוספת'), '  הערה נוספת לצורך הבדיקה  ');
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    await dismissCreationNotification(user);
    await screen.findByText(/נפתחה בהצלחה/);

    const timeline = (await within(main()).findByText('ציר זמן')).closest('section') as HTMLElement;
    expect(within(timeline).getByText(/נבדק ראשונית לצורך הבדיקה/)).toBeInTheDocument();
    expect(within(timeline).getByText('הערה נוספת:')).toBeInTheDocument();
    expect(within(timeline).getByText('הערה נוספת לצורך הבדיקה')).toBeInTheDocument();
  });

  it('leaving "הערה נוספת" blank shows no note section at all', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    await dismissCreationNotification(user);
    await screen.findByText(/נפתחה בהצלחה/);

    const timeline = (await within(main()).findByText('ציר זמן')).closest('section') as HTMLElement;
    expect(within(timeline).queryByText('הערה נוספת:')).not.toBeInTheDocument();
  });
});

describe('IncidentCreatePage: תקשוב למבצעים ו-WISDOM', () => {
  it('both default to לא, with no dependent field shown', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    expect(screen.getByLabelText('האם דווח לתקשוב למבצעים?')).toHaveValue('no');
    expect(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?')).toHaveValue('no');
    expect(screen.queryByLabelText(/^למי דווח\?/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^מספר תקלה ב-WISDOM/)).not.toBeInTheDocument();
    void user;
  });

  it('selecting כן reveals the dependent field, and blocks submission without a value', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.selectOptions(screen.getByLabelText('האם דווח לתקשוב למבצעים?'), 'yes');
    expect(await screen.findByLabelText(/^למי דווח\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    expect(await screen.findByText('יש להזין למי דווח')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'פתיחת תקלה' })).toBeInTheDocument(); // never submitted
  });

  it('switching תקשוב למבצעים from כן back to לא clears the previously entered value', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await user.selectOptions(screen.getByLabelText('האם דווח לתקשוב למבצעים?'), 'yes');
    await user.type(await screen.findByLabelText(/^למי דווח\?/), 'תקשוב מוקד זמני');
    await user.selectOptions(screen.getByLabelText('האם דווח לתקשוב למבצעים?'), 'no');
    expect(screen.queryByLabelText(/^למי דווח\?/)).not.toBeInTheDocument();
    // Switch back to כן: the field must be empty, not restored with the
    // stale value -- proving it was actually cleared, not just hidden.
    await user.selectOptions(screen.getByLabelText('האם דווח לתקשוב למבצעים?'), 'yes');
    expect(await screen.findByLabelText(/^למי דווח\?/)).toHaveValue('');
  });

  it('WISDOM כן requires an incident number, and switching back to לא clears it', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.selectOptions(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?'), 'yes');
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    expect(await screen.findByText('יש להזין מספר תקלה ב-WISDOM')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^מספר תקלה ב-WISDOM/), 'WISDOM-9001');
    await user.selectOptions(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?'), 'no');
    expect(screen.queryByLabelText(/^מספר תקלה ב-WISDOM/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?'), 'yes');
    expect(await screen.findByLabelText(/^מספר תקלה ב-WISDOM/)).toHaveValue('');
  });

  it('creates the incident end-to-end with both answers כן, trimmed values shown on details and in the opening history', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);

    await user.selectOptions(screen.getByLabelText('האם דווח לתקשוב למבצעים?'), 'yes');
    await user.type(await screen.findByLabelText(/^למי דווח\?/), '  תקשוב מוקד מבצעים  ');
    await user.selectOptions(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?'), 'yes');
    await user.type(await screen.findByLabelText(/^מספר תקלה ב-WISDOM/), '  WISDOM-7789  ');

    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    await dismissCreationNotification(user);
    await screen.findByText(/נפתחה בהצלחה/);

    const commsRow = within(main()).getByText('תקשוב למבצעים').closest('div') as HTMLElement;
    expect(within(commsRow).getByText(/תקשוב מוקד מבצעים/)).toBeInTheDocument();
    const wisdomRow = within(main()).getByText('WISDOM').closest('div') as HTMLElement;
    expect(within(wisdomRow).getByText(/WISDOM-7789/)).toBeInTheDocument();

    const timeline = (await within(main()).findByText('ציר זמן')).closest('section') as HTMLElement;
    expect(within(timeline).getByText(/תקשוב למבצעים: כן \(דווח ל: תקשוב מוקד מבצעים\)/)).toBeInTheDocument();
    expect(within(timeline).getByText(/WISDOM: כן \(מספר תקלה: WISDOM-7789\)/)).toBeInTheDocument();
  });
});

describe('IncidentCreatePage: default internal owner (בעל אחריות פנימי)', () => {
  it('defaults to the current signed-in eligible user', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    const ownerSelect = screen.getByLabelText(/^בעל אחריות פנימי/);
    await waitFor(() => expect(ownerSelect).toHaveValue('u-admin'));
  });

  it('can still be changed to another eligible active person, and the manual choice is not reverted', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    const ownerSelect = screen.getByLabelText(/^בעל אחריות פנימי/);
    await waitFor(() => expect(ownerSelect).toHaveValue('u-admin'));
    await user.selectOptions(ownerSelect, 'u-tech-1');
    expect(ownerSelect).toHaveValue('u-tech-1');
    // Give the default-owner effect another render cycle -- it must not
    // revert a manual selection back to the signed-in user.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ownerSelect).toHaveValue('u-tech-1');
  });

  it('never forces an ineligible/inactive signed-in user into the field', async () => {
    // Simulate the signed-in user's OWN row being inactive/absent from the
    // eligible list as seen by the creation form (e.g. a race with a
    // deactivation elsewhere) -- without also hiding their own login
    // button, since a truly inactive demo profile cannot log in at all
    // (LoginPage.tsx filters its picker by `active`). The login screen's
    // own demo picker always calls listProfiles with a fixed
    // { userId: 'u-admin', ... } session regardless of who is about to log
    // in (see LoginPage.tsx) -- only that hardcoded call is left
    // untouched; the real session's own call (once logged in as a
    // DIFFERENT user, u-supervisor-1) sees itself marked inactive.
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const original = LocalDemoRepository.prototype.listProfiles;
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'listProfiles')
      .mockImplementation(async function (
        this: InstanceType<typeof LocalDemoRepository>,
        ...args: Parameters<typeof original>
      ) {
        const real = await original.apply(this, args);
        const [session] = args;
        if (session.userId === 'u-admin') return real; // the login screen's own picker call
        return real.map((p) => (p.id === session.userId ? { ...p, active: false } : p));
      });
    const user = await loginAs('login-u-supervisor-1');
    await goToCreatePage(user);
    const ownerSelect = screen.getByLabelText(/^בעל אחריות פנימי/);
    // Wait for profiles (and therefore the default-owner effect) to have
    // settled, proven by another active profile's option existing.
    await within(ownerSelect).findByRole('option', { name: 'עומר פרץ (דמו)' });
    expect(ownerSelect).toHaveValue('');
    expect(within(ownerSelect).queryByRole('option', { name: 'יואב כהן (דמו)' })).not.toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('IncidentCreatePage: 400-character limits (תיאור התקלה / השפעה מבצעית)', () => {
  it('caps both fields at maxLength 400 and shows a live character counter', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    const description = screen.getByLabelText(/^תיאור התקלה/);
    const impact = screen.getByLabelText(/^השפעה מבצעית/);
    expect(description).toHaveAttribute('maxLength', '400');
    expect(impact).toHaveAttribute('maxLength', '400');
    expect(screen.getAllByText('0/400')).toHaveLength(2);

    await user.type(description, 'א'.repeat(12));
    expect(screen.getByText('12/400')).toBeInTheDocument();
    expect(screen.getByText('0/400')).toBeInTheDocument(); // impact untouched

    await user.type(impact, 'ב'.repeat(5));
    expect(screen.getByText('5/400')).toBeInTheDocument();
  });
});

describe('IncidentCreatePage: form resets fully after a successful creation', () => {
  it('opening the form again after a successful submission shows clean defaults, not the previous incident', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.selectOptions(screen.getByLabelText('האם דווח לתקשוב למבצעים?'), 'yes');
    await user.type(await screen.findByLabelText(/^למי דווח\?/), 'תקשוב זמני לבדיקה');
    await user.selectOptions(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?'), 'yes');
    await user.type(await screen.findByLabelText(/^מספר תקלה ב-WISDOM/), 'WISDOM-1111');
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));
    await dismissCreationNotification(user);
    await screen.findByText(/נפתחה בהצלחה/);

    // Navigate back to the creation form -- a fresh mount, exactly like a
    // real user clicking "פתיחת תקלה" again from the sidebar.
    await goToCreatePage(user);

    expect(screen.getByLabelText('האם דווח לתקשוב למבצעים?')).toHaveValue('no');
    expect(screen.queryByLabelText(/^למי דווח\?/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?')).toHaveValue('no');
    expect(screen.queryByLabelText(/^מספר תקלה ב-WISDOM/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^דווח למבצעים/)).toHaveValue('no');

    expect((screen.getByLabelText(/^תיאור התקלה/) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(/^השפעה מבצעית/) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(/^פעולות שבוצעו עד כה/) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // The internal owner defaults again to the current signed-in user, not
    // to u-tech-1 (the previous incident's manually-selected owner).
    await waitFor(() => expect(screen.getByLabelText(/^בעל אחריות פנימי/)).toHaveValue('u-admin'));
  });
});

describe('IncidentCreatePage: 600-character limit (פעולות שבוצעו עד כה)', () => {
  it('caps the field at maxLength 600 and shows a live character counter', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    const actionsTaken = screen.getByLabelText(/^פעולות שבוצעו עד כה/);
    expect(actionsTaken).toHaveAttribute('maxLength', '600');
    // Two counters legitimately start at "0/600": this field's own, and the
    // separate optional "הערה נוספת" field's (also capped at 600).
    expect(screen.getAllByText('0/600')).toHaveLength(2);

    await user.type(actionsTaken, 'א'.repeat(15));
    expect(screen.getByText('15/600')).toBeInTheDocument();
    // The native maxLength attribute itself prevents ever typing (or
    // pasting) past the boundary through real user interaction -- the
    // 601-character rejection is exercised directly at the schema
    // (schemas.test.ts) and RPC (SQL suite) layers instead.
  });
});

describe('IncidentCreatePage: draft discarded on navigating away from the create route', () => {
  it('clears the saved draft when leaving /incidents/new, so returning later starts clean', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.selectOptions(screen.getByLabelText('האם דווח לתקשוב למבצעים?'), 'yes');
    await user.type(await screen.findByLabelText(/^למי דווח\?/), 'תקשוב זמני');
    await user.selectOptions(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?'), 'yes');
    await user.type(await screen.findByLabelText(/^מספר תקלה ב-WISDOM/), 'WISDOM-2222');

    // Navigate away WITHOUT submitting -- to a completely different route,
    // not back to the same create page -- exactly like a user abandoning
    // the form mid-entry.
    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    await user.click(within(sidebar).getByRole('link', { name: 'ארכיון' }));
    await within(main()).findByRole('heading', { name: 'ארכיון תקלות סגורות ומבוטלות' });

    // Return to the create form -- a fresh mount. The abandoned draft must
    // NOT be restored: everything is back to clean defaults.
    await goToCreatePage(user);

    expect((screen.getByLabelText(/^מערכת \/ עמדה/) as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText(/^מיקום/) as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText(/^תיאור התקלה/) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(/^השפעה מבצעית/) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(/^פעולות שבוצעו עד כה/) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByLabelText('האם דווח לתקשוב למבצעים?')).toHaveValue('no');
    expect(screen.queryByLabelText(/^למי דווח\?/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('האם נפתחה תקלה ב-WISDOM?')).toHaveValue('no');
    expect(screen.queryByLabelText(/^מספר תקלה ב-WISDOM/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // The internal owner defaults again to the current signed-in user, not
    // to u-tech-1 (the abandoned draft's manually-selected owner).
    await waitFor(() => expect(screen.getByLabelText(/^בעל אחריות פנימי/)).toHaveValue('u-admin'));
  });
});

describe('IncidentCreatePage: restoring a draft saved before the external-handler fields existed', () => {
  it('restores an old-shaped draft (no externalHandlerName/_ContactPerson/_ContactDetails keys) with those fields empty, and every pre-existing draft value intact', async () => {
    // Simulates a draft saved by a pre-PR-C client bundle: none of the three
    // external-handler keys exist on the stored object at all.
    const oldShapedDraft = {
      systemId: 'sys-alpha',
      locationId: 'loc-1',
      discoveredAt: '2026-01-01T10:00',
      description: 'תיאור שנשמר לפני הוספת גורם מטפל חיצוני',
      severity: 'high',
      operationalImpact: 'השפעה שנשמרה בטיוטה ישנה',
      actionsTaken: 'פעולות שנשמרו בטיוטה ישנה',
      ownerUserId: 'u-tech-1',
      reportedToOps: 'no',
      reportedToOpsRecipient: '',
      reportedToComms: 'no',
      reportedToCommsRecipient: '',
      wisdomReported: 'no',
      wisdomIncidentNumber: '',
      // externalHandlerName / externalHandlerContactPerson /
      // externalHandlerContactDetails deliberately absent.
    };
    localStorage.setItem('takalot-draft-incident-create', JSON.stringify(oldShapedDraft));

    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);

    // Every value the old draft did have survives intact.
    expect((screen.getByLabelText(/^תיאור התקלה/) as HTMLTextAreaElement).value).toBe(
      'תיאור שנשמר לפני הוספת גורם מטפל חיצוני',
    );
    expect((screen.getByLabelText(/^השפעה מבצעית/) as HTMLTextAreaElement).value).toBe(
      'השפעה שנשמרה בטיוטה ישנה',
    );
    expect((screen.getByLabelText(/^פעולות שבוצעו עד כה/) as HTMLTextAreaElement).value).toBe(
      'פעולות שנשמרו בטיוטה ישנה',
    );
    expect(screen.getByLabelText(/^מערכת \/ עמדה/)).toHaveValue('sys-alpha');
    expect(screen.getByLabelText(/^מיקום/)).toHaveValue('loc-1');

    // The three keys the old draft never had restore as empty strings --
    // a controlled, editable input, not an "undefined" value.
    const nameInput = screen.getByLabelText('גורם מטפל חיצוני') as HTMLInputElement;
    expect(nameInput.value).toBe('');
    const contactPersonInput = screen.getByLabelText('איש קשר') as HTMLInputElement;
    expect(contactPersonInput.value).toBe('');
    const contactDetailsInput = screen.getByLabelText('פרטי קשר') as HTMLInputElement;
    expect(contactDetailsInput.value).toBe('');

    // Proves it's genuinely controlled (not merely defaulting visually):
    // typing works normally.
    await user.type(nameInput, 'ארגון שהוזן לאחר שחזור הטיוטה');
    expect(nameInput.value).toBe('ארגון שהוזן לאחר שחזור הטיוטה');
  });
});

// Temporary operational workaround (no real WhatsApp integration yet):
// NotificationCopyDialog, shown after a confirmed successful creation.
describe('IncidentCreatePage: WhatsApp notification-copy modal (post-creation)', () => {
  it('does not appear while the request is pending, and appears only once the server confirms success', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const original = LocalDemoRepository.prototype.createIncident;
    let resolveCall: (() => void) | undefined;
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'createIncident')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof LocalDemoRepository>,
        ...args: Parameters<typeof original>
      ) {
        await new Promise<void>((resolve) => {
          resolveCall = resolve;
        });
        return original.apply(this, args);
      });

    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    expect(screen.queryByRole('dialog', { name: 'התקלה נפתחה בהצלחה' })).not.toBeInTheDocument();
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));

    await screen.findByRole('button', { name: 'שומר…' }); // still pending
    expect(screen.queryByRole('dialog', { name: 'התקלה נפתחה בהצלחה' })).not.toBeInTheDocument();

    resolveCall?.();
    expect(await screen.findByRole('dialog', { name: 'התקלה נפתחה בהצלחה' })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('does not appear when creation fails', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const { AppError } = await import('../data/repository');
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'createIncident')
      .mockRejectedValueOnce(new AppError('VALIDATION', 'הגורם המטפל שנבחר אינו פעיל.'));

    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));

    expect(await screen.findByText('הגורם המטפל שנבחר אינו פעיל.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'התקלה נפתחה בהצלחה' })).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('builds its message from the persisted incident and the authenticated actor -- never from the editable internal-owner field', async () => {
    const user = await loginAs('login-u-admin'); // signed in as אלון ברק (דמו)
    await goToCreatePage(user);
    // fillMinimalValidForm sets the internal owner to u-tech-1 (עומר פרץ),
    // a DIFFERENT person than the signed-in actor -- proves the message's
    // actor name is never sourced from this (or any other) editable field.
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));

    const dialog = await screen.findByRole('dialog', { name: 'התקלה נפתחה בהצלחה' });
    expect(
      within(dialog).getByText(/כרגע AVARIA עדיין לא שולחת התראות אוטומטיות לוואטסאפ/),
    ).toBeInTheDocument();
    const message = within(dialog).getByRole('group', { name: 'תוכן ההודעה להעתקה' }).textContent ?? '';
    const escapedOrigin = window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(message).toMatch(
      new RegExp(
        `^🟡 נפתחה תקלה בחומרה בינונית \\d{4}-\\d{3} במערכת מערכת אלפא על ידי אלון ברק \\(דמו\\)\\n\\nלצפייה בתקלה:\\n${escapedOrigin}/incidents/[^\\s]+$`,
      ),
    );
    expect(message).not.toContain('עומר פרץ'); // the editable owner field's value must never appear as the actor
  });

  it('appends a direct link to the newly created incident, using the current origin and the server-persisted id (not the displayed incident number)', async () => {
    const user = await loginAs('login-u-admin');
    await goToCreatePage(user);
    await fillMinimalValidForm(user);
    await user.click(screen.getByRole('button', { name: 'פתיחת תקלה' }));

    const dialog = await screen.findByRole('dialog', { name: 'התקלה נפתחה בהצלחה' });
    const message = within(dialog).getByRole('group', { name: 'תוכן ההודעה להעתקה' }).textContent ?? '';
    const [opening, blank, label, url] = message.split('\n');
    expect(blank).toBe('');
    expect(label).toBe('לצפייה בתקלה:');
    expect(url.startsWith(`${window.location.origin}/incidents/`)).toBe(true);

    const incidentId = url.replace(`${window.location.origin}/incidents/`, '');
    expect(incidentId).not.toBe(''); // a real persisted id, not an empty/missing value
    const incidentNumber = opening.match(/\d{4}-\d{3}/)?.[0];
    expect(incidentId).not.toBe(incidentNumber); // never the displayed human-readable number

    // The same complete message (link included) is what actually gets copied.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(within(dialog).getByRole('button', { name: 'העתקת הודעה' }));
    expect(writeText).toHaveBeenCalledWith(message);
  });
});
