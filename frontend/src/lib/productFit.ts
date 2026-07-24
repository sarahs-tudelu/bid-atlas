import type { CanopyFit } from "../types";

export const FIT_BAND_LABELS: Record<CanopyFit["band"], string> = {
  high: "High product fit",
  possible: "Possible product fit",
  low: "Low product fit",
};

function sentenceCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

export function explainFitReason(reason: string): string {
  const titleMatch = reason.endsWith(":title");
  const withoutScope = titleMatch ? reason.slice(0, -":title".length) : reason;
  const lowersScore = withoutScope.startsWith("-");
  const signal = lowersScore ? withoutScope.slice(1) : withoutScope;

  if (signal.startsWith("NAICS ")) {
    return `${signal} is a relevant trade classification and raises the score.`;
  }

  const location = titleMatch ? "project title" : "published project details";
  const effect = lowersScore ? "lowers" : "raises";
  return `${sentenceCase(signal)} appears in the ${location} and ${effect} the score.`;
}

export function summarizeFitReasons(reasons: string[], limit = 2): string {
  return reasons.slice(0, limit).map(explainFitReason).join(" ");
}
