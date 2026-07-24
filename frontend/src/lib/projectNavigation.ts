const RETURN_LABELS: Record<string, string> = {
  "/": "Back to dashboard",
  "/projects": "Back to open bids",
  "/leads": "Back to project leads",
  "/companies": "Back to companies",
  "/documents": "Back to documents",
  "/inbox": "Back to inbox",
  "/source-monitor": "Back to source monitor",
};

export function projectWorkspaceHref(projectId: string, returnTo?: string): string {
  const params = new URLSearchParams({ project: projectId });
  if (returnTo) params.set("returnTo", returnTo);
  return `/bid-desk?${params.toString()}`;
}

export function projectReturnLink(candidate: string | null): {
  to: string;
  label: string;
} {
  const fallback = { to: "/leads", label: "Back to projects" };
  if (!candidate?.startsWith("/") || candidate.startsWith("//")) return fallback;

  const pathname = candidate.split(/[?#]/, 1)[0];
  const label = RETURN_LABELS[pathname];
  return label ? { to: candidate, label } : fallback;
}
