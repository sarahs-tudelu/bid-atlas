import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PORTAL_CLASSIFIER_VERSION,
  classifyPortal,
  createSafePortalAdapterCandidate,
} from "../app/lib/portal-classification.ts";
import { STATE_SOURCE_REGISTRY } from "../app/lib/state-source-registry.ts";

const MANAGED_BY = "state-source-registry-classifier";
const SOURCE_MODULE = "app/lib/state-source-registry.ts";

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function checkedAtValue(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error(`Invalid --checked-at timestamp: ${value}`);
  return parsed.toISOString();
}

async function exists(path) {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(path) {
  if (!path || !(await exists(path))) return null;
  const payload = JSON.parse(await readFile(path, "utf8"));
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.records)) {
    throw new Error(`Existing portal manifest is invalid: ${path}`);
  }
  return payload;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sourceRoots() {
  return STATE_SOURCE_REGISTRY.flatMap((state) => [
    {
      sourceKey: `state:${state.code}:procurement`,
      stateCode: state.code,
      jurisdictionName: state.name,
      sourceClass: "procurement",
      sourceCategory: "statewide-procurement",
      sourceField: "procurementUrl",
      url: state.procurementUrl,
      title: `${state.name} statewide procurement discovery root`,
      description:
        "Official statewide procurement starting point; classification is metadata-only and not coverage proof.",
    },
    {
      sourceKey: `state:${state.code}:transportation`,
      stateCode: state.code,
      jurisdictionName: state.name,
      sourceClass: "procurement",
      sourceCategory: "transportation",
      sourceField: "transportationUrl",
      url: state.transportationUrl,
      title: `${state.name} transportation letting discovery root`,
      description:
        "Official state transportation contracting starting point; classification is metadata-only and not coverage proof.",
    },
  ]).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function boundedText(value, maximumLength) {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}

function observedMetadataFor(root, previous) {
  const metadata = previous?.observedMetadata;
  if (!metadata || typeof metadata !== "object" || metadata.sourceUrl !== root.url) return null;
  const observedMetadata = {
    sourceUrl: root.url,
    title: boundedText(metadata.title, 500),
    description: boundedText(metadata.description, 2_000),
    owner: boundedText(metadata.owner, 500),
    observedAt: boundedText(metadata.observedAt, 64),
  };
  return Object.fromEntries(
    Object.entries(observedMetadata).filter(([, value]) => value !== undefined),
  );
}

function buildManagedRecord(root, previous, checkedAt, recheckAll) {
  const observedMetadata = observedMetadataFor(root, previous);
  const classification = classifyPortal({
    url: root.url,
    title: [root.title, observedMetadata?.title].filter(Boolean).join(" "),
    description: [root.description, observedMetadata?.description].filter(Boolean).join(" "),
    owner: [root.jurisdictionName, observedMetadata?.owner].filter(Boolean).join(" "),
  });
  const candidate = createSafePortalAdapterCandidate({
    sourceKey: root.sourceKey,
    official: true,
    url: root.url,
    title: [root.title, observedMetadata?.title].filter(Boolean).join(" "),
    description: [root.description, observedMetadata?.description].filter(Boolean).join(" "),
    owner: [root.jurisdictionName, observedMetadata?.owner].filter(Boolean).join(" "),
  }, classification);
  if (!candidate) throw new Error(`Official source root is not a safe candidate: ${root.sourceKey}`);

  const sourceFingerprint = fingerprint({
    classifierVersion: PORTAL_CLASSIFIER_VERSION,
    root,
    observedMetadata,
    classification,
    candidate,
  });
  const unchanged =
    previous?.managedBy === MANAGED_BY &&
    previous.sourceFingerprint === sourceFingerprint &&
    typeof previous.lastCheckedAt === "string" &&
    !recheckAll;
  const lastCheckedAt = unchanged ? previous.lastCheckedAt : checkedAt;
  const lastObservedAt = unchanged
    ? (previous.provenance?.lastObservedAt ?? previous.lastCheckedAt)
    : checkedAt;

  return {
    record: {
      ...(previous ?? {}),
      sourceKey: root.sourceKey,
      managedBy: MANAGED_BY,
      registryStatus: "active",
      stateCode: root.stateCode,
      jurisdictionName: root.jurisdictionName,
      sourceClass: root.sourceClass,
      sourceCategory: root.sourceCategory,
      officialUrl: root.url,
      title: root.title,
      description: root.description,
      classifierVersion: PORTAL_CLASSIFIER_VERSION,
      sourceFingerprint,
      classification,
      adapterCandidate: candidate,
      observedMetadata: observedMetadata ?? undefined,
      verificationStatus: "unverified",
      connectionState: "not-connected",
      checkScope: "registry-metadata-only",
      firstSeenAt: previous?.firstSeenAt ?? checkedAt,
      lastCheckedAt,
      provenance: {
        ...(previous?.provenance ?? {}),
        kind: "official-source-root",
        sourceModule: SOURCE_MODULE,
        sourceRecordKey: root.stateCode,
        sourceField: root.sourceField,
        observedUrl: root.url,
        firstObservedAt: previous?.provenance?.firstObservedAt ?? checkedAt,
        lastObservedAt,
      },
    },
    changed: !unchanged,
  };
}

function familyCounts(records) {
  const counts = {};
  for (const record of records) {
    const family = record.classification?.family ?? "unclassified";
    counts[family] = (counts[family] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

const args = process.argv.slice(2);
if (hasFlag(args, "--help")) {
  console.log(`Usage: node scripts/enrich-jurisdiction-source-seeds.mjs [options]

Options:
  --out <path>          Write the deterministic enriched manifest.
  --existing <path>     Merge a prior manifest (defaults to --out when it exists).
  --checked-at <ISO>    Timestamp for new, changed, or explicitly rechecked roots.
  --recheck-all         Refresh lastCheckedAt for every managed official root.

The script performs metadata-only classification. It does not fetch portals,
submit credentials, create live connectors, or mark coverage connected.`);
  process.exit(0);
}

const outputArgument = argumentValue(args, "--out");
const outputPath = outputArgument ? resolve(outputArgument) : undefined;
const existingArgument = argumentValue(args, "--existing");
const existingPath = existingArgument
  ? resolve(existingArgument)
  : outputPath && (await exists(outputPath))
    ? outputPath
    : undefined;
const checkedAt = checkedAtValue(
  argumentValue(args, "--checked-at") ?? process.env.PORTAL_CLASSIFIER_CHECKED_AT,
);
const recheckAll = hasFlag(args, "--recheck-all");
const existing = await readManifest(existingPath);
const existingRecords = new Map(
  (existing?.records ?? [])
    .filter((record) => record && typeof record.sourceKey === "string")
    .map((record) => [record.sourceKey, record]),
);

let changedRecords = 0;
const currentSourceKeys = new Set();
const records = sourceRoots().map((root) => {
  currentSourceKeys.add(root.sourceKey);
  const result = buildManagedRecord(root, existingRecords.get(root.sourceKey), checkedAt, recheckAll);
  if (result.changed) changedRecords += 1;
  return result.record;
});

for (const previous of existingRecords.values()) {
  if (currentSourceKeys.has(previous.sourceKey)) continue;
  // Preserve separately managed jurisdiction roots and review annotations. A
  // future registry-removal workflow can explicitly retire managed state roots;
  // this classifier never deletes seed provenance on its own.
  records.push(previous);
}
records.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));

const manifest = {
  ...(existing ?? {}),
  schemaVersion: 1,
  classifierVersion: PORTAL_CLASSIFIER_VERSION,
  generatedAt:
    changedRecords > 0 || !existing?.generatedAt ? checkedAt : existing.generatedAt,
  sourceRegistry: {
    kind: "official-state-and-dc-roots",
    sourceModule: SOURCE_MODULE,
    stateAndDistrictRecords: STATE_SOURCE_REGISTRY.length,
    officialRoots: STATE_SOURCE_REGISTRY.length * 2,
  },
  recordCount: records.length,
  managedRecordCount: records.filter((record) => record.managedBy === MANAGED_BY).length,
  familyCounts: familyCounts(records),
  records,
};

if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({
  classifierVersion: PORTAL_CLASSIFIER_VERSION,
  checkedAt,
  changedRecords,
  preservedRecords: records.length - changedRecords,
  recordCount: records.length,
  managedRecordCount: manifest.managedRecordCount,
  familyCounts: manifest.familyCounts,
  outputPath,
}, null, 2));
