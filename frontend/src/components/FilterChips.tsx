import { DUE_LABELS, STAGE_LABELS, type ProjectSearchValues } from "./ProjectSearch";
import { stateName } from "../lib/usStates";

const FIELD_LABELS: Record<keyof ProjectSearchValues, string> = {
  keywords: "Keywords",
  location: "Location",
  state: "State",
  stage: "Stage",
  due: "Deadline",
  profile: "Canopy profile",
};

interface FilterChipsProps {
  values: ProjectSearchValues;
  /** Fields the current view does not expose, so they are never shown as removable. */
  hidden?: Array<keyof ProjectSearchValues>;
  /** Preset id → label, so a profile chip reads as its name rather than its id. */
  presetLabels?: Record<string, string>;
  onRemove: (field: keyof ProjectSearchValues) => void;
}

export function FilterChips({ values, hidden = [], presetLabels = {}, onRemove }: FilterChipsProps) {
  const displayValue = (field: keyof ProjectSearchValues, value: string): string => {
    if (field === "state") return `${value.toUpperCase()} — ${stateName(value)}`;
    if (field === "stage") return STAGE_LABELS[value] ?? value;
    if (field === "due") return DUE_LABELS[value] ?? value;
    if (field === "profile") return presetLabels[value] ?? value;
    return value;
  };

  const active = (Object.keys(FIELD_LABELS) as Array<keyof ProjectSearchValues>).filter(
    (field) => !hidden.includes(field) && values[field] && values[field] !== "all",
  );

  if (!active.length) return null;

  return (
    <div className="filter-chips">
      <span>Applied</span>
      {active.map((field) => (
        <span className="chip" key={field}>
          <small>{FIELD_LABELS[field]}</small>
          {displayValue(field, values[field])}
          <button
            type="button"
            onClick={() => onRemove(field)}
            aria-label={`Remove ${FIELD_LABELS[field]} filter ${displayValue(field, values[field])}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
