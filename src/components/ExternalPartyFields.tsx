// The additive external handling party: an external organization/handler,
// always optional and independent of the (separately, always mandatory)
// internal owner in OwnerField. Never rendered as a substitute for it.
import { Field, Input } from './ui';

export function ExternalPartyFields({
  name,
  contactPerson,
  contactDetails,
  onChangeName,
  onChangeContactPerson,
  onChangeContactDetails,
  nameError,
}: {
  name: string;
  contactPerson: string;
  contactDetails: string;
  onChangeName: (v: string) => void;
  onChangeContactPerson: (v: string) => void;
  onChangeContactDetails: (v: string) => void;
  nameError?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="גורם מטפל חיצוני" error={nameError} hint="אופציונלי -- ארגון או גורם חיצוני המטפל בתקלה, בנוסף לבעל האחריות הפנימי">
        {(a) => (
          <Input
            {...a}
            value={name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder="לדוגמה: ספק תחזוקה"
            maxLength={120}
          />
        )}
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="איש קשר">
          {(a) => (
            <Input
              {...a}
              value={contactPerson}
              onChange={(e) => onChangeContactPerson(e.target.value)}
              placeholder="שם איש הקשר"
              maxLength={120}
            />
          )}
        </Field>
        <Field label="פרטי קשר">
          {(a) => (
            <Input
              {...a}
              value={contactDetails}
              onChange={(e) => onChangeContactDetails(e.target.value)}
              placeholder="טלפון, דוא״ל או מספר קריאה"
              maxLength={500}
            />
          )}
        </Field>
      </div>
    </div>
  );
}
