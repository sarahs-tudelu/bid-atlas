# NY/NJ public owner and contractor workflow

This workflow deliberately uses official public records only. It does not require a paid contact, permit, property, or enrichment API.

## New York City

1. Discover projects from the official [DOB NOW job application filings](https://data.cityofnewyork.us/d/w9ak-ipjd).
2. Retain an owner only when the source publishes a recognizable organization-valued owner business name. Never publish the person-only owner fields.
3. Discover active work and the contractor of record from the official [DOB NOW approved permits](https://data.cityofnewyork.us/d/rbx6-tga4).
4. Classify the applicant business as a general contractor only when the same permit row publishes `Permittee's License Type = GC`. The applicant name by itself is not role evidence.
5. Link every owner or contractor relationship to the exact official Socrata row.
6. Verify the company independently through the [New York contractor registry](https://data.ny.gov/d/i4jv-zkey) and [NYC issued licenses](https://data.cityofnewyork.us/d/w7w3-xahh). A registry match verifies a business record; it does not establish the company's role on a project.

## New Jersey

1. Discover permit activity from the official [New Jersey construction permit dataset](https://data.nj.gov/d/w9se-dmra).
2. Index its municipality, county, permit number, permit/certificate date, block, lot, permit type, use group, construction cost, square feet, and unit counts.
3. Do not infer an address, owner, contractor, or work description. The statewide source does not contain those fields.
4. Use the [municipal construction office directory](https://www.nj.gov/dca/codes/publications/pdf_ora/muniroster.pdf) to request the underlying permit record by municipality and permit number. Block and lot provide additional matching evidence.
5. Publish only business-valued owner and contractor names returned by an official municipal record. Suppress private homeowner identities.
6. Verify residential home-improvement contractor registrations through the official [New Jersey license verification service](https://newjersey.mylicense.com/verification/).

## Evidence and privacy rules

- `owner` requires a literal organization name in an official project record.
- `contractor` requires an explicit contractor/GC label, permittee classification, award, or contract record.
- Applicant, filing representative, architect, bidder, and plan holder are not automatically a general contractor.
- A license registry verifies the business or credential, not the project relationship.
- Person-only residential owner and applicant names are excluded from the searchable company index.
- Every surfaced project relationship keeps an official evidence URL.

## Operations

The scheduled ingestion worker rotates through the two new source IDs:

- `nyc-dob-now-approved-permits`
- `new-jersey-construction-permits`

The `/companies` page reads organization roles already materialized in D1. A submitted company-name search also makes bounded, read-only calls to the two official New York Socrata registries. New Jersey verification remains a link-out because the state's official public verification service is interactive rather than an open bulk API.
