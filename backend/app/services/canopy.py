from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .geography import NORTHEAST_STATES, US_STATES_AND_DC


@dataclass(frozen=True)
class WeightedPattern:
    label: str
    pattern: re.Pattern[str]
    weight: int


@dataclass(frozen=True)
class SearchProfile:
    id: str
    label: str
    description: str
    minimum_score: int
    states: tuple[str, ...] = ()
    products: tuple[str, ...] = ()


@dataclass(frozen=True)
class ProductCategory:
    id: str
    label: str
    minimum_score: int
    patterns: tuple[WeightedPattern, ...]
    negative_patterns: tuple[WeightedPattern, ...] = ()


POSITIVE_PATTERNS = (
    WeightedPattern("metal canopy", re.compile(r"\b(?:metal|aluminum|steel|stainless|galvanized)\s+canop(?:y|ies)\b", re.I), 10),
    WeightedPattern("architectural canopy", re.compile(r"\barchitectural\s+canop(?:y|ies)\b", re.I), 9),
    WeightedPattern("entrance canopy", re.compile(r"\b(?:entrance|entry|walkway)\s+canop(?:y|ies)\b", re.I), 9),
    WeightedPattern("covered walkway", re.compile(r"\bcovered\s+walkways?\b", re.I), 9),
    WeightedPattern("shade structure", re.compile(r"\b(?:shade\s+structures?|shade\s+canop(?:y|ies)|sun\s*shades?)\b", re.I), 8),
    WeightedPattern("project shade", re.compile(r"\bproject\s+shade\b", re.I), 8),
    WeightedPattern("carport", re.compile(r"\b(?:car\s*ports?|parking\s+canop(?:y|ies))\b", re.I), 8),
    WeightedPattern("drop-off canopy", re.compile(r"\b(?:drop-?off|porte\s+cochere)\s+canop(?:y|ies)\b", re.I), 9),
    WeightedPattern("loading dock cover", re.compile(r"\b(?:loading\s+docks?|dock)\s+(?:canop(?:y|ies)|covers?|shelters?)\b", re.I), 8),
    WeightedPattern(
        "entrance renovation proxy",
        re.compile(
            r"\b(?:main|clinic|patient|visitor|front|hospital|building)\s+entrances?\b|"
            r"\bentrance\s+(?:improvements?|renovations?|replacements?)\b|"
            r"\b(?:patient|visitor|ambulance)\s+drop-?off\b|\bambulance\s+bays?\b|"
            r"\bentry\s+vestibules?\b|\bvestibule\s+renovations?\b",
            re.I,
        ),
        7,
    ),
    WeightedPattern(
        "facade envelope proxy",
        re.compile(
            r"\b(?:facade|façade)\s+(?:renovations?|repairs?)\b|\bbuilding\s+envelope\b|"
            r"\bstorefronts?\b|\bexterior\s+(?:renovations?|improvements?|repairs?)\b",
            re.I,
        ),
        7,
    ),
    WeightedPattern(
        "inspection gate proxy",
        re.compile(
            r"\b(?:land\s+port\s+of\s+entry|lpoe|access\s+control\s+points?|entry\s+control|"
            r"main\s+gates?|gate\s+complex(?:es)?|guard\s+booths?|visitor\s+control\s+centers?|"
            r"vehicle\s+inspection|inspection\s+lanes?|inspection\s+canop(?:y|ies)|toll\s+canop(?:y|ies))\b",
            re.I,
        ),
        8,
    ),
    WeightedPattern(
        "passenger shelter",
        re.compile(r"\b(?:passenger|bus|transit|platform)\s+shelters?\b", re.I),
        8,
    ),
    WeightedPattern("pavilion", re.compile(r"\b(?:picnic|park|outdoor)?\s*pavilions?\b", re.I), 6),
    WeightedPattern("awning", re.compile(r"\bawnings?\b", re.I), 8),
    WeightedPattern("pergola", re.compile(r"\bpergolas?\b", re.I), 10),
    WeightedPattern(
        "partition wall",
        re.compile(
            r"\b(?:interior|exterior|non[-\s]?load[-\s]?bearing|demountable|modular|movable|"
            r"operable|folding|glass|glazed|acoustic|metal[-\s]?stud|toilet|restroom)?\s*"
            r"partition\s+walls?\b",
            re.I,
        ),
        10,
    ),
    WeightedPattern(
        "architectural partition",
        re.compile(
            r"\b(?:interior|non[-\s]?load[-\s]?bearing|demountable|modular|movable|operable|"
            r"folding|glass|glazed|acoustic|metal[-\s]?stud|toilet|restroom)\s+partitions?\b",
            re.I,
        ),
        9,
    ),
    WeightedPattern("partition", re.compile(r"\bpartitions?\b", re.I), 6),
    WeightedPattern("canopy", re.compile(r"\bcanop(?:y|ies)\b", re.I), 6),
    WeightedPattern("metal fabrication", re.compile(r"\b(?:sheet\s+metal|fabricat(?:ed|ion)|prefabricated|pre-engineered)\b", re.I), 4),
    WeightedPattern("commercial construction", re.compile(r"\b(?:commercial|building|construction|renovation|repair|replacement|installation)\b", re.I), 3),
)

