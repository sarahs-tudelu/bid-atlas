export const PORTAL_CLASSIFIER_VERSION = "2026-07-20.1";

export const PORTAL_FAMILIES = [
  "socrata",
  "arcgis",
  "ckan",
  "carto",
  "opengov",
  "bonfire",
  "planetbids",
  "bidnet",
  "ionwave",
  "demandstar",
  "public-purchase",
  "html",
  "manual",
  "unknown",
] as const;

export type PortalFamily = (typeof PORTAL_FAMILIES)[number];
export type PortalConfidence = "high" | "medium" | "low";

export interface PortalClassificationInput {
  url: string;
  title?: string;
  description?: string;
  owner?: string;
}

export interface PortalClassificationEvidence {
  family: PortalFamily;
  kind: "hostname" | "path" | "metadata" | "fallback" | "safety";
  signal: string;
  weight: number;
  description: string;
}

export interface PortalClassification {
  family: PortalFamily;
  confidence: PortalConfidence;
  confidenceScore: number;
  canonicalUrl: string | null;
  evidence: PortalClassificationEvidence[];
  conflictingFamilies: Array<{
    family: PortalFamily;
    confidenceScore: number;
  }>;
  requiresHumanReview: true;
}

export interface PortalCandidateInput extends PortalClassificationInput {
  sourceKey: string;
  official: boolean;
}

export interface SafePortalAdapterCandidate {
  id: string;
  sourceKey: string;
  family: PortalFamily;
  candidateKind:
    | "api-family-review"
    | "portal-family-review"
    | "html-source-review"
    | "manual-source-review";
  officialUrl: string;
  verificationStatus: "unverified";
  connectionState: "not-connected";
  confidence: PortalConfidence;
  confidenceScore: number;
  evidence: PortalClassificationEvidence[];
  safety: {
    automatedNetworkAccess: "disabled-until-reviewed";
    allowedMethodsAfterReview: Array<"GET" | "HEAD">;
    credentialPolicy: "never-automate-or-store";
    accessControlPolicy: "do-not-bypass";
    publicMetadataOnly: true;
    robotsReviewRequired: true;
    termsReviewRequired: true;
    rateLimitReviewRequired: true;
  };
}

interface PatternSignal {
  pattern: RegExp;
  signal: string;
  weight: number;
}

interface PlatformRule {
  family: Exclude<PortalFamily, "html" | "unknown">;
  label: string;
  hostnameSuffixes?: Array<{ suffix: string; weight: number }>;
  paths?: PatternSignal[];
  metadata?: PatternSignal[];
}

