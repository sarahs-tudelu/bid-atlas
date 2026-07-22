/** Placeholder shapes that mirror the real layout so nothing shifts on load. */

function widths(count: number): string[] {
  const pattern = ["100%", "92%", "68%", "84%", "76%"];
  return Array.from({ length: count }, (_, index) => pattern[index % pattern.length]);
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-row">
      {widths(lines).map((width, index) => (
        <div className="skeleton skeleton-line" key={index} style={{ width }} />
      ))}
    </div>
  );
}

export function ProjectCardSkeleton() {
  return (
    <div className="skeleton-card">
      <div className="skeleton skeleton-line" style={{ width: "35%" }} />
      <div className="skeleton" style={{ height: 26, margin: "18px 0 12px", width: "88%" }} />
      <SkeletonText lines={3} />
      <div className="skeleton skeleton-block" />
      <div className="skeleton skeleton-line" style={{ height: 42, width: "60%" }} />
    </div>
  );
}

export function ProjectGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="project-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <ProjectCardSkeleton key={index} />
      ))}
    </div>
  );
}

export function ListSkeleton({ count = 5, height = 92 }: { count?: number; height?: number }) {
  return (
    <div className="document-list" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton" key={index} style={{ height }} />
      ))}
    </div>
  );
}

export function CardGridSkeleton({ count = 6, height = 210 }: { count?: number; height?: number }) {
  return (
    <div className="company-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton" key={index} style={{ height }} />
      ))}
    </div>
  );
}
