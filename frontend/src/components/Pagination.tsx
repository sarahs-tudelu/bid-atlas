interface PaginationProps {
  page: number;
  totalPages: number;
  /** Optional: renders a "Showing 11–20 of 340" readout above the controls. */
  pageSize?: number;
  totalItems?: number;
  onPageChange: (page: number) => void;
}

/** Windowed page numbers with first/last always reachable: 1 … 4 5 6 … 20 */
function pageWindow(page: number, totalPages: number): Array<number | "gap"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const pages = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((value) => pages.add(value));
  if (page >= totalPages - 2) [totalPages - 3, totalPages - 2, totalPages - 1].forEach((value) => pages.add(value));

  const ordered = [...pages].filter((value) => value >= 1 && value <= totalPages).sort((a, b) => a - b);
  return ordered.flatMap((value, index) =>
    index > 0 && value - ordered[index - 1] > 1 ? ["gap" as const, value] : [value],
  );
}

export function Pagination({ page, totalPages, pageSize, totalItems, onPageChange }: PaginationProps) {
  if (!Number.isFinite(totalPages) || totalPages <= 1) return null;

  const safePage = Math.min(Math.max(page || 1, 1), totalPages);
  const showRange = pageSize !== undefined && totalItems !== undefined && totalItems > 0;
  const first = (safePage - 1) * (pageSize ?? 0) + 1;
  const last = Math.min(safePage * (pageSize ?? 0), totalItems ?? 0);

  return (
    <nav className="pagination" aria-label="Results pages">
      {showRange && (
        <p className="pagination-range">
          Showing <strong>{first.toLocaleString()}</strong>–<strong>{last.toLocaleString()}</strong> of{" "}
          <strong>{totalItems.toLocaleString()}</strong>
        </p>
      )}
      <button type="button" disabled={safePage <= 1} onClick={() => onPageChange(safePage - 1)}>
        Previous
      </button>
      {pageWindow(safePage, totalPages).map((entry, index) =>
        entry === "gap" ? (
          <span className="pagination-gap" key={`gap-${index}`} aria-hidden="true">
            …
          </span>
        ) : (
          <button
            type="button"
            key={entry}
            aria-current={entry === safePage ? "page" : undefined}
            aria-label={`Page ${entry}`}
            onClick={() => onPageChange(entry)}
          >
            {entry}
          </button>
        ),
      )}
      <button type="button" disabled={safePage >= totalPages} onClick={() => onPageChange(safePage + 1)}>
        Next
      </button>
    </nav>
  );
}
