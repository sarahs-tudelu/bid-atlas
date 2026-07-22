import type { Metadata } from "next";
import { getPersistedProjectById } from "../../db/search-repository";
import { DashboardClient } from "../DashboardClient";
import { getChatGPTUser } from "../chatgpt-auth";
import {
  getProjectFeed,
  lookupSamOpportunityProject,
  lookupSeattlePermitProject,
  lookupSocrataCityProject,
  lookupStandardizedProject,
} from "../lib/connectors";
import { mergeProjectRecords } from "../lib/project-records";
import { resolveIntegrationCredential } from "../lib/integration-credentials";
import { lookupNycCityRecordConstructionProject } from "../lib/socrata-city-connectors";
import type { ProjectRecord } from "../lib/types";

export const metadata: Metadata = {
  title: "Bid Desk — BidAtlas",
  description:
    "Prepare a controlled quote package, verify project recipients, and review readiness without sending externally.",
};

export const dynamic = "force-dynamic";

interface BidDeskPageProps {
  searchParams: Promise<{
    project?: string | string[];
    drawings?: string | string[];
  }>;
}

type ExactProjectLookup = {
  project?: ProjectRecord;
  error?: string;
};

const STANDARDIZED_PROJECT_PREFIXES = [
  "tempe-building-permits-arcgis:",
  "pittsburgh-pli-permits-ckan:",
  "boston-approved-building-permits-ckan:",
  "miami-ibuild-plan-review-arcgis:",
] as const;

async function lookupExactSeattleProject(
  initialProjectId: string | undefined,
): Promise<ExactProjectLookup | undefined> {
  if (!initialProjectId?.startsWith("seattle-building-permits:")) return undefined;
  try {
    return { project: await lookupSeattlePermitProject(initialProjectId) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unknown Seattle project lookup error",
    };
  }
}

async function lookupExactNycCityRecordProject(
  initialProjectId: string | undefined,
): Promise<ExactProjectLookup | undefined> {
  if (!initialProjectId?.startsWith("nyc-city-record-construction-procurement:")) {
    return undefined;
  }
  try {
    return {
      project:
        (await lookupNycCityRecordConstructionProject(initialProjectId)) ?? undefined,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unknown NYC City Record project lookup error",
    };
  }
}

async function lookupExactSocrataCityProject(
  initialProjectId: string | undefined,
): Promise<ExactProjectLookup | undefined> {
  if (
    !initialProjectId ||
    initialProjectId.startsWith("nyc-city-record-construction-procurement:")
  ) {
    return undefined;
  }
  try {
    const project = await lookupSocrataCityProject(initialProjectId);
    return project ? { project } : undefined;
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unknown city permit project lookup error",
    };
  }
}

async function lookupExactSamProject(
  initialProjectId: string | undefined,
  apiKey: string | undefined,
): Promise<ExactProjectLookup | undefined> {
  if (!initialProjectId?.startsWith("sam-contract-opportunities:")) return undefined;
  if (!apiKey) {
    return { error: "Add a SAM.gov public API key in Integrations to refresh this exact notice." };
  }
  try {
    return {
      project: (await lookupSamOpportunityProject(initialProjectId, apiKey)) ?? undefined,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Unknown SAM.gov exact notice lookup error",
    };
  }
}

async function lookupExactStandardizedProject(
  initialProjectId: string | undefined,
): Promise<ExactProjectLookup | undefined> {
  if (
    !initialProjectId ||
    !STANDARDIZED_PROJECT_PREFIXES.some((prefix) => initialProjectId.startsWith(prefix))
  ) {
    return undefined;
  }
  try {
    return { project: await lookupStandardizedProject(initialProjectId) };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unknown standardized project lookup error",
    };
  }
}

