import type {
  CoverageState,
  CoverageSummary,
  ProjectRecord,
  SourceRecord,
  StateCoverageRecord,
} from "./types";
import { STATE_SOURCE_REGISTRY } from "./state-source-registry";

export const LOCAL_GOVERNMENT_UNIVERSE_2025 = 91_438;
export const CENSUS_REGISTRY_ROWS_2025 = 97_241;
export const CENSUS_DEPENDENT_AGENCY_ROWS_2025 = 5_803;
export const CENSUS_GOVERNMENT_UNIVERSE_URL =
  "https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html";

const STATES: ReadonlyArray<readonly [string, string]> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"],
  ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
];

const STATE_CODE_BY_NAME = new Map(STATES.map(([code, name]) => [name.toLowerCase(), code]));
const STATE_SOURCE_BY_CODE = new Map(STATE_SOURCE_REGISTRY.map((record) => [record.code, record]));

export function normalizeStateCode(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (normalized.length === 2) return normalized.toUpperCase();
  return STATE_CODE_BY_NAME.get(normalized.toLowerCase());
}

type StateCoverageCategory = "procurement" | "dotBidding" | "permits" | "planning";

function sourceStateCode(source: SourceRecord): string | undefined {
  const parts = source.jurisdiction
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .reverse();
  for (const part of parts) {
    const code = normalizeStateCode(part);
    if (code) return code;
  }
  return undefined;
}

function sourceCoversCategory(source: SourceRecord, category: StateCoverageCategory): boolean {
  if (source.level === "federal" || source.level === "registry") return false;
  if (category === "permits") return source.sourceClass === "permits";
  if (category === "planning") {
    return source.sourceClass === "planning" || source.sourceClass === "capital-plans";
  }
  const isTransportationSource = /(?:^|\W)(?:dot|transportation)(?:\W|$)/i.test(
    `${source.id} ${source.owner}`,
  );
  if (category === "dotBidding") {
    return isTransportationSource && source.sourceClass === "procurement";
  }
  return !isTransportationSource && source.sourceClass === "procurement";
}

function sourceCoverageState(source: SourceRecord): CoverageState {
  if (source.status === "credential-required") return "credential-required";
  if (source.status !== "live") return "identified";
  // A healthy adapter is not proof that every applicable agency, threshold,
  // document class, or lifecycle record in the state is covered. Promotion to
  // connected requires reviewed scope evidence that SourceRecord does not yet
  // model, so live sources remain partial in the national ledger.
  return "partial";
}

const COVERAGE_PRIORITY: Record<CoverageState, number> = {
  "not-connected": 0,
  "not-public": 1,
  identified: 2,
  "credential-required": 3,
  partial: 4,
  connected: 5,
};

function stateStatus(
  code: string,
  category: StateCoverageCategory,
  sources: SourceRecord[],
): CoverageState {
  let status: CoverageState =
    category === "procurement" || category === "dotBidding" ? "identified" : "not-connected";
  for (const source of sources) {
    if (sourceStateCode(source) !== code || !sourceCoversCategory(source, category)) continue;
    const candidate = sourceCoverageState(source);
    if (COVERAGE_PRIORITY[candidate] > COVERAGE_PRIORITY[status]) status = candidate;
  }
  return status;
}

export function buildCoverageSummary(
  projects: ProjectRecord[],
  sources: SourceRecord[],
  asOf = new Date().toISOString(),
): CoverageSummary {
  const loadedByState = new Map<string, number>();
  for (const project of projects) {
    const code = normalizeStateCode(project.state);
    if (code) loadedByState.set(code, (loadedByState.get(code) ?? 0) + 1);
  }

  const states: StateCoverageRecord[] = STATES.map(([code, name]) => {
    const registry = STATE_SOURCE_BY_CODE.get(code);
    if (!registry) throw new Error(`Missing state source registry entry for ${code}`);
    return {
      code,
      name,
      procurementUrl: registry.procurementUrl,
      dotBiddingUrl: registry.transportationUrl,
      procurement: stateStatus(code, "procurement", sources),
      dotBidding: stateStatus(code, "dotBidding", sources),
      permits: stateStatus(code, "permits", sources),
      planning: stateStatus(code, "planning", sources),
      loadedProjects: loadedByState.get(code) ?? 0,
    };
  });

  return {
    asOf,
    nationallyComplete: false,
    localGovernmentUniverse: LOCAL_GOVERNMENT_UNIVERSE_2025,
    registryRowsAvailable: CENSUS_REGISTRY_ROWS_2025,
    dependentAgencyRowsAvailable: CENSUS_DEPENDENT_AGENCY_ROWS_2025,
    statesAndDistrict: STATES.length,
    connectedSourceGroups: sources.filter((source) => source.status === "live").length,
    identifiedSourceGroups: STATES.length * 2,
    loadedProjectRecords: projects.length,
    documentTextIndexedProjects: projects.filter((project) => project.documentTextIndexed).length,
    denominatorSourceUrl: CENSUS_GOVERNMENT_UNIVERSE_URL,
    statement:
      "These are records loaded from active public source adapters, not a count of all U.S. construction projects. National completeness is earned only when every jurisdiction-stage source is covered and current.",
    states,
  };
}

export function allStateOptions(): ReadonlyArray<readonly [string, string]> {
  return STATES;
}
