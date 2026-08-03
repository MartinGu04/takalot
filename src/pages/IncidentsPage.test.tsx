// Active-incidents page filter bar: exercised through the real app with the
// demo repository (real seeded incidents, real rules), mirroring
// ArchivePage.test.tsx's approach.
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

function main(): HTMLElement {
  return document.querySelector('main') as HTMLElement;
}

// Seeded open incidents relevant to these assertions (see src/data/local/seed.ts):
//   inc-1: critical, sys-alpha, אתר 1,          owner עומר פרץ (דמו) (u-tech-1)
//   inc-2: high,     sys-beta,  אתר 2,          owner ליאור אדרי (דמו) (u-tech-2)
//   inc-4: low,      עמדה א׳,   חדר בקרה ראשי,  owner יואב כהן (דמו)
//   inc-7: medium,   sys-gamma, חדר בקרה ראשי,  owner עומר פרץ (דמו) (u-tech-1)
const INC1_TEXT = /אין יכולת הפעלה מלאה של מערכת אלפא/;
const INC2_TEXT = /עיכוב בקבלת נתונים בעמדת הבקרה/;
const INC4_TEXT = /אין פגיעה תפקודית\. במעקב טמפרטורה כל שעתיים/;
const INC7_TEXT = /נדרש רענון ידני של התצוגה/;

async function goToIncidents(user: ReturnType<typeof userEvent.setup>) {
  const sidebarNav = screen.getByRole('navigation', { name: 'ניווט ראשי' });
  await user.click(within(sidebarNav).getByRole('link', { name: 'תקלות' }));
  await within(main()).findByRole('heading', { name: 'תקלות' });
}

describe('IncidentsPage: status filter removed', () => {
  it('no longer renders a status filter control', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    expect(within(main()).queryByLabelText('סינון לפי סטטוס')).not.toBeInTheDocument();
    expect(within(main()).queryByText('הוספת סטטוס…')).not.toBeInTheDocument();
  });
});

describe('IncidentsPage: retains severity, system/station, assignee, and location filters', () => {
  it('renders exactly the four remaining filters, in right-to-left order: חומרה, מערכת, גורם מטפל, מיקום', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    expect(within(main()).getByLabelText('חיפוש תקלות')).toBeInTheDocument();
    const severity = within(main()).getByLabelText('סינון לפי חומרה');
    const system = within(main()).getByLabelText('סינון לפי מערכת');
    const owner = within(main()).getByLabelText('סינון לפי גורם מטפל');
    const location = within(main()).getByLabelText('סינון לפי מיקום');

    expect(severity.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(system.compareDocumentPosition(owner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(owner.compareDocumentPosition(location) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the severity filter still narrows the list correctly', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    expect(await within(main()).findByText(INC1_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC2_TEXT)).toBeInTheDocument();

    await user.selectOptions(within(main()).getByLabelText('סינון לפי חומרה'), 'critical');

    expect(await within(main()).findByText(INC1_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC2_TEXT)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('severity')).toBe('critical');
  });

  it('the system/station filter still narrows the list correctly', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    expect(await within(main()).findByText(INC1_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC2_TEXT)).toBeInTheDocument();

    await user.selectOptions(within(main()).getByLabelText('סינון לפי מערכת'), 'sys-beta');

    expect(await within(main()).findByText(INC2_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC1_TEXT)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('system')).toBe('sys-beta');
  });

  it('the assignee filter still narrows the list correctly', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    expect(await within(main()).findByText(INC1_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC2_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC7_TEXT)).toBeInTheDocument();

    await user.selectOptions(within(main()).getByLabelText('סינון לפי גורם מטפל'), 'עומר פרץ (דמו)');

    expect(await within(main()).findByText(INC1_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC7_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC2_TEXT)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('owner')).toBe('u-tech-1');
  });

  it('the location filter still narrows the list correctly', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    expect(await within(main()).findByText(INC1_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC4_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC7_TEXT)).toBeInTheDocument();

    await user.selectOptions(within(main()).getByLabelText('סינון לפי מיקום'), 'loc-control');

    expect(await within(main()).findByText(INC4_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC7_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC1_TEXT)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('location')).toBe('loc-control');
  });

  it('lays the four filters out on a real four-column grid, not a flex row that could force full-width vertical stacking', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    const severity = within(main()).getByLabelText('סינון לפי חומרה');
    const system = within(main()).getByLabelText('סינון לפי מערכת');
    const owner = within(main()).getByLabelText('סינון לפי גורם מטפל');
    const location = within(main()).getByLabelText('סינון לפי מיקום');
    const row = severity.parentElement as HTMLElement;

    expect(row.contains(system)).toBe(true);
    expect(row.contains(owner)).toBe(true);
    expect(row.contains(location)).toBe(true);
    // A real responsive grid -- one column on mobile, two on tablet, four on
    // desktop -- not a flex-wrap row relying on each control shrinking to
    // its own content to avoid stacking full-width.
    expect(row.className).toMatch(/\bgrid\b/);
    expect(row.className).toMatch(/grid-cols-1/);
    expect(row.className).toMatch(/sm:grid-cols-2/);
    expect(row.className).toMatch(/lg:grid-cols-4/);
    expect(row.className).not.toMatch(/flex-wrap/);
    for (const control of [severity, system, owner, location]) {
      expect(control.className).toMatch(/\bw-full\b/);
      expect(control.className).not.toMatch(/\bw-auto\b/);
    }
  });

  it('groups the assignee filter into the four eligible-role categories, matching the internal-owner picker', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    const ownerSelect = within(main()).getByLabelText('סינון לפי גורם מטפל');
    const groupLabels = within(ownerSelect)
      .getAllByRole('group')
      .map((g) => g.getAttribute('label'));
    expect(groupLabels).toEqual(['מנהל מערכת', 'נגד', 'אחמ״ש', 'טכנאי']);
  });

  it('never offers a viewer-only user as an assignee, even though the profile is active', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToIncidents(user);

    const ownerSelect = within(main()).getByLabelText('סינון לפי גורם מטפל');
    expect(within(ownerSelect).queryByRole('option', { name: /רוני שגיא/ })).not.toBeInTheDocument();
    expect(within(ownerSelect).queryByRole('group', { name: 'צפייה בלבד' })).not.toBeInTheDocument();
  });
});