export default async function BidDeskPage({ searchParams }: BidDeskPageProps) {
  const params = await searchParams;
  const requestedProject = Array.isArray(params.project) ? params.project[0] : params.project;
  const initialProjectId = requestedProject?.trim().slice(0, 300) || undefined;
  const requestedDrawingAction = Array.isArray(params.drawings)
    ? params.drawings[0]
    : params.drawings;
  const initialDrawingAction = requestedDrawingAction === "view" || requestedDrawingAction === "download"
    ? requestedDrawingAction : undefined;
  const user = await getChatGPTUser();
  const samCredential = await resolveIntegrationCredential(user?.email.toLowerCase(), "sam");
  const [
    liveFeed,
    persistedProject,
    exactSeattleLookup,
    exactNycCityRecordLookup,
    exactSocrataCityLookup,
    exactSamLookup,
    exactStandardizedLookup,
  ] =
    await Promise.all([
      getProjectFeed({ samApiKey: samCredential?.apiKey }),
      initialProjectId
        ? getPersistedProjectById(initialProjectId)
        : Promise.resolve(undefined),
      lookupExactSeattleProject(initialProjectId),
      lookupExactNycCityRecordProject(initialProjectId),
      lookupExactSocrataCityProject(initialProjectId),
      lookupExactSamProject(initialProjectId, samCredential?.apiKey),
      lookupExactStandardizedProject(initialProjectId),
    ]);
  let projects = liveFeed.projects;
  const linkedCandidates = [
    persistedProject?.available ? persistedProject.project : undefined,
    exactSeattleLookup?.project,
    exactNycCityRecordLookup?.project,
    exactSocrataCityLookup?.project,
    exactSamLookup?.project,
    exactStandardizedLookup?.project,
    projects.find((project) => project.id === initialProjectId),
  ].filter((project): project is ProjectRecord => Boolean(project));
  const linkedProject = linkedCandidates.reduce<ProjectRecord | undefined>(
    (merged, project) => (merged ? mergeProjectRecords(merged, project) : project),
    undefined,
  );
  if (linkedProject) {
    projects = [linkedProject, ...projects.filter((project) => project.id !== linkedProject.id)];
  } else if (initialProjectId) {
    // Any explicit deep link is an exact request. Do not substitute a
    // different opportunity when the requested record is unavailable or its
    // source-specific lookup has not been implemented yet.
    projects = [];
  }
  const linkedProjectUnresolved = Boolean(initialProjectId && !linkedProject);
  const lookupWarnings = [
    persistedProject && !persistedProject.available && persistedProject.reason === "query-failed"
      ? `Linked project lookup failed: ${persistedProject.error}`
      : undefined,
    exactSeattleLookup?.error
      ? `Exact Seattle project lookup failed: ${exactSeattleLookup.error}`
      : undefined,
    exactNycCityRecordLookup?.error
      ? `Exact NYC City Record project lookup failed: ${exactNycCityRecordLookup.error}`
      : undefined,
    exactSocrataCityLookup?.error
      ? `Exact city permit project lookup failed: ${exactSocrataCityLookup.error}`
      : undefined,
    exactSamLookup?.error
      ? `Exact SAM.gov notice lookup failed: ${exactSamLookup.error}`
      : undefined,
    exactStandardizedLookup?.error
      ? `Exact standardized project lookup failed: ${exactStandardizedLookup.error}`
      : undefined,
  ].filter((warning): warning is string => Boolean(warning));
  const feed = {
    ...liveFeed,
    projects,
    warnings: [...liveFeed.warnings, ...lookupWarnings],
  };

  return (
    <>
      {linkedProjectUnresolved && (
        <div className="bid-desk-route-notice" role="alert">
          The linked official project could not be resolved from the persisted index or its public
          source. No alternate project was selected.
        </div>
      )}
      <DashboardClient
        key={initialProjectId ?? "default"}
        feed={feed}
        view="bid-desk"
        initialProjectId={linkedProjectUnresolved ? undefined : initialProjectId}
        initialDrawingAction={linkedProjectUnresolved ? undefined : initialDrawingAction}
      />
    </>
  );
}
