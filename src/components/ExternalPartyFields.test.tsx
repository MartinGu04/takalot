// ExternalPartyFields: the additive external handling party -- always
// optional and independent of OwnerField's mandatory internal owner.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExternalPartyFields } from './ExternalPartyFields';

describe('ExternalPartyFields', () => {
  it('renders name, contact-person, and contact-details fields, all optional (not marked required)', () => {
    render(
      <ExternalPartyFields
        name=""
        contactPerson=""
        contactDetails=""
        onChangeName={vi.fn()}
        onChangeContactPerson={vi.fn()}
        onChangeContactDetails={vi.fn()}
      />,
    );
    expect(screen.getByText('גורם מטפל חיצוני')).toBeInTheDocument();
    expect(screen.getByText('איש קשר')).toBeInTheDocument();
    expect(screen.getByText('פרטי קשר')).toBeInTheDocument();
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  it('calls the respective onChange callback for each field', async () => {
    const user = userEvent.setup();
    const onChangeName = vi.fn();
    const onChangeContactPerson = vi.fn();
    const onChangeContactDetails = vi.fn();
    render(
      <ExternalPartyFields
        name=""
        contactPerson=""
        contactDetails=""
        onChangeName={onChangeName}
        onChangeContactPerson={onChangeContactPerson}
        onChangeContactDetails={onChangeContactDetails}
      />,
    );
    await user.type(screen.getByPlaceholderText('לדוגמה: ספק תחזוקה'), 'א');
    expect(onChangeName).toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText('שם איש הקשר'), 'ד');
    expect(onChangeContactPerson).toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText('טלפון, דוא״ל או מספר קריאה'), '0');
    expect(onChangeContactDetails).toHaveBeenCalled();
  });

  it('shows a name-required validation error when supplied', () => {
    render(
      <ExternalPartyFields
        name=""
        contactPerson="דנה"
        contactDetails=""
        onChangeName={vi.fn()}
        onChangeContactPerson={vi.fn()}
        onChangeContactDetails={vi.fn()}
        nameError="יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('יש להזין שם גורם מטפל חיצוני');
  });
});