NEGATIVE_PATTERNS = (
    WeightedPattern(
        "electrical service entrance",
        re.compile(r"\b(?:electrical\s+)?service\s+entrance(?:s)?\b", re.I),
        10,
    ),
    WeightedPattern(
        "tree or forest canopy",
        re.compile(
            r"\b(?:tree|forest|vegetation|habitat|ecological)\s+canop(?:y|ies)\b|"
            r"\bcanop(?:y|ies)\s+(?:cover|analysis|assessment|mapping|survey)\b",
            re.I,
        ),
        14,
    ),
    WeightedPattern(
        "aircraft or parachute canopy",
        re.compile(r"\b(?:aircraft|cockpit|parachute|ejection|jettison|rocket\s+motor|f-\d{1,3})\b", re.I),
        12,
    ),
    WeightedPattern("tent or fabric-only canopy", re.compile(r"\b(?:tent|pop-?up|canvas|fabric\s+canop(?:y|ies)|shade\s+sails?)\b", re.I), 8),
    WeightedPattern(
        "equipment canopy part",
        re.compile(r"\b(?:compressors?|generator|nsn|spare\s+parts?|replacement\s+parts?)\b", re.I),
        10,
    ),
    WeightedPattern(
        "non-construction partition",
        re.compile(
            r"\b(?:disk|drive|database|table|memory|network|political|territorial|geographic|"
            r"chromatograph(?:y|ic)|coefficient)\s+partitions?\b|"
            r"\bpartitions?\s+(?:table|scheme|algorithm|function|coefficient)\b",
            re.I,
        ),
        14,
    ),
)

