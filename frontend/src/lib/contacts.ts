import type { Project, ProjectParticipant } from "../types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailContacts(project: Project): ProjectParticipant[] {
  return (project.participants ?? []).filter((participant) =>
    EMAIL_PATTERN.test(participant.email?.trim() ?? ""),
  );
}

export function phoneContacts(project: Project): ProjectParticipant[] {
  return (project.participants ?? []).filter((participant) => {
    const phone = participant.phone?.trim() ?? "";
    const digitCount = phone.replace(/\D/g, "").length;
    return digitCount >= 7 && digitCount <= 15;
  });
}

export function telephoneHref(phone: string): string {
  const extension = phone.match(/(?:ext\.?|x)\s*(\d+)\s*$/i);
  const mainNumber = (extension ? phone.slice(0, extension.index) : phone).replace(/[^\d+]/g, "");
  return `tel:${mainNumber}${extension ? `;ext=${extension[1]}` : ""}`;
}
