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
    WeightedPattern("pavilion", re.compile(r"\b(?:picnic|park|outdoor)?\s*pavilions?\b", re.I), 6),
    WeightedPattern("awning", re.compile(r"\bawnings?\b", re.I), 8),
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
)

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
        SearchProfile("direct_national", "Direct canopy - Nationwide", "High-fit canopy, awning, shelter, and covered-walkway work across all 50 states and D.C.", 8, US_STATES_AND_DC),
        SearchProfile("direct_northeast", "Direct canopy - Northeast", "High-fit canopy, awning, shelter, and covered-walkway work across the Northeast.", 8, NORTHEAST_STATES),
        SearchProfile("high_fit_canopy", "Highest canopy fit", "Direct architectural metal canopy and covered-walkway opportunities.", 12),
        SearchProfile("entrance_facade", "Entrance and facade", "Hidden canopy scope inside entrance, vestibule, facade, and exterior renovations.", 6),
        SearchProfile("transit_shelters", "Transit shelters", "Passenger shelters, station canopies, and covered platforms.", 6),
        SearchProfile("loading_dock", "Loading dock and industrial", "Dock covers, warehouse entrances, and service-yard canopy work.", 5),
        SearchProfile("shade_structures", "Shade structures", "Pavilions, pergolas, sunshades, and outdoor shelter opportunities.", 6),
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


def score_project(project: dict[str, Any]) -> dict[str, Any]:
    title = str(project.get("title") or "")
    fields = [
        title,
        project.get("summary"),
        project.get("agency"),
        project.get("sourceName"),
        *(project.get("searchableFields") or []),
        *(document.get("name") for document in project.get("documents", [])),
    ]
    searchable = " ".join(str(value) for value in fields if value)
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
    return fit["score"] >= profile.minimum_score and (not profile.states or state in profile.states)


def search_profile_payload() -> list[dict[str, Any]]:
    return [
        {
            "id": profile.id,
            "label": profile.label,
            "description": profile.description,
            "minimumScore": profile.minimum_score,
            "states": list(profile.states),
        }
        for profile in SEARCH_PROFILES.values()
    ]