PRODUCT_CATEGORIES = {
    category.id: category
    for category in (
        ProductCategory(
            "canopies",
            "Canopies",
            6,
            (
                WeightedPattern("metal canopy", re.compile(r"\b(?:metal|aluminum|steel|stainless|galvanized)\s+canop(?:y|ies)\b", re.I), 10),
                WeightedPattern("architectural canopy", re.compile(r"\barchitectural\s+canop(?:y|ies)\b", re.I), 9),
                WeightedPattern("canopy", re.compile(r"\bcanop(?:y|ies)\b", re.I), 6),
                WeightedPattern("covered walkway", re.compile(r"\bcovered\s+walkways?\b", re.I), 9),
                WeightedPattern("awning", re.compile(r"\bawnings?\b", re.I), 8),
                WeightedPattern("shade structure", re.compile(r"\b(?:shade\s+structures?|sun\s*shades?)\b", re.I), 8),
                WeightedPattern("carport", re.compile(r"\b(?:car\s*ports?|parking\s+canop(?:y|ies))\b", re.I), 8),
                WeightedPattern("passenger shelter", re.compile(r"\b(?:passenger|bus|transit|platform)\s+shelters?\b", re.I), 8),
                WeightedPattern("pavilion", re.compile(r"\b(?:picnic|park|outdoor)?\s*pavilions?\b", re.I), 6),
            ),
            NEGATIVE_PATTERNS[:5],
        ),
        ProductCategory(
            "pergolas",
            "Pergolas",
            8,
            (WeightedPattern("pergola", re.compile(r"\bpergolas?\b", re.I), 10),),
        ),
        ProductCategory(
            "partition-walls",
            "Partition walls",
            6,
            (
                WeightedPattern(
                    "partition wall",
                    re.compile(
                        r"\b(?:interior|exterior|non[-\s]?load[-\s]?bearing|demountable|modular|"
                        r"movable|operable|folding|glass|glazed|acoustic|metal[-\s]?stud|toilet|"
                        r"restroom)?\s*partition\s+walls?\b",
                        re.I,
                    ),
                    10,
                ),
                WeightedPattern(
                    "architectural partition",
                    re.compile(
                        r"\b(?:interior|non[-\s]?load[-\s]?bearing|demountable|modular|movable|"
                        r"operable|folding|glass|glazed|acoustic|metal[-\s]?stud|toilet|restroom)"
                        r"\s+partitions?\b",
                        re.I,
                    ),
                    9,
                ),
                WeightedPattern("partition", re.compile(r"\bpartitions?\b", re.I), 6),
            ),
            (NEGATIVE_PATTERNS[-1],),
        ),
    )
}

NAICS_BOOSTS = {
    "236220": 4,
    "238160": 3,
    "238190": 3,
    "238990": 2,
    "332311": 5,
    "332312": 4,
    "332322": 5,
    "332323": 4,
}

SEARCH_PROFILES = {
    profile.id: profile
    for profile in (
        SearchProfile("direct_national", "Direct products - Nationwide", "High-fit canopy, pergola, and partition-wall work across all 50 states and D.C.", 8, US_STATES_AND_DC),
        SearchProfile("direct_northeast", "Direct products - Northeast", "High-fit canopy, pergola, and partition-wall work across the Northeast.", 8, NORTHEAST_STATES),
        SearchProfile("high_fit_canopy", "Highest canopy fit", "Direct architectural metal canopy and covered-walkway opportunities.", 12, products=("canopies",)),
        SearchProfile("entrance_facade", "Entrance and facade", "Hidden canopy scope inside entrance, vestibule, facade, and exterior renovations.", 6),
        SearchProfile("transit_shelters", "Transit shelters", "Passenger shelters, station canopies, and covered platforms.", 6, products=("canopies",)),
        SearchProfile("loading_dock", "Loading dock and industrial", "Dock covers, warehouse entrances, and service-yard canopy work.", 5, products=("canopies",)),
        SearchProfile("shade_structures", "Shade structures", "Pavilions, pergolas, sunshades, and outdoor shelter opportunities.", 6, products=("canopies", "pergolas")),
        SearchProfile("pergolas", "Pergolas", "Pergola construction, replacement, and renovation opportunities.", 8, products=("pergolas",)),
        SearchProfile("partition_walls", "Partition walls", "Interior, demountable, operable, glass, acoustic, and restroom partition work.", 6, products=("partition-walls",)),
    )
}


def score_text(title: str, searchable_text: str, naics_code: str = "") -> tuple[int, list[str]]:
    score = 0
    matched: list[str] = []
    for weighted in POSITIVE_PATTERNS:
        if weighted.pattern.search(title):
            score += weighted.weight * 2
            matched.append(f"{weighted.label}:title")
        elif weighted.pattern.search(searchable_text):
            score += weighted.weight
            matched.append(weighted.label)
    for weighted in NEGATIVE_PATTERNS:
        if weighted.pattern.search(title):
            score -= weighted.weight * 2
            matched.append(f"-{weighted.label}:title")
        elif weighted.pattern.search(searchable_text):
            score -= weighted.weight
            matched.append(f"-{weighted.label}")
    boost = NAICS_BOOSTS.get(naics_code.strip())
    if boost:
        score += boost
        matched.append(f"NAICS {naics_code.strip()}")
    return score, matched


