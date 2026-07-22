import { useState, type FormEvent } from "react";

interface QuerySearchFormProps {
  label: string;
  placeholder: string;
  /** Seeds the field. Remount with `key={initialQuery}` to resync after back/forward. */
  initialQuery: string;
  onSearch: (query: string) => void;
}

export function QuerySearchForm({ label, placeholder, initialQuery, onSearch }: QuerySearchFormProps) {
  const [query, setQuery] = useState(initialQuery);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(query.trim());
  };

  return (
    <form className="simple-search" role="search" onSubmit={submit}>
      <label>
        <span>{label}</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} />
      </label>
      <button className="button button-primary" type="submit">
        Search
      </button>
    </form>
  );
}
