// Compact structured treatment-action picker: a small "+ הוספת פעולה"
// control, never a large always-visible chip grid (9 action types would
// wrap across multiple lines on a narrow phone). Choosing a type
// immediately appends it as a small removable row; 'אחר' reveals its
// detail input only once selected. Used identically by IncidentCreatePage's
// optional disclosure, UpdateDialog's optional disclosure, and CloseDialog's
// inline quick-add.
import { useId, useState } from 'react';
import type { TreatmentActionInput } from '../domain/schemas';
import type { TreatmentActionType } from '../domain/types';
import { TREATMENT_ACTION_TYPE_ORDER, treatmentActionTypeLabels } from '../domain/labels';
import { Button, Input, Select } from './ui';

export function TreatmentActionPicker({
  actions,
  onChange,
  label,
}: {
  actions: TreatmentActionInput[];
  onChange: (actions: TreatmentActionInput[]) => void;
  /** Omit to render without a heading (e.g. inside an already-labeled
   *  disclosure section). */
  label?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [draftType, setDraftType] = useState<TreatmentActionType | ''>('');
  const [draftOther, setDraftOther] = useState('');
  const listId = useId();

  const canAdd = draftType !== '' && (draftType !== 'other' || draftOther.trim().length > 0);

  function commitAdd() {
    // `canAdd` already guarantees draftType !== '' (TS narrows draftType
    // from this aliased condition below).
    if (!canAdd) return;
    onChange([
      ...actions,
      { actionType: draftType, otherDetail: draftType === 'other' ? draftOther.trim() : undefined },
    ]);
    setDraftType('');
    setDraftOther('');
    setAdding(false);
  }

  function cancelAdd() {
    setDraftType('');
    setDraftOther('');
    setAdding(false);
  }

  function removeAt(index: number) {
    onChange(actions.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-2">
      {label && <p className="text-sm font-semibold text-text-primary">{label}</p>}
      {actions.length > 0 && (
        <ul id={listId} className="flex flex-col gap-1.5">
          {actions.map((a, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {treatmentActionTypeLabels[a.actionType]}
                {a.actionType === 'other' && a.otherDetail ? ` — ${a.otherDetail}` : ''}
              </span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`הסרת פעולה: ${treatmentActionTypeLabels[a.actionType]}`}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="flex flex-col gap-2 rounded-lg border border-hairline-strong p-2.5">
          <Select
            aria-label="סוג הפעולה"
            value={draftType}
            onChange={(e) => setDraftType(e.target.value as TreatmentActionType | '')}
            autoFocus
          >
            <option value="">בחירת סוג פעולה</option>
            {TREATMENT_ACTION_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {treatmentActionTypeLabels[t]}
              </option>
            ))}
          </Select>
          {draftType === 'other' && (
            <Input
              aria-label="פירוט הפעולה"
              value={draftOther}
              onChange={(e) => setDraftOther(e.target.value)}
              placeholder="פירוט הפעולה"
              maxLength={500}
            />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={commitAdd} disabled={!canAdd}>
              הוספה
            </Button>
            <Button type="button" variant="ghost" onClick={cancelAdd}>
              ביטול
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          onClick={() => setAdding(true)}
          className="min-h-9 self-start px-3 py-1.5 text-xs"
          aria-controls={listId}
        >
          + הוספת פעולה
        </Button>
      )}
    </div>
  );
}
