import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";

vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      generatedAt: "2026-07-21T20:08:53.525Z",
      projects: [],
      sources: [],
      coverage: { statesAndDistrict: 51, registryRowsAvailable: 97241, connectedSourceGroups: 26, identifiedSourceGroups: 102 },
      inventory: { totalProjects: 794, stageCounts: {}, contractorOrganizations: 170 },
      warnings: [],
    }),
  }),
);

describe("BidAtlas app", () => {
  it("renders the home value proposition", async () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(await screen.findByText("Find the work.", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search open bids" })).toBeInTheDocument();
  });
});
