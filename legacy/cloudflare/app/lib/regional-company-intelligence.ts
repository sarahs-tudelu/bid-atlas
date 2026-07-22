export type RegionalCompanyRole = "owner" | "contractor";
export type RegionalCompanyState = "NY" | "NJ";

export type CompanyProjectEvidence = {
  id: string;
  title: string;
  city?: string;
  state: RegionalCompanyState;
  sourceName: string;
  sourceUrl: string;
  lastSeenAt: string;
};

export type IndexedRegionalCompany = {
  id: string;
  name: string;
  role: RegionalCompanyRole;
  state?: string;
  projects: CompanyProjectEvidence[];
};

export type OfficialRegistryMatch = {
  registry: "New York contractor registry" | "NYC issued licenses";
  businessName: string;
  alternateName?: string;
  identifier: string;
  status: string;
  licenseType?: string;
  city?: string;
  state?: string;
  phone?: string;
  expiresAt?: string;
  sourceUrl: string;
};

export interface RegionalCompanySearchResult {
  indexed: IndexedRegionalCompany[];
  registryMatches: OfficialRegistryMatch[];
  registryWarnings: string[];
}

interface D1Result<T> {
  results?: T[];
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T>(): Promise<D1Result<T>>;
}

export interface RegionalCompanyD1Database {
  prepare(query: string): D1Statement;
}

type CompanyEvidenceRow = {
  organization_id: string;
  display_name: string;
  organization_state: string | null;
  role: string;
  project_id: string;
  project_title: string;
  project_city: string | null;
  project_state: string;
  source_name: string;
  source_url: string;
  last_seen_at: string;
};

const BUSINESS_NAME_MARKER =
  /\b(?:llc|l\.l\.c\.?|incorporated|inc\.?|corp(?:oration)?\.?|company|co\.?|lp|llp|pllc|pc|p\.c\.|construction|contracting|contractors?|builders?|building|consulting|enterprises?|management|realty|development|developers?|properties|partners|holdings|group|associates?|services|design|engineering|architects?)\b/i;

function isBusinessName(value: string): boolean {
  return BUSINESS_NAME_MARKER.test(value);
}

function cleanQuery(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function soqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function sourceRowUrl(domain: string, datasetId: string, field: string, value: string): string {
  const params = new URLSearchParams({
    "$where": `${field} = '${soqlLiteral(value)}'`,
    "$limit": "1",
  });
  return `https://${domain}/resource/${datasetId}.json?${params}`;
}

async function getRegionalCompanyDatabase(): Promise<RegionalCompanyD1Database | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return ((env as unknown as { DB?: RegionalCompanyD1Database }).DB ?? null);
  } catch {
    return null;
  }
}

async function searchIndexedCompanies(
  db: RegionalCompanyD1Database | null,
  query: string,
  role: RegionalCompanyRole | "all",
  state: RegionalCompanyState | "all",
): Promise<IndexedRegionalCompany[]> {
  if (!db) return [];
  const normalizedQuery = cleanQuery(query).toLocaleLowerCase("en-US");
  const pattern = normalizedQuery ? `%${normalizedQuery}%` : "%";
  const rows = await db
    .prepare(
      `SELECT o.id AS organization_id,
              o.display_name,
              o.state AS organization_state,
              pp.role,
              p.id AS project_id,
              p.title AS project_title,
              p.city AS project_city,
              p.state AS project_state,
              s.name AS source_name,
              ps.source_url,
              pp.last_seen_at
         FROM organizations o
         JOIN project_participants pp ON pp.organization_id=o.id
         JOIN projects p ON p.id=pp.project_id
         JOIN sources s ON s.id=pp.source_id
         JOIN project_sources ps
           ON ps.project_id=p.id AND ps.source_id=pp.source_id
        WHERE p.state IN ('NY','NJ')
          AND pp.role IN ('owner','contractor')
          AND (?='all' OR pp.role=?)
          AND (?='all' OR p.state=?)
          AND lower(o.display_name) LIKE ?
        ORDER BY pp.last_seen_at DESC, o.display_name ASC
        LIMIT 240`,
    )
    .bind(role, role, state, state, pattern)
    .all<CompanyEvidenceRow>();

  const companies = new Map<string, IndexedRegionalCompany>();
  for (const row of rows.results ?? []) {
    if (
      (row.role !== "owner" && row.role !== "contractor") ||
      (row.project_state !== "NY" && row.project_state !== "NJ") ||
      !isBusinessName(row.display_name)
    ) {
      continue;
    }
    const key = `${row.organization_id}:${row.role}`;
    const company = companies.get(key) ?? {
      id: row.organization_id,
      name: row.display_name,
      role: row.role,
      ...(row.organization_state ? { state: row.organization_state } : {}),
      projects: [],
    };
    if (
      company.projects.length < 5 &&
      !company.projects.some((project) => project.id === row.project_id)
    ) {
      company.projects.push({
        id: row.project_id,
        title: row.project_title,
        ...(row.project_city ? { city: row.project_city } : {}),
        state: row.project_state,
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        lastSeenAt: row.last_seen_at,
      });
    }
    companies.set(key, company);
  }
  return [...companies.values()].slice(0, 60);
}

