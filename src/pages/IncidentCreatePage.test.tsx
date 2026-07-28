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

describe('IncidentCreatePage: access control', () => {
  it('an operational role sees the creation CTA and can open the form', async () => {
    const user = await loginAs('login-u-admin');
    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' }).closest('aside') as HTMLElement;
    expect(within(sidebar).getByRole('link', { name: 'פתיחת תקלה' })).toBeInTheDocument();
    await goToCreatePage(user);
    expect(screen.getByRole('button', { name: 'פתיחת תקלה' })).toBeInTheDocument();
  });

  it('a technician (no create_incident capability) sees no CTA and is forbidden on direct navigation', async () => {
    await loginAs('login-u-tech-1');
    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' }).closest('aside') as HTMLElement;
    expect(within(sidebar).queryByRole('link', { name: 'פתיחת תקלה' })).not.toBeInTheDocument();

    window.history.pushState({}, '', '/incidents/new');
    render(<App />);
    expect(await screen.findByText('אין הרשאה')).toBeInTheDocument();
  });

  it('a viewer is also forbidden on direct navigation to the creation route', async () => {
    await loginAs('login-u-viewer');
    window.history.pushState({}, '', '/incidents/new');
    render(<App />);
    expect(await screen.findByText('אין הרשאה')).toBeInTheDocument();
  });
});

describe('IncidentCreatePage: form behavior', () => {
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
    // Deliberately leave the owner unselected.
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
