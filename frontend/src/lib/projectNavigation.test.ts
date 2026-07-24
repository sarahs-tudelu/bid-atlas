import { describe, expect, it } from "vitest";

import { projectReturnLink, projectWorkspaceHref } from "./projectNavigation";

describe("project navigation", () => {
  it("preserves a filtered leads page as the workspace return destination", () => {
    const href = projectWorkspaceHref("source:project-1", "/leads?state=NJ&product=canopies");
    const params = new URLSearchParams(href.split("?")[1]);

    expect(params.get("project")).toBe("source:project-1");
    expect(params.get("returnTo")).toBe("/leads?state=NJ&product=canopies");
    expect(projectReturnLink(params.get("returnTo"))).toEqual({
      to: "/leads?state=NJ&product=canopies",
      label: "Back to project leads",
    });
  });

  it("rejects external and unknown return destinations", () => {
    expect(projectReturnLink("//example.com")).toEqual({
      to: "/leads",
      label: "Back to projects",
    });
    expect(projectReturnLink("/unknown")).toEqual({
      to: "/leads",
      label: "Back to projects",
    });
  });
});