async function fetchJsonRows<T>(url: string): Promise<T[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "BidAtlas/0.1 public-company-verifier",
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const rows = await response.json() as unknown;
    if (!Array.isArray(rows)) throw new Error("Official registry did not return a row array.");
    return rows as T[];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchNewYorkContractorRegistry(query: string): Promise<OfficialRegistryMatch[]> {
  type Row = {
    certificate_number?: string;
    business_name?: string;
    dba_name?: string;
    business_type?: string;
    city?: string;
    state?: string;
    phone?: string | number;
    expiration_date?: string;
    status?: string;
  };
  const needle = soqlLiteral(cleanQuery(query).toUpperCase());
  const params = new URLSearchParams({
    "$select": [
      "certificate_number",
      "business_name",
      "dba_name",
      "business_type",
      "city",
      "state",
      "phone",
      "expiration_date",
      "status",
    ].join(","),
    "$where": `upper(business_name) like '%${needle}%' OR upper(dba_name) like '%${needle}%'`,
    "$order": "business_name ASC, certificate_number ASC",
    "$limit": "15",
  });
  const rows = await fetchJsonRows<Row>(
    `https://data.ny.gov/resource/i4jv-zkey.json?${params}`,
  );
  return rows
    .filter(
      (row) => row.business_name && row.certificate_number && isBusinessName(row.business_name),
    )
    .map((row) => ({
      registry: "New York contractor registry",
      businessName: row.business_name!,
      ...(row.dba_name ? { alternateName: row.dba_name } : {}),
      identifier: row.certificate_number!,
      status: row.status ?? "Status not published",
      ...(row.business_type ? { licenseType: row.business_type } : {}),
      ...(row.city ? { city: row.city } : {}),
      ...(row.state ? { state: row.state } : {}),
      ...(row.phone ? { phone: String(row.phone) } : {}),
      ...(row.expiration_date ? { expiresAt: row.expiration_date } : {}),
      sourceUrl: sourceRowUrl(
        "data.ny.gov",
        "i4jv-zkey",
        "certificate_number",
        row.certificate_number!,
      ),
    }));
}

async function searchNycIssuedLicenses(query: string): Promise<OfficialRegistryMatch[]> {
  type Row = {
    license_nbr?: string;
    business_name?: string;
    dba_trade_name?: string;
    business_category?: string;
    license_type?: string;
    license_status?: string;
    lic_expir_dd?: string;
    contact_phone?: string;
    address_city?: string;
    address_state?: string;
  };
  const needle = soqlLiteral(cleanQuery(query).toUpperCase());
  const params = new URLSearchParams({
    "$select": [
      "license_nbr",
      "business_name",
      "dba_trade_name",
      "business_category",
      "license_type",
      "license_status",
      "lic_expir_dd",
      "contact_phone",
      "address_city",
      "address_state",
    ].join(","),
    "$where": `upper(business_name) like '%${needle}%' OR upper(dba_trade_name) like '%${needle}%'`,
    "$order": "business_name ASC, license_nbr ASC",
    "$limit": "15",
  });
  const rows = await fetchJsonRows<Row>(
    `https://data.cityofnewyork.us/resource/w7w3-xahh.json?${params}`,
  );
  return rows
    .filter(
      (row) => row.business_name && row.license_nbr && isBusinessName(row.business_name),
    )
    .map((row) => ({
      registry: "NYC issued licenses",
      businessName: row.business_name!,
      ...(row.dba_trade_name ? { alternateName: row.dba_trade_name } : {}),
      identifier: row.license_nbr!,
      status: row.license_status ?? "Status not published",
      ...((row.license_type ?? row.business_category)
        ? { licenseType: row.license_type ?? row.business_category }
        : {}),
      ...(row.address_city ? { city: row.address_city } : {}),
      ...(row.address_state ? { state: row.address_state } : {}),
      ...(row.contact_phone ? { phone: row.contact_phone } : {}),
      ...(row.lic_expir_dd ? { expiresAt: row.lic_expir_dd } : {}),
      sourceUrl: sourceRowUrl(
        "data.cityofnewyork.us",
        "w7w3-xahh",
        "license_nbr",
        row.license_nbr!,
      ),
    }));
}

export async function searchRegionalCompanies(
  query: string,
  role: RegionalCompanyRole | "all" = "all",
  state: RegionalCompanyState | "all" = "all",
  providedDb?: RegionalCompanyD1Database,
): Promise<RegionalCompanySearchResult> {
  const cleaned = cleanQuery(query);
  const indexed = await searchIndexedCompanies(
    providedDb ?? await getRegionalCompanyDatabase(),
    cleaned,
    role,
    state,
  );
  if (cleaned.length < 2) {
    return { indexed, registryMatches: [], registryWarnings: [] };
  }

  const registryWarnings: string[] = [];
  const registryMatches: OfficialRegistryMatch[] = [];
  const results = await Promise.allSettled([
    searchNewYorkContractorRegistry(cleaned),
    searchNycIssuedLicenses(cleaned),
  ]);
  for (const result of results) {
    if (result.status === "fulfilled") registryMatches.push(...result.value);
    else registryWarnings.push("One official New York registry was temporarily unavailable.");
  }
  return { indexed, registryMatches, registryWarnings };
}
