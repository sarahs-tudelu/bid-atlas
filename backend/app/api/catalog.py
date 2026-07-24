from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..dependencies import get_catalog, get_jurisdictions, get_partner_directory
from ..services.canopy import search_profile_payload
from ..services.catalog import JurisdictionCatalog, ProjectCatalog, SearchFilters
from ..services.partner_directory import PartnerDirectory


router = APIRouter(prefix="/api", tags=["catalog"])


@router.get("/meta")
def meta(catalog: ProjectCatalog = Depends(get_catalog)) -> dict:
    return {
        "name": "BidAtlas",
        "backend": "FastAPI",
        "generatedAt": catalog.generated_at,
        "projectCount": len(catalog.projects),
        "sourceProjectCount": catalog.source_project_count,
        "mergedSourceProjectCount": catalog.merged_source_project_count,
        "duplicateRowsMerged": catalog.duplicate_merge_audit["duplicateRowsMerged"],
        "sourceCount": len(catalog.sources),
        "nationallyComplete": bool(catalog.coverage.get("nationallyComplete", False)),
        "statesAndDistrict": int(catalog.coverage.get("statesAndDistrict", 0)),
        "federalConnectedStates": int(catalog.coverage.get("federalConnectedStates", 0)),
        "federalExpectedStates": int(catalog.coverage.get("federalExpectedStates", 0)),
    }


@router.get("/dashboard")
def dashboard(catalog: ProjectCatalog = Depends(get_catalog)) -> dict:
    return catalog.dashboard()


@router.get("/projects")
def projects(catalog: ProjectCatalog = Depends(get_catalog)) -> dict:
    return catalog.dashboard()


@router.get("/projects/{project_id:path}")
def project(project_id: str, catalog: ProjectCatalog = Depends(get_catalog)) -> dict:
    match = catalog.project(project_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return match


@router.get("/search-presets")
def search_presets() -> dict:
    return {"presets": search_profile_payload()}


@router.get("/search")
def search(
    keywords: str = Query(default="", max_length=500),
    location: str = Query(default="", max_length=200),
    match: Literal["all", "any", "exact"] = "all",
    stage: str = Query(default="all", max_length=40),
    state: str = Query(default="all", max_length=40),
    due: Literal["all", "today", "7-days", "14-days"] = "all",
    freshness: str = Query(default="all", max_length=40),
    readiness: Literal["all", "bid-ready"] = "all",
    product: Literal["all", "canopies", "pergolas", "partition-walls"] = "all",
    profile: str = Query(default="", max_length=80),
    include_archived: bool = Query(default=False, alias="includeArchived"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=10),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict:
    return catalog.search(
        SearchFilters(
            keywords=keywords,
            location=location,
            match=match,
            stage=stage,
            state=state,
            due=due,
            freshness=freshness,
            readiness=readiness,
            product=product,
            profile=profile,
            include_archived=include_archived,
            page=page,
            limit=limit,
        )
    )


@router.get("/coverage")
def coverage(catalog: ProjectCatalog = Depends(get_catalog)) -> dict:
    return {
        "coverage": catalog.coverage,
        "inventory": catalog.inventory,
        "sources": catalog.sources,
        "warnings": catalog.warnings,
    }


@router.get("/source-registry")
def source_registry(catalog: ProjectCatalog = Depends(get_catalog)) -> dict:
    return catalog.source_registry


@router.get("/jurisdictions")
def jurisdictions(
    q: str = Query(default="", max_length=120),
    state: str = Query(default="", max_length=40),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=25),
    catalog: JurisdictionCatalog = Depends(get_jurisdictions),
) -> dict:
    return catalog.search(query=q, state=state, page=page, limit=limit)


@router.get("/companies")
def companies(
    q: str = Query(default="", max_length=120),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=25),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict:
    return catalog.companies(query=q, page=page, limit=limit)


@router.get("/partner-directory")
def partner_directory(
    q: str = Query(default="", max_length=120),
    organization_type: Literal[
        "all", "architect", "developer", "owner", "installer"
    ] = Query(
        default="all",
        alias="type",
    ),
    product: Literal["all", "canopies", "pergolas", "partition-walls"] = "all",
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=25, ge=1, le=100),
    directory: PartnerDirectory = Depends(get_partner_directory),
) -> dict:
    return directory.search(
        query=q,
        organization_type=organization_type,
        product=product,
        page=page,
        limit=limit,
    )


@router.get("/documents/search")
def documents(
    q: str = Query(default="", max_length=200),
    project_id: str = Query(default="", alias="projectId", max_length=300),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=25),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict:
    return catalog.documents(query=q, project_id=project_id, page=page, limit=limit)
