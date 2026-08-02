// OwnerField: internal-only, required owner picker. The external handling
// party is a separate component (ExternalPartyFields) -- this field never
// renders or accepts an external name itself.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { OwnerField } from './OwnerField';
import type { Profile } from '../domain/types';

const profiles: Profile[] = [
  { id: 'p1', fullName: 'עומר פרץ', role: 'technician', active: true, createdAt: '' },
  { id: 'p2', fullName: 'ליאור אדרי', role: 'technician', active: false, createdAt: '' },
];

describe('OwnerField', () => {
  it('is labeled "בעל אחריות פנימי" and marked required', () => {
    render(<OwnerField profiles={profiles} ownerUserId="" onChange={vi.fn()} />);
    expect(screen.getByText('בעל אחריות פנימי')).toBeInTheDocument();
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('offers only active profiles', () => {
    render(<OwnerField profiles={profiles} ownerUserId="" onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'עומר פרץ' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'ליאור אדרי' })).not.toBeInTheDocument();
  });

  it('shows a validation error when supplied', () => {
    render(<OwnerField profiles={profiles} ownerUserId="" onChange={vi.fn()} error="יש לבחור בעל אחריות פנימי" />);
    expect(screen.getByRole('alert')).toHaveTextContent('יש לבחור בעל אחריות פנימי');
  });

  it('shows the legacy external-only carry-over hint when legacyExternalName is set, and none otherwise', () => {
    const { rerender } = render(
      <OwnerField profiles={profiles} ownerUserId="" onChange={vi.fn()} legacyExternalName="טכנאי מטעם ספק (היסטורי)" />,
    );
    expect(screen.getByText(/גורם מטפל חיצוני קודם: טכנאי מטעם ספק \(היסטורי\)/)).toBeInTheDocument();

    rerender(<OwnerField profiles={profiles} ownerUserId="" onChange={vi.fn()} legacyExternalName={null} />);
    expect(screen.queryByText(/גורם מטפל חיצוני קודם/)).not.toBeInTheDocument();
  });

  it('never renders an external-name input -- external handling lives in a separate component', () => {
    render(<OwnerField profiles={profiles} ownerUserId="" onChange={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/גורם חיצוני/)).not.toBeInTheDocument();
  });
});

// Eligibility, grouping, and sorting (mirrors assert_owner_valid's role
// check, migration 0039): only active users in an eligible role are ever
// offered, grouped by role in the fixed order מנהל מערכת / נגד / מנהל
// מקצועי / אחמ״ש / טכנאי, sorted alphabetically by fullName within each
// group using a Hebrew-aware comparison.
describe('OwnerField: role eligibility, grouping, and sorting', () => {
  const mixedProfiles: Profile[] = [
    { id: 'tech-b', fullName: 'תמר בן דוד', role: 'technician', active: true, createdAt: '' },
    { id: 'tech-a', fullName: 'אבי כהן', role: 'technician', active: true, createdAt: '' },
    { id: 'sup-b', fullName: 'רונית לוי', role: 'shift_supervisor', active: true, createdAt: '' },
    { id: 'sup-a', fullName: 'דנה מזרחי', role: 'shift_supervisor', active: true, createdAt: '' },
    { id: 'mgr', fullName: 'יוסי גל', role: 'professional_manager', active: true, createdAt: '' },
    { id: 'admin', fullName: 'משה אברהם', role: 'system_admin', active: true, createdAt: '' },
    { id: 'viewer-active', fullName: 'אאא צופה פעיל', role: 'viewer', active: true, createdAt: '' },
    { id: 'tech-inactive', fullName: 'אאא טכנאי מושבת', role: 'technician', active: false, createdAt: '' },
  ];

  function optgroupLabels(): string[] {
    return screen.getAllByRole('group').map((g) => g.getAttribute('label') as string);
  }

  it('groups appear in the order מנהל מערכת / נגד / מנהל מקצועי / אחמ״ש / טכנאי', () => {
    render(<OwnerField profiles={mixedProfiles} ownerUserId="" onChange={vi.fn()} />);
    expect(optgroupLabels()).toEqual(['מנהל מערכת', 'נגד / מנהל מקצועי', 'אחמ״ש', 'טכנאי']);
  });

  it('sorts names alphabetically within each group using a Hebrew-aware comparison', () => {
    render(<OwnerField profiles={mixedProfiles} ownerUserId="" onChange={vi.fn()} />);
    const groups = screen.getAllByRole('group');
    const supervisorGroup = groups.find((g) => g.getAttribute('label') === 'אחמ״ש') as HTMLElement;
    const technicianGroup = groups.find((g) => g.getAttribute('label') === 'טכנאי') as HTMLElement;
    expect(within(supervisorGroup).getAllByRole('option').map((o) => o.textContent)).toEqual(['דנה מזרחי', 'רונית לוי']);
    expect(within(technicianGroup).getAllByRole('option').map((o) => o.textContent)).toEqual(['אבי כהן', 'תמר בן דוד']);
  });

  it('excludes an active viewer entirely -- never shown in any group', () => {
    render(<OwnerField profiles={mixedProfiles} ownerUserId="" onChange={vi.fn()} />);
    expect(screen.queryByRole('option', { name: 'אאא צופה פעיל' })).not.toBeInTheDocument();
    expect(optgroupLabels()).not.toContain('צפייה בלבד');
  });

  it('excludes an inactive user even when their role is otherwise eligible', () => {
    render(<OwnerField profiles={mixedProfiles} ownerUserId="" onChange={vi.fn()} />);
    expect(screen.queryByRole('option', { name: 'אאא טכנאי מושבת' })).not.toBeInTheDocument();
  });

  it('omits a role group entirely when it has no eligible members, rather than rendering an empty group', () => {
    const onlyTechnicians: Profile[] = [
      { id: 't1', fullName: 'טכנאי אחד', role: 'technician', active: true, createdAt: '' },
    ];
    render(<OwnerField profiles={onlyTechnicians} ownerUserId="" onChange={vi.fn()} />);
    expect(optgroupLabels()).toEqual(['טכנאי']);
  });

  it('shows nothing but the placeholder when there are no eligible candidates at all', () => {
    const noneEligible: Profile[] = [
      { id: 'v1', fullName: 'צופה', role: 'viewer', active: true, createdAt: '' },
      { id: 't1', fullName: 'טכנאי מושבת', role: 'technician', active: false, createdAt: '' },
    ];
    render(<OwnerField profiles={noneEligible} ownerUserId="" onChange={vi.fn()} />);
    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getAllByRole('option')).toHaveLength(1); // just "— בחר —"
  });

  it('shows an optional custom hint when there is no legacy carry-over fact to show instead', () => {
    render(
      <OwnerField
        profiles={mixedProfiles}
        ownerUserId=""
        onChange={vi.fn()}
        hint="הנחיה כללית לבחירת בעל אחריות."
      />,
    );
    expect(screen.getByText('הנחיה כללית לבחירת בעל אחריות.')).toBeInTheDocument();
  });

  it('prefers the legacy carry-over hint over a supplied general hint when both apply', () => {
    render(
      <OwnerField
        profiles={mixedProfiles}
        ownerUserId=""
        onChange={vi.fn()}
        hint="הנחיה כללית לבחירת בעל אחריות."
        legacyExternalName="טכנאי מטעם ספק (היסטורי)"
      />,
    );
    expect(screen.getByText(/גורם מטפל חיצוני קודם:/)).toBeInTheDocument();
    expect(screen.queryByText('הנחיה כללית לבחירת בעל אחריות.')).not.toBeInTheDocument();
  });
});
