import type { FormEvent } from "react";

export interface ProjectSearchValues {
  keywords: string;
  location: string;
  state: string;
  stage: string;
  due: string;
}

interface ProjectSearchProps {
  values: ProjectSearchValues;
  showStage?: boolean;
  onChange: (values: ProjectSearchValues) => void;
  onSubmit: () => void;
}

export function ProjectSearch({ values, showStage = false, onChange, onSubmit }: ProjectSearchProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form className="search-panel" onSubmit={submit}>
      <label className="search-keywords">
        <span>Products, scope, or project</span>
        <input
          value={values.keywords}
          onChange={(event) => onChange({ ...values, keywords: event.target.value })}
          placeholder="roofing, canopy, glazing"
        />
      </label>
      <label>
        <span>Location</span>
        <input
          value={values.location}
          onChange={(event) => onChange({ ...values, location: event.target.value })}
          placeholder="city or county"
        />
      </label>
      <label>
        <span>State</span>
        <input
          value={values.state === "all" ? "" : values.state}
          onChange={(event) => onChange({ ...values, state: event.target.value || "all" })}
          placeholder="NY"
          maxLength={20}
        />
      </label>
      {showStage && (
        <label>
          <span>Stage</span>
          <select value={values.stage} onChange={(event) => onChange({ ...values, stage: event.target.value })}>
            <option value="all">All stages</option>
            <option value="planning">Planning</option>
            <option value="design">Design</option>
            <option value="permitting">Permitting</option>
            <option value="bidding">Bidding</option>
            <option value="awarded">Awarded</option>
            <option value="construction">Construction</option>
          </select>
        </label>
      )}
      {!showStage && (
        <label>
          <span>Deadline</span>
          <select value={values.due} onChange={(event) => onChange({ ...values, due: event.target.value })}>
            <option value="all">All open bids</option>
            <option value="today">Due today</option>
            <option value="7-days">Next 7 days</option>
            <option value="14-days">Next 14 days</option>
          </select>
        </label>
      )}
      <button className="button button-primary" type="submit">Search</button>
    </form>
  );
}
