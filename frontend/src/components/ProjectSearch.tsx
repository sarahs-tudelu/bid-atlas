import { useState, type FormEvent } from "react";

import { US_STATES } from "../lib/usStates";

export interface ProjectSearchValues {
  keywords: string;
  location: string;
  state: string;
  stage: string;
  due: string;
  profile: string;
}

export const EMPTY_SEARCH: ProjectSearchValues = {
  keywords: "",
  location: "",
  state: "all",
  stage: "all",
  due: "all",
  profile: "all",
};

export const STAGE_LABELS: Record<string, string> = {
  planning: "Planning",
  design: "Design",
  permitting: "Permitting",
  bidding: "Bidding",
  "bid-opened": "Bid opened",
  awarded: "Awarded",
  construction: "Construction",
  completed: "Completed",
  cancelled: "Cancelled",
  unclassified: "Unclassified",
};

export const DUE_LABELS: Record<string, string> = {
  all: "All open bids",
  today: "Due today",
  "7-days": "Next 7 days",
  "14-days": "Next 14 days",
};

function valuesEqual(left: ProjectSearchValues, right: ProjectSearchValues): boolean {
  return (Object.keys(left) as Array<keyof ProjectSearchValues>).every((key) => left[key] === right[key]);
}

interface ProjectSearchProps {
  /** Filters currently applied to the results. Remount with a key to resync after back/forward. */
  initialValues: ProjectSearchValues;
  showStage?: boolean;
  onSubmit: (values: ProjectSearchValues) => void;
  onReset: () => void;
}

/**
 * Owns its own draft so typing never re-runs the query; the results only change
 * when the reader submits, and an unapplied edit says so explicitly.
 */
export function ProjectSearch({ initialValues, showStage = false, onSubmit, onReset }: ProjectSearchProps) {
  const [values, setValues] = useState(initialValues);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(values);
  };

  const set = (patch: Partial<ProjectSearchValues>) => setValues({ ...values, ...patch });
  const dirty = !valuesEqual(values, initialValues);
  const hasValues = Object.entries(values).some(([, value]) => value && value !== "all");

  return (
    <form className="search-panel" onSubmit={submit} role="search" aria-label="Filter project records">
      <label>
        <span>Products, scope, or project</span>
        <input
          type="search"
          value={values.keywords}
          onChange={(event) => set({ keywords: event.target.value })}
          placeholder="roofing, canopy, glazing"
        />
      </label>
      <label>
        <span>Location</span>
        <input
          value={values.location}
          onChange={(event) => set({ location: event.target.value })}
          placeholder="city or county"
        />
      </label>
      <label>
        <span>State</span>
        <select value={values.state} onChange={(event) => set({ state: event.target.value })}>
          <option value="all">All states</option>
          {US_STATES.map(([code, name]) => (
            <option key={code} value={code}>
              {code} — {name}
            </option>
          ))}
        </select>
      </label>
      {showStage ? (
        <label>
          <span>Stage</span>
          <select value={values.stage} onChange={(event) => set({ stage: event.target.value })}>
            <option value="all">All stages</option>
            {["planning", "design", "permitting", "bidding", "awarded", "construction"].map((stage) => (
              <option key={stage} value={stage}>
                {STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          <span>Deadline</span>
          <select value={values.due} onChange={(event) => set({ due: event.target.value })}>
            {Object.entries(DUE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="button button-primary" type="submit">
        Search
      </button>

      {(dirty || hasValues) && (
        <div className="search-panel-footer">
          <p className="search-hint">{dirty ? "Filters changed — press Search to apply." : " "}</p>
          {hasValues && (
            <button className="link-button" type="button" onClick={onReset}>
              Clear all filters
            </button>
          )}
        </div>
      )}
    </form>
  );
}
