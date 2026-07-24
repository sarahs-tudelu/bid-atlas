import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_SEARCH, ProjectSearch } from "./ProjectSearch";


describe("ProjectSearch", () => {
  it("submits the selected product type as a first-class filter", () => {
    const onSubmit = vi.fn();

    render(
      <ProjectSearch
        initialValues={EMPTY_SEARCH}
        onSubmit={onSubmit}
        onReset={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Product type"), {
      target: { value: "partition-walls" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(onSubmit).toHaveBeenCalledWith({
      ...EMPTY_SEARCH,
      product: "partition-walls",
    });
  });
});
