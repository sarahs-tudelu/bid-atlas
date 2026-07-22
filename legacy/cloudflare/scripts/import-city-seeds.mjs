import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STATE_CODE_BY_NAME = new Map([
  ["ALABAMA", "AL"], ["ALASKA", "AK"], ["ARIZONA", "AZ"], ["ARKANSAS", "AR"],
  ["CALIFORNIA", "CA"], ["COLORADO", "CO"], ["CONNECTICUT", "CT"], ["DELAWARE", "DE"],
  ["FLORIDA", "FL"], ["GEORGIA", "GA"], ["HAWAII", "HI"], ["IDAHO", "ID"],
  ["ILLINOIS", "IL"], ["INDIANA", "IN"], ["IOWA", "IA"], ["KANSAS", "KS"],
  ["KENTUCKY", "KY"], ["LOUISIANA", "LA"], ["MAINE", "ME"], ["MARYLAND", "MD"],
  ["MASSACHUSETTS", "MA"], ["MICHIGAN", "MI"], ["MINNESOTA", "MN"], ["MISSISSIPPI", "MS"],
  ["MISSOURI", "MO"], ["MONTANA", "MT"], ["NEBRASKA", "NE"], ["NEVADA", "NV"],
  ["NEW HAMPSHIRE", "NH"], ["NEW JERSEY", "NJ"], ["NEW MEXICO", "NM"], ["NEW YORK", "NY"],
  ["NORTH CAROLINA", "NC"], ["NORTH DAKOTA", "ND"], ["OHIO", "OH"], ["OKLAHOMA", "OK"],
  ["OREGON", "OR"], ["PENNSYLVANIA", "PA"], ["RHODE ISLAND", "RI"], ["SOUTH CAROLINA", "SC"],
  ["SOUTH DAKOTA", "SD"], ["TENNESSEE", "TN"], ["TEXAS", "TX"], ["UTAH", "UT"],
  ["VERMONT", "VT"], ["VIRGINIA", "VA"], ["WASHINGTON", "WA"], ["WEST VIRGINIA", "WV"],
  ["WISCONSIN", "WI"], ["WYOMING", "WY"],
]);

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizeName(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseCityList(text) {
  const states = [];
  const duplicateKeys = new Set();
  const seenKeys = new Set();
  const seenStateCodes = new Set();
  const duplicateStateCodes = new Set();
  const stateHeaderErrors = [];
  const numberingErrors = [];
  let current;

  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    const header = /^(\d+)\.\s+([A-Z][A-Z .'’-]+)\s+\(([\d,]+) places\)$/.exec(line.trim());
    if (header) {
      const stateName = header[2].trim();
      const code = STATE_CODE_BY_NAME.get(stateName);
      if (!code) throw new Error(`Unknown state header on line ${lineIndex + 1}: ${stateName}`);
      const stateOrdinal = Number(header[1]);
      if (stateOrdinal !== states.length + 1) {
        stateHeaderErrors.push({ line: lineIndex + 1, state: code, ordinal: stateOrdinal });
      }
      if (seenStateCodes.has(code)) duplicateStateCodes.add(code);
      seenStateCodes.add(code);
      current = {
        code,
        name: stateName.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()),
        declaredCount: Number(header[3].replaceAll(",", "")),
        places: [],
      };
      states.push(current);
      continue;
    }

    if (!current) continue;
    const place = /^\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (!place) continue;
    const ordinal = Number(place[1]);
    const displayName = place[2].trim();
    if (ordinal !== current.places.length + 1) {
      numberingErrors.push({ line: lineIndex + 1, state: current.code, ordinal });
    }
    const key = `${current.code}:${normalizeName(displayName)}`;
    if (seenKeys.has(key)) duplicateKeys.add(key);
    seenKeys.add(key);
    current.places.push(displayName);
  }

  const declaredTotal = states.reduce((total, state) => total + state.declaredCount, 0);
  const parsedTotal = states.reduce((total, state) => total + state.places.length, 0);
  const countMismatches = states
    .filter((state) => state.declaredCount !== state.places.length)
    .map((state) => ({
      state: state.code,
      declared: state.declaredCount,
      parsed: state.places.length,
    }));

  return {
    states,
    summary: {
      stateCount: states.length,
      declaredTotal,
      parsedTotal,
      duplicateCount: duplicateKeys.size,
      duplicateKeys: [...duplicateKeys].sort(),
      duplicateStateCodes: [...duplicateStateCodes].sort(),
      missingStateCodes: [...STATE_CODE_BY_NAME.values()].filter((code) => !seenStateCodes.has(code)),
      stateHeaderErrorCount: stateHeaderErrors.length,
      numberingErrorCount: numberingErrors.length,
      countMismatches,
    },
  };
}

const args = process.argv.slice(2);
const inputPath = argumentValue(args, "--input") ?? process.env.CITY_LIST_PATH;
const outputPath = argumentValue(args, "--out");

if (!inputPath) {
  throw new Error(
    "Provide --input <all_50_us_states_and_cities_2025.txt> or set CITY_LIST_PATH.",
  );
}

const sourceText = await readFile(resolve(inputPath), "utf8");
const sourceUrl = /^Source:\s*(https?:\/\/\S+)/m.exec(sourceText)?.[1];
const { states, summary } = parseCityList(sourceText);

if (
  summary.stateCount !== 50 ||
  summary.duplicateStateCodes.length !== 0 ||
  summary.missingStateCodes.length !== 0 ||
  summary.stateHeaderErrorCount !== 0 ||
  summary.numberingErrorCount !== 0 ||
  summary.declaredTotal !== summary.parsedTotal ||
  summary.countMismatches.length !== 0
) {
  throw new Error(`City-list validation failed: ${JSON.stringify(summary)}`);
}

const manifest = {
  schemaVersion: 1,
  sourceTitle: "U.S. Census Bureau Vintage 2025 incorporated-place series",
  sourceUrl,
  sourceFile: "all_50_us_states_and_cities_2025.txt",
  sourceFileSha256: createHash("sha256").update(sourceText).digest("hex"),
  districtOfColumbiaIncluded: false,
  recordCount: summary.parsedTotal,
  ambiguousWithinStateNames: summary.duplicateKeys,
  states,
};

if (outputPath) {
  const resolvedOutput = resolve(outputPath);
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(manifest)}\n`, "utf8");
}

console.log(
  JSON.stringify(
    {
      ...summary,
      districtOfColumbiaIncluded: false,
      sourceUrl,
      sourceFileSha256: manifest.sourceFileSha256,
      outputPath: outputPath ? resolve(outputPath) : undefined,
    },
    null,
    2,
  ),
);
