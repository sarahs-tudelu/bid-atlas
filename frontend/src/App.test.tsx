import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

vi.stubGlobal(
  "fetch",
  vi.fn().mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: { email: "tester@tudelu.com", name: "Test User", picture: "", gmailConnected: true },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
      generatedAt: "2026-07-21T20:08:53.525Z",
      projects: [],
      sources: [],
      coverage: { statesAndDistrict: 51, registryRowsAvailable: 97241, connectedSourceGroups: 26, identifiedSourceGroups: 102 },
      inventory: { totalProjects: 794, stageCounts: {}, contractorOrganizations: 170 },
      warnings: [],
      }),
    };
  }),
);

afterEach(cleanup);

describe("BidAtlas app", () => {
  it("renders the home value proposition", async () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(await screen.findByText("Find the work.", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search open bids" })).toBeInTheDocument();
  });

  it("shows only the Tudelu sign-in screen without an authenticated session", async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Sign in with a Tudelu Google account" }),
      } as Response))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ configured: true, domain: "tudelu.com" }),
      } as Response));

    render(<MemoryRouter><App /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Sign in to BidAtlas" })).toBeInTheDocument();
    expect(screen.queryByText("Find the work.", { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText("Only verified @tudelu.com accounts are accepted.")).toBeInTheDocument();
  });
});
