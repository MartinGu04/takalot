// OwnerField: internal-only, required owner picker. The external handling
// party is a separate component (ExternalPartyFields) -- this field never
// renders or accepts an external name itself.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