def _project_text(project: dict[str, Any]) -> tuple[str, str]:
    title = str(project.get("title") or "")
    fields = [
        title,
        project.get("summary"),
        project.get("agency"),
        project.get("sourceName"),
        *(project.get("searchableFields") or []),
        *(document.get("name") for document in project.get("documents", [])),
    ]
    return title, " ".join(str(value) for value in fields if value)


def _category_score(
    title: str,
    searchable_text: str,
    category: ProductCategory,
) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    for weighted in category.patterns:
        if weighted.pattern.search(title):
            score += weighted.weight * 2
            reasons.append(f"{weighted.label}:title")
        elif weighted.pattern.search(searchable_text):
            score += weighted.weight
            reasons.append(weighted.label)
    for weighted in category.negative_patterns:
        if weighted.pattern.search(title):
            score -= weighted.weight * 2
            reasons.append(f"-{weighted.label}:title")
        elif weighted.pattern.search(searchable_text):
            score -= weighted.weight
            reasons.append(f"-{weighted.label}")
    return score, reasons


def project_product_matches(project: dict[str, Any]) -> list[dict[str, Any]]:
    cached = project.get("productMatches")
    if isinstance(cached, list) and all(
        isinstance(match, dict)
        and isinstance(match.get("id"), str)
        and isinstance(match.get("label"), str)
        and isinstance(match.get("score"), int)
        and isinstance(match.get("reasons"), list)
        for match in cached
    ):
        return cached
    title, searchable = _project_text(project)
    matches: list[dict[str, Any]] = []
    for category in PRODUCT_CATEGORIES.values():
        score, reasons = _category_score(title, searchable, category)
        if score < category.minimum_score:
            continue
        matches.append(
            {
                "id": category.id,
                "label": category.label,
                "score": score,
                "reasons": reasons[:4],
            }
        )
    return sorted(matches, key=lambda match: (-int(match["score"]), str(match["label"])))


def product_matches(project: dict[str, Any], product: str) -> bool:
    requested = product.strip().casefold()
    if not requested or requested == "all":
        return True
    return any(match["id"] == requested for match in project_product_matches(project))


def score_project(project: dict[str, Any]) -> dict[str, Any]:
    cached = project.get("canopyFit")
    if (
        isinstance(cached, dict)
        and isinstance(cached.get("score"), int)
        and cached.get("band") in {"high", "possible", "low"}
        and isinstance(cached.get("reasons"), list)
    ):
        return cached
    title, searchable = _project_text(project)
    score, reasons = score_text(title, searchable, str(project.get("naicsCode") or ""))
    if score >= 15:
        band = "high"
    elif score >= 6:
        band = "possible"
    else:
        band = "low"
    return {"score": score, "band": band, "reasons": reasons[:8]}


def profile_matches(project: dict[str, Any], profile: SearchProfile, fit: dict[str, Any]) -> bool:
    state = str(project.get("state") or "").upper()
    matches_product = (
        not profile.products
        or any(product_matches(project, product) for product in profile.products)
    )
    return (
        fit["score"] >= profile.minimum_score
        and (not profile.states or state in profile.states)
        and matches_product
    )


def search_profile_payload() -> list[dict[str, Any]]:
    return [
        {
            "id": profile.id,
            "label": profile.label,
            "description": profile.description,
            "minimumScore": profile.minimum_score,
            "states": list(profile.states),
            "products": list(profile.products),
        }
        for profile in SEARCH_PROFILES.values()
    ]
