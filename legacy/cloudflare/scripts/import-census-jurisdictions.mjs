import { writeFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";

const CENSUS_URL =
  "https://www2.census.gov/programs-surveys/gus/datasets/2025/gov_units_2025.zip";
const CENSUS_SOURCE_URL =
  "https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html";

function xmlDecode(value = "") {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function attribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return Array.from(xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (match) =>
    Array.from(match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g), (text) =>
      xmlDecode(text[1]),
    ).join(""),
  );
}

function* worksheetRows(xml, sharedStrings) {
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const values = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const reference = attribute(attributes, "r") ?? "A1";
      const type = attribute(attributes, "t");
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const inline = body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1];
      let value = inline !== undefined ? xmlDecode(inline) : xmlDecode(raw ?? "");
      if (type === "s" && raw !== undefined) value = sharedStrings[Number(raw)] ?? "";
      values[columnIndex(reference)] = value;
    }
    yield values;
  }
}

function normalizedHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function valueFrom(record, aliases) {
  for (const alias of aliases) {
    const value = record[alias];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function sqlValue(value) {
  if (value === undefined || value === null || value === "") return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

const DISCOVERY_SOURCE_CLASSES = [
  "planning",
  "permits",
  "procurement",
  "documents",
  "bid-results",
  "awards",
  "capital-plans",
];

function discoverySeedSql() {
  const sourceClasses = sqlValue(JSON.stringify(DISCOVERY_SOURCE_CLASSES));
  return `INSERT INTO jurisdiction_discovery_jobs (
    id,jurisdiction_id,status,priority,required_source_classes,completed_source_classes,
    source_candidates_found,connected_sources,loaded_projects,indexed_documents,
    attempt_count,next_run_at,created_at,updated_at
  )
  SELECT 'discovery:' || id,id,'queued',0,${sourceClasses},'[]',0,0,0,0,0,
    CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  FROM jurisdictions
  WHERE active=1
  ON CONFLICT(jurisdiction_id) DO NOTHING;

  INSERT INTO jurisdiction_metrics (jurisdiction_id,refreshed_at)
  SELECT id,CURRENT_TIMESTAMP
  FROM jurisdictions
  WHERE active=1
  ON CONFLICT(jurisdiction_id) DO NOTHING;`;
}

function mapGovernment(record, registryKind) {
  const governmentId = valueFrom(record, [
    "census_id_pid6",
    "government_id",
    "government_unit_id",
    "govt_id",
    "gov_id",
    "id",
  ]);
  const name = valueFrom(record, [
    "unit_name",
    "government_name",
    "government_unit_name",
    "govt_name",
    "name",
  ]);
  const state = valueFrom(record, ["state_abbreviation", "state_abbr", "state", "st"]);
  const governmentType = valueFrom(record, [
    "unit_type",
    "government_type",
    "government_type_description",
    "govt_type",
    "type",
  ]);
  const fipsState = valueFrom(record, ["fips_state"]);
  const fipsCounty = valueFrom(record, ["fips_county"]);
  const fipsPlace = valueFrom(record, ["fips_place"]);
  const fips = valueFrom(record, ["fips", "fips_code", "government_fips", "county_fips"]) ||
    [fipsState, fipsCounty, fipsPlace].filter(Boolean).join("-");
  const parentId = valueFrom(record, [
    "parent_census_id_pid6",
    "parent_government_id",
    "parent_id",
  ]);

  if (!governmentId || !name) return null;
  return {
    id: `census-2025:${governmentId}`,
    censusGovernmentId: governmentId,
    name,
    governmentType: governmentType || "unclassified",
    registryKind,
    state: state || null,
    fips: fips || null,
    fipsState: fipsState || null,
    fipsCounty: fipsCounty || null,
    fipsPlace: fipsPlace || null,
    parentId: parentId ? `census-2025:${parentId}` : null,
    addressLine1: valueFrom(record, ["address1"]) || null,
    addressLine2: valueFrom(record, ["address2"]) || null,
    city: valueFrom(record, ["city"]) || null,
    postalCode: valueFrom(record, ["zip"]) || null,
    website: valueFrom(record, ["web_address"]) || null,
    politicalCode: valueFrom(record, ["political_code_description"]) || null,
    functionName: valueFrom(record, [
      "function_name",
      "activity_name",
      "school_level_description",
    ]) || null,
    population: Number(valueFrom(record, ["population"])) || null,
    populationYear: Number(valueFrom(record, ["population_source_year"])) || null,
    countyAreaName: valueFrom(record, ["county_area_name"]) || null,
    active: valueFrom(record, ["active"]).toUpperCase() !== "N" ? 1 : 0,
  };
}

function buildSql(records, batchSize = 100) {
  const statements = [
    "-- Generated from the official 2025 Census Government Units Listing.",
    "-- Import with: npx wrangler d1 execute <database> --remote --file=<this-file>",
  ];
  for (let index = 0; index < records.length; index += batchSize) {
    const rows = records.slice(index, index + batchSize).map((record) =>
      `(${[
        record.id,
        record.censusGovernmentId,
        record.name,
        record.governmentType,
        record.registryKind,
        record.state,
        record.fips,
        record.parentId,
        record.fipsState,
        record.fipsCounty,
        record.fipsPlace,
        record.addressLine1,
        record.addressLine2,
        record.city,
        record.postalCode,
        record.website,
        record.politicalCode,
        record.functionName,
        record.population,
        record.populationYear,
        record.countyAreaName,
        record.active,
        CENSUS_SOURCE_URL,
      ].map(sqlValue).join(",")})`,
    );
    statements.push(
      `INSERT INTO jurisdictions (id,census_government_id,name,government_type,registry_kind,state,fips,parent_id,fips_state,fips_county,fips_place,address_line_1,address_line_2,city,postal_code,website,political_code,function_name,population,population_year,county_area_name,active,source_url) VALUES\n${rows.join(",\n")}\nON CONFLICT(id) DO UPDATE SET name=excluded.name,government_type=excluded.government_type,registry_kind=excluded.registry_kind,state=excluded.state,fips=excluded.fips,parent_id=excluded.parent_id,fips_state=excluded.fips_state,fips_county=excluded.fips_county,fips_place=excluded.fips_place,address_line_1=excluded.address_line_1,address_line_2=excluded.address_line_2,city=excluded.city,postal_code=excluded.postal_code,website=excluded.website,political_code=excluded.political_code,function_name=excluded.function_name,population=excluded.population,population_year=excluded.population_year,county_area_name=excluded.county_area_name,active=excluded.active,source_url=excluded.source_url,updated_at=CURRENT_TIMESTAMP;`,
    );
  }
  statements.push(
    "-- One resumable discovery worker job per active registry jurisdiction; a queued row is not a connected source.",
    discoverySeedSql(),
  );
  return `${statements.join("\n\n")}\n`;
}

async function uploadToD1(records) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !databaseId || !token) {
    throw new Error(
      "--upload requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, and CLOUDFLARE_API_TOKEN.",
    );
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const sql = `INSERT INTO jurisdictions (
    id,census_government_id,name,government_type,registry_kind,state,fips,parent_id,
    fips_state,fips_county,fips_place,address_line_1,address_line_2,city,postal_code,
    website,political_code,function_name,population,population_year,county_area_name,active,source_url
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,government_type=excluded.government_type,registry_kind=excluded.registry_kind,state=excluded.state,
    fips=excluded.fips,parent_id=excluded.parent_id,fips_state=excluded.fips_state,
    fips_county=excluded.fips_county,fips_place=excluded.fips_place,
    address_line_1=excluded.address_line_1,address_line_2=excluded.address_line_2,
    city=excluded.city,postal_code=excluded.postal_code,website=excluded.website,
    political_code=excluded.political_code,function_name=excluded.function_name,population=excluded.population,
    population_year=excluded.population_year,county_area_name=excluded.county_area_name,
    active=excluded.active,
    source_url=excluded.source_url,updated_at=CURRENT_TIMESTAMP`;

  for (let index = 0; index < records.length; index += 100) {
    const batch = records.slice(index, index + 100).map((record) => ({
      sql,
      params: [
        record.id,
        record.censusGovernmentId,
        record.name,
        record.governmentType,
        record.registryKind,
        record.state,
        record.fips,
        record.parentId,
        record.fipsState,
        record.fipsCounty,
        record.fipsPlace,
        record.addressLine1,
        record.addressLine2,
        record.city,
        record.postalCode,
        record.website,
        record.politicalCode,
        record.functionName,
        record.population,
        record.populationYear,
        record.countyAreaName,
        record.active,
        CENSUS_SOURCE_URL,
      ],
    }));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch }),
    });
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(`D1 import failed at row ${index}: ${JSON.stringify(body.errors ?? body)}`);
    }
    if (index % 5_000 === 0) console.log(`Uploaded ${index + batch.length}/${records.length}`);
  }

  const seedResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql: discoverySeedSql() }),
  });
  const seedBody = await seedResponse.json();
  if (!seedResponse.ok || !seedBody.success) {
    throw new Error(`D1 discovery-job seeding failed: ${JSON.stringify(seedBody.errors ?? seedBody)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--out");
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  console.log(`Downloading ${CENSUS_URL}`);
  const response = await fetch(CENSUS_URL);
  if (!response.ok) throw new Error(`Census download failed: ${response.status}`);
  const outer = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const workbookName = Object.keys(outer).find((name) => name.toLowerCase().endsWith(".xlsx"));
  if (!workbookName) throw new Error("Census archive did not contain an XLSX workbook.");
  const workbook = unzipSync(outer[workbookName]);
  const sharedStrings = parseSharedStrings(
    workbook["xl/sharedStrings.xml"] ? strFromU8(workbook["xl/sharedStrings.xml"]) : "",
  );
  const worksheetNames = Object.keys(workbook)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (!worksheetNames.length) throw new Error("Census workbook did not contain a worksheet.");
  const recordsById = new Map();
  const preview = [];
  for (const [worksheetIndex, worksheetName] of worksheetNames.entries()) {
    const rows = worksheetRows(strFromU8(workbook[worksheetName]), sharedStrings);
    const headers = Array.from(rows.next().value ?? [], normalizedHeader);
    console.log(`${worksheetName} headers:`, headers.join(", "));
    let worksheetCount = 0;
    for (const row of rows) {
      const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
      if (preview.length < 3) preview.push(record);
      const government = mapGovernment(
        record,
        worksheetIndex < 3 ? "independent-government" : "dependent-agency",
      );
      if (government) {
        recordsById.set(government.id, government);
        worksheetCount += 1;
      }
    }
    console.log(`${worksheetName}: mapped ${worksheetCount.toLocaleString("en-US")} rows.`);
  }

  const records = Array.from(recordsById.values());

  if (args.includes("--inspect")) console.log(JSON.stringify(preview, null, 2));
  console.log(`Mapped ${records.length.toLocaleString("en-US")} government rows.`);
  if (!records.length) {
    throw new Error("No government rows mapped. Inspect the printed headers and update aliases.");
  }
  if (outputPath) {
    await writeFile(outputPath, buildSql(records), "utf8");
    console.log(`Wrote ${outputPath}`);
  }
  if (args.includes("--upload")) {
    await uploadToD1(records);
    console.log("D1 jurisdiction upload complete.");
  }
}

await main();
