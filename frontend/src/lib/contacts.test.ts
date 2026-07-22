import { describe, expect, it } from "vitest";

import { emailContacts, phoneContacts, telephoneHref } from "./contacts";
import type { Project } from "../types";

const project = {
  id: "phone-only",
  sourceId: "test",
  sourceRecordId: "1",
  title: "Canopy replacement",
  stage: "bidding",
  sourceUrl: "https://example.gov/1",
  participants: [
    { name: "Phone Contact", phone: "(973) 555-0100 ext. 4" },
    { name: "Email Contact", email: "buyer@example.gov" },
  ],
} satisfies Project;

describe("published contact helpers", () => {
  it("supports email and phone as independent contact methods", () => {
    expect(emailContacts(project).map((contact) => contact.name)).toEqual(["Email Contact"]);
    expect(phoneContacts(project).map((contact) => contact.name)).toEqual(["Phone Contact"]);
    expect(telephoneHref("(973) 555-0100 ext. 4")).toBe("tel:9735550100;ext=4");
  });
});
