import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { Project } from "../types";
import { ProjectCard } from "./ProjectCard";

const project: Project = {
  id: "test:research",
  sourceId: "test",
  sourceRecordId: "research",
  title: "Architectural canopy replacement",
  stage: "bidding",
  sourceUrl: "https://example.gov/project",
  participants: [],
  contactStatus: "research-needed",
  duplicateSourceCount: 2,
};

describe("ProjectCard", () => {
  it("flags a qualified project whose contact still needs research", () => {
    render(
      <MemoryRouter>
        <ProjectCard project={project} />
      </MemoryRouter>,
    );

    expect(screen.getByText("Research needed")).toBeInTheDocument();
    expect(screen.getByText("2 sources merged")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Email outreach" })).not.toBeInTheDocument();
  });
});
