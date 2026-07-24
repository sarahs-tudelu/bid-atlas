from functools import lru_cache

from .config import settings
from .services.catalog import JurisdictionCatalog, ProjectCatalog
from .services.catalog_provider import ProjectCatalogProvider
from .services.partner_directory import PartnerDirectory
from .services.state import WorkspaceStore


@lru_cache(maxsize=1)
def get_catalog_provider() -> ProjectCatalogProvider:
    return ProjectCatalogProvider(
        settings.data_directory,
        bucket=settings.catalog_bucket,
        key=settings.catalog_key,
        refresh_seconds=settings.catalog_refresh_seconds,
    )


def get_catalog() -> ProjectCatalog:
    return get_catalog_provider().get()


@lru_cache(maxsize=1)
def get_jurisdictions() -> JurisdictionCatalog:
    return JurisdictionCatalog(settings.data_directory / "all_50_us_states_and_cities_2025.txt")


@lru_cache(maxsize=1)
def get_partner_directory() -> PartnerDirectory:
    return PartnerDirectory(
        [
            settings.data_directory / "new-jersey-partner-directory.json",
            settings.data_directory / "tri-state-research-prospects.json",
        ]
    )


@lru_cache(maxsize=1)
def get_workspace_store() -> WorkspaceStore:
    return WorkspaceStore(settings.workspace_table)
