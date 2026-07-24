import { describe, expect, it } from "vitest";

import { explainFitReason, summarizeFitReasons } from "./productFit";

describe("product fit explanations", () => {
  it("explains title, detail, classification, and negative signals", () => {
    expect(explainFitReason("pergola:title")).toBe(
      "Pergola appears in the project title and raises the score.",
    );
    expect(explainFitReason("commercial construction")).toBe(
      "Commercial construction appears in the published project details and raises the score.",
    );
    expect(explainFitReason("-tree or forest canopy:title")).toBe(
      "Tree or forest canopy appears in the project title and lowers the score.",
    );
    expect(explainFitReason("NAICS 332311")).toBe(
      "NAICS 332311 is a relevant trade classification and raises the score.",
    );
  });

  it("limits card summaries to the strongest reasons", () => {
    expect(summarizeFitReasons(["canopy:title", "commercial construction", "metal fabrication"])).toBe(
      "Canopy appears in the project title and raises the score. Commercial construction appears in the published project details and raises the score.",
    );
  });
});