const PLATFORM_RULES: PlatformRule[] = [
  {
    family: "socrata",
    label: "Socrata/SODA",
    hostnameSuffixes: [{ suffix: "socrata.com", weight: 0.98 }],
    paths: [
      {
        pattern: /\/resource\/[a-z0-9]{4}-[a-z0-9]{4}(?:\.(?:json|geojson|csv))?(?:\/|$)/i,
        signal: "socrata-resource-route",
        weight: 0.94,
      },
      {
        pattern: /\/api\/views\/[a-z0-9]{4}-[a-z0-9]{4}(?:\/|$)/i,
        signal: "socrata-view-route",
        weight: 0.92,
      },
    ],
    metadata: [
      { pattern: /\bsocrata\b/i, signal: "socrata-name", weight: 0.88 },
      { pattern: /\bsoda\s+api\b/i, signal: "soda-api-name", weight: 0.86 },
    ],
  },
  {
    family: "arcgis",
    label: "ArcGIS",
    hostnameSuffixes: [
      { suffix: "arcgis.com", weight: 0.98 },
      { suffix: "arcgisonline.com", weight: 0.96 },
    ],
    paths: [
      {
        pattern: /\/arcgis\/rest\/services(?:\/|$)/i,
        signal: "arcgis-feature-service-route",
        weight: 0.97,
      },
      {
        pattern: /\/sharing\/rest(?:\/|$)/i,
        signal: "arcgis-sharing-route",
        weight: 0.9,
      },
    ],
    metadata: [{ pattern: /\barcgis\b/i, signal: "arcgis-name", weight: 0.88 }],
  },
  {
    family: "ckan",
    label: "CKAN",
    paths: [
      {
        pattern: /\/api\/3\/action(?:\/|$)/i,
        signal: "ckan-action-api-route",
        weight: 0.98,
      },
      {
        pattern: /\/dataset(?:\/|$)/i,
        signal: "ckan-dataset-route",
        weight: 0.62,
      },
    ],
    metadata: [{ pattern: /\bckan\b/i, signal: "ckan-name", weight: 0.9 }],
  },
  {
    family: "carto",
    label: "Carto",
    hostnameSuffixes: [{ suffix: "carto.com", weight: 0.96 }],
    paths: [
      {
        pattern: /\/api\/v2\/sql(?:\/|$)/i,
        signal: "carto-sql-api-route",
        weight: 0.98,
      },
    ],
    metadata: [{ pattern: /\bcarto\b/i, signal: "carto-name", weight: 0.9 }],
  },
  {
    family: "opengov",
    label: "OpenGov Procurement",
    hostnameSuffixes: [
      { suffix: "opengov.com", weight: 0.98 },
      { suffix: "procurenow.com", weight: 0.96 },
    ],
    metadata: [
      { pattern: /\bopengov\b/i, signal: "opengov-name", weight: 0.9 },
      { pattern: /\bprocure\s*now\b/i, signal: "procurenow-name", weight: 0.86 },
    ],
  },
  {
    family: "bonfire",
    label: "Bonfire",
    hostnameSuffixes: [{ suffix: "bonfirehub.com", weight: 0.98 }],
    metadata: [{ pattern: /\bbonfire\b/i, signal: "bonfire-name", weight: 0.9 }],
  },
  {
    family: "planetbids",
    label: "PlanetBids",
    hostnameSuffixes: [{ suffix: "planetbids.com", weight: 0.98 }],
    metadata: [{ pattern: /\bplanet\s*bids?\b/i, signal: "planetbids-name", weight: 0.9 }],
  },
  {
    family: "bidnet",
    label: "BidNet Direct",
    hostnameSuffixes: [
      { suffix: "bidnetdirect.com", weight: 0.98 },
      { suffix: "bidnet.com", weight: 0.94 },
    ],
    metadata: [{ pattern: /\bbidnet(?:\s+direct)?\b/i, signal: "bidnet-name", weight: 0.9 }],
  },
  {
    family: "ionwave",
    label: "IonWave",
    hostnameSuffixes: [
      { suffix: "ionwave.net", weight: 0.98 },
      { suffix: "ionwave.com", weight: 0.96 },
    ],
    metadata: [{ pattern: /\bionwave\b/i, signal: "ionwave-name", weight: 0.9 }],
  },
  {
    family: "demandstar",
    label: "DemandStar",
    hostnameSuffixes: [{ suffix: "demandstar.com", weight: 0.98 }],
    metadata: [{ pattern: /\bdemand\s*star\b/i, signal: "demandstar-name", weight: 0.9 }],
  },
  {
    family: "public-purchase",
    label: "Public Purchase",
    hostnameSuffixes: [{ suffix: "publicpurchase.com", weight: 0.98 }],
    metadata: [
      { pattern: /\bpublic\s+purchase\b/i, signal: "public-purchase-name", weight: 0.9 },
    ],
  },
  {
    family: "manual",
    label: "manual process",
    metadata: [
      {
        pattern: /\b(?:submit|send|deliver)\s+(?:the\s+)?bids?\s+by\s+(?:email|mail|hand)\b/i,
        signal: "manual-submission-language",
        weight: 0.82,
      },
      {
        pattern: /\bcontact\s+(?:the\s+)?(?:purchasing|procurement)\s+(?:office\s+)?for\s+(?:bid|solicitation|plan)\s+documents?\b/i,
        signal: "manual-document-request-language",
        weight: 0.8,
      },
    ],
  },
];

