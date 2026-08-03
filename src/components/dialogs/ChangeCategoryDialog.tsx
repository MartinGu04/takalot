// שינוי סוג -- moves a system/location to a different fixed category.
// Categories are product-defined (see domain/labels.ts): the selector only
// ever offers the OTHER valid categories, in their fixed order, so
// "changing" to the current category is not a selectable option at all
// (rather than a submittable no-op the user could accidentally trigger).
// Authorization and the actual append-to-end/gap-normalization behavior are
// enforced server-side (setSystemCategory/setLocationCategory) -- this
// dialog only offers the matching UX.
import { useState } from 'react';
import { Dialog, Field, Select, Button } from '../ui';

export function ChangeCategoryDialog<TCategory extends string>({
  open,
  recordName,
  currentCategory,
  categoryOrder,
  categoryLabels,
  onClose,
  onSubmit,
  submitting,
}: {
  open: boolean;
  recordName: string;
  currentCategory: TCategory;
  categoryOrder: readonly TCategory[];
  categoryLabels: Record<TCategory, string>;
  onClose: () => void;
  onSubmit: (category: TCategory) => void;
  submitting: boolean;
}) {
  const otherCategories = categoryOrder.filter((category) => category !== currentCategory);
  const [category, setCategory] = useState<TCategory>(otherCategories[0]);

  const handleClose = () => {
    setCategory(otherCategories[0]);
    onClose();
  };

  if (!open) return null;
  return (
    <Dialog open={open} onClose={handleClose} title={`שינוי סוג עבור ${recordName}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitting) onSubmit(category);
        }}
      >
        <div>
          <p className="text-sm font-semibold text-text-primary">סוג נוכחי</p>
          <p className="mt-1 text-sm text-muted">{categoryLabels[currentCategory]}</p>
        </div>
        <Field label="סוג חדש" required>
          {(a) => (
            <Select
              {...a}
              value={category}
              disabled={submitting}
              onChange={(event) => setCategory(event.target.value as TCategory)}
            >
              {otherCategories.map((option) => (
                <option key={option} value={option}>
                  {categoryLabels[option]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2">
          {/* RTL: first in source order sits rightmost -- the primary
              "שמירה" action goes first so it reads as visually first. */}
          <Button type="submit" disabled={submitting}>
            {submitting ? 'שומר…' : 'שמירה'}
          </Button>
          <Button type="button" variant="secondary" disabled={submitting} onClick={handleClose}>
            ביטול
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