const API_FAMILIES = new Set<PortalFamily>(["socrata", "arcgis", "ckan", "carto"]);
const VENDOR_PORTAL_FAMILIES = new Set<PortalFamily>([
  "opengov",
  "bonfire",
  "planetbids",
  "bidnet",
  "ionwave",
  "demandstar",
  "public-purchase",
]);
const DIRECT_DOCUMENT_PATTERN = /\.(?:pdf|docx?|xlsx?|zip)(?:$|\/)/i;
const SENSITIVE_QUERY_KEY = /^(?:api[_-]?key|access[_-]?token|auth|authorization|password|secret|signature|sig|token)$/i;

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(0.99, value)) * 1_000) / 1_000;
}

function confidenceFor(score: number): PortalConfidence {
  if (score >= 0.85) return "high";
  if (score >= 0.65) return "medium";
  return "low";
}

function hostnameMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function normalizeMetadata(input: PortalClassificationInput): string {
  return [input.title, input.description, input.owner]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeUrl(rawUrl: string):
  | { canonicalUrl: string; parsed: URL }
  | { canonicalUrl: null; issue: "invalid-url" | "unsupported-scheme" | "credential-bearing-url" } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { canonicalUrl: null, issue: "invalid-url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { canonicalUrl: null, issue: "unsupported-scheme" };
  }
  if (parsed.username || parsed.password) {
    return { canonicalUrl: null, issue: "credential-bearing-url" };
  }
  if ([...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) {
    return { canonicalUrl: null, issue: "credential-bearing-url" };
  }

  const orderedQuery = [...parsed.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  );
  parsed.search = "";
  for (const [key, value] of orderedQuery) parsed.searchParams.append(key, value);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  return { canonicalUrl: parsed.toString(), parsed };
}

function combinedScore(weights: number[]): number {
  return roundScore(1 - weights.reduce((remaining, weight) => remaining * (1 - weight), 1));
}

function unknownClassification(issue: string): PortalClassification {
  return {
    family: "unknown",
    confidence: "low",
    confidenceScore: 0,
    canonicalUrl: null,
    evidence: [
      {
        family: "unknown",
        kind: "safety",
        signal: issue,
        weight: 1,
        description:
          issue === "credential-bearing-url"
            ? "The URL contained credential-like material and was rejected without retaining it."
            : "The value is not a usable public HTTP(S) source root.",
      },
    ],
    conflictingFamilies: [],
    requiresHumanReview: true,
  };
}

export function classifyPortal(input: PortalClassificationInput): PortalClassification {
  const normalized = canonicalizeUrl(input.url);
  if ("issue" in normalized) return unknownClassification(normalized.issue);

  const { parsed, canonicalUrl } = normalized;
  const hostname = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (DIRECT_DOCUMENT_PATTERN.test(path)) {
    return {
      family: "manual",
      confidence: "high",
      confidenceScore: 0.98,
      canonicalUrl,
      evidence: [
        {
          family: "manual",
          kind: "path",
          signal: "direct-document-url",
          weight: 0.98,
          description: "The official root points to a document rather than a queryable portal.",
        },
      ],
      conflictingFamilies: [],
      requiresHumanReview: true,
    };
  }

  const metadata = normalizeMetadata(input);
  const evidence: PortalClassificationEvidence[] = [];
  for (const rule of PLATFORM_RULES) {
    for (const marker of rule.hostnameSuffixes ?? []) {
      if (!hostnameMatches(hostname, marker.suffix)) continue;
      evidence.push({
        family: rule.family,
        kind: "hostname",
        signal: `hostname:${marker.suffix}`,
        weight: marker.weight,
        description: `The official hostname matches the ${rule.label} domain family.`,
      });
    }
    for (const marker of rule.paths ?? []) {
      if (!marker.pattern.test(path)) continue;
      evidence.push({
        family: rule.family,
        kind: "path",
        signal: marker.signal,
        weight: marker.weight,
        description: `The official URL path matches a ${rule.label} route pattern.`,
      });
    }
    for (const marker of rule.metadata ?? []) {
      if (!marker.pattern.test(metadata)) continue;
      evidence.push({
        family: rule.family,
        kind: "metadata",
        signal: marker.signal,
        weight: marker.weight,
        description: `The supplied official-source metadata identifies ${rule.label}.`,
      });
    }
  }

  if (evidence.length === 0) {
    return {
      family: "html",
      confidence: "low",
      confidenceScore: 0.55,
      canonicalUrl,
      evidence: [
        {
          family: "html",
          kind: "fallback",
          signal: "public-http-root",
          weight: 0.55,
          description:
            "The official HTTP(S) root has no recognized API or procurement-portal signature.",
        },
      ],
      conflictingFamilies: [],
      requiresHumanReview: true,
    };
  }

  const scores = new Map<PortalFamily, number[]>();
  for (const item of evidence) {
    scores.set(item.family, [...(scores.get(item.family) ?? []), item.weight]);
  }
  const ranked = [...scores].map(([family, weights]) => ({
    family,
    confidenceScore: combinedScore(weights),
  })).sort((left, right) =>
    right.confidenceScore - left.confidenceScore ||
    PORTAL_FAMILIES.indexOf(left.family) - PORTAL_FAMILIES.indexOf(right.family),
  );
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const adjustedScore = roundScore(
    winner.confidenceScore -
      (runnerUp && runnerUp.confidenceScore >= 0.65
        ? Math.min(0.2, runnerUp.confidenceScore * 0.15)
        : 0),
  );
  evidence.sort((left, right) =>
    Number(right.family === winner.family) - Number(left.family === winner.family) ||
    right.weight - left.weight ||
    left.signal.localeCompare(right.signal),
  );

  return {
    family: winner.family,
    confidence: confidenceFor(adjustedScore),
    confidenceScore: adjustedScore,
    canonicalUrl,
    evidence,
    conflictingFamilies: ranked.slice(1).filter((item) => item.confidenceScore >= 0.5),
    requiresHumanReview: true,
  };
}

function stableHash128(value: string): string {
  let first = 1_779_033_703;
  let second = 3_144_134_277;
  let third = 1_013_904_242;
  let fourth = 2_773_480_762;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = second ^ Math.imul(first ^ code, 597_399_067);
    second = third ^ Math.imul(second ^ code, 2_869_860_233);
    third = fourth ^ Math.imul(third ^ code, 951_274_213);
    fourth = first ^ Math.imul(fourth ^ code, 2_716_044_179);
  }
  first = Math.imul(third ^ (first >>> 18), 597_399_067);
  second = Math.imul(fourth ^ (second >>> 22), 2_869_860_233);
  third = Math.imul(first ^ (third >>> 17), 951_274_213);
  fourth = Math.imul(second ^ (fourth >>> 19), 2_716_044_179);
  first ^= second ^ third ^ fourth;
  second ^= first;
  third ^= first;
  fourth ^= first;
  return [first, second, third, fourth]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function sourceSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "official-source";
}

export function createSafePortalAdapterCandidate(
  input: PortalCandidateInput,
  classification = classifyPortal(input),
): SafePortalAdapterCandidate | null {
  const sourceKey = input.sourceKey.trim();
  if (!input.official || !sourceKey || !classification.canonicalUrl) return null;

  const candidateKind = API_FAMILIES.has(classification.family)
    ? "api-family-review"
    : VENDOR_PORTAL_FAMILIES.has(classification.family)
      ? "portal-family-review"
      : classification.family === "html"
        ? "html-source-review"
        : "manual-source-review";
  const allowedMethodsAfterReview: Array<"GET" | "HEAD"> =
    classification.family === "manual" || classification.family === "unknown"
      ? []
      : ["GET", "HEAD"];
  const identityMaterial = `${sourceKey}\n${classification.family}\n${classification.canonicalUrl}`;

  return {
    id: `portal-candidate:${sourceSlug(sourceKey)}:${stableHash128(identityMaterial)}`,
    sourceKey,
    family: classification.family,
    candidateKind,
    officialUrl: classification.canonicalUrl,
    verificationStatus: "unverified",
    connectionState: "not-connected",
    confidence: classification.confidence,
    confidenceScore: classification.confidenceScore,
    evidence: classification.evidence,
    safety: {
      automatedNetworkAccess: "disabled-until-reviewed",
      allowedMethodsAfterReview,
      credentialPolicy: "never-automate-or-store",
      accessControlPolicy: "do-not-bypass",
      publicMetadataOnly: true,
      robotsReviewRequired: true,
      termsReviewRequired: true,
      rateLimitReviewRequired: true,
    },
  };
}
