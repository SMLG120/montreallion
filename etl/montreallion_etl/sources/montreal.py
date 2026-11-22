"""Parsers for City of Montréal datasets (all CC BY 4.0 via donnees.montreal.ca)."""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass

from .. import geo
from . import ckan


@dataclass
class Area:
    name: str
    kind: str  # "borough" | "municipality"
    geom: dict


def areas(refresh: bool = False) -> tuple[list[Area], dict]:
    f, info = ckan.resource("limites-administratives-agglomeration", fmt="geojson", name_contains="WGS", refresh=refresh)
    out = []
    for ft in ckan.read_json(f)["features"]:  # type: ignore[index]
        p = ft["properties"]
        kind = "borough" if p["TYPE"] == "Arrondissement" else "municipality"
        out.append(Area(p["NOM"].strip(), kind, ft["geometry"]))
    return out, info


def neighbourhoods(refresh: bool = False) -> tuple[list[dict], dict]:
    """Quartiers de référence en habitation: name + borough (or municipality)."""
    f, info = ckan.resource("quartiers", fmt="csv", name_contains="Quartiers de r", refresh=refresh)
    rows = []
    for r in ckan.read_csv(f):
        area = r["nom_arr"].strip() if r["nom_mun"].strip() == "Montréal" else r["nom_mun"].strip()
        rows.append({"name": r["nom_qr"].strip(), "area": area})
    return rows, info


PARK_TYPES = {"Parc", "Square", "Parc-nature"}  # the dataset's "Type"; full name = Type + Nom
PARK_TYPO = {"Parc d'arrondissement", "Grand parc"}
PUBLIC_OWNERS = {"Arrondissement", "Agglomération", "Municipale", "Local"}
BAD_NAME = re.compile(r"\d|/|sans nom|^école|^ecole|^terrain|^ruelle", re.I)


def parks(index: geo.AreaIndex, refresh: bool = False) -> tuple[list[dict], dict]:
    """Named public parks, assigned to a borough/municipality by polygon centroid; area summed per park."""
    f, info = ckan.resource("grands-parcs-parcs-d-arrondissements-et-espaces-publics", fmt="json", refresh=refresh)
    agg: dict[tuple[str, str, str], dict] = {}
    for ft in ckan.read_json(f)["features"]:  # type: ignore[index]
        p = ft["properties"]
        specific = (p.get("Nom") or "").strip()
        ptype = (p.get("Type") or "").strip()
        if ptype not in PARK_TYPES or p.get("TYPO1") not in PARK_TYPO or p.get("COMPETENCE") not in PUBLIC_OWNERS:
            continue
        if len(specific) < 3 or BAD_NAME.search(specific):
            continue
        c = geo.centroid(ft["geometry"])
        area = index.locate(*c) if c else None
        if not area:
            continue
        try:
            ha = float(str(p.get("SUPERFICIE") or 0).replace(",", "."))
        except ValueError:
            ha = 0.0
        # "Maisonneuve, Golf municipal de Montréal" → name "Maisonneuve"; the full form stays an accepted alias.
        alt = None
        if ", " in specific:
            specific, alt = specific.split(", ", 1)[0].strip(), specific
        cur = agg.setdefault((ptype, specific, area), {"type": ptype, "specific": specific, "area": area, "ha": 0.0, "alt": alt})
        cur["ha"] += ha
    return list(agg.values()), info


def cultural_places(refresh: bool = False) -> tuple[list[dict], dict]:
    f, info = ckan.resource("lieux-culturels", fmt="csv", refresh=refresh)
    out = []
    for r in ckan.read_csv(f):
        nets = [n.strip() for n in (r.get("Noms du réseau") or "").split(",") if n.strip()]
        out.append({"name": r["Nom du lieu culturel municipal"].strip(), "area": r["Arrondissement"].strip(), "networks": nets})
    return out, info


def public_art(refresh: bool = False) -> tuple[list[dict], dict]:
    f, info = ckan.resource("art-public-information-sur-les-oeuvres-de-la-collection-municipale", fmt="json", refresh=refresh)
    out = []
    for w in ckan.read_json(f):  # type: ignore[union-attr]
        artists = w.get("Artistes") or []
        if isinstance(artists, str):
            try:
                artists = ast.literal_eval(artists)
            except (ValueError, SyntaxError):
                artists = []
        names = []
        for a in artists:
            nm = " ".join(x for x in [(a.get("Prenom") or "").strip(), (a.get("Nom") or "").strip()] if x and x != "None")
            if nm:
                names.append(nm)
        out.append({"title": (w.get("Titre") or "").strip(), "area": (w.get("Arrondissement") or "").strip(), "artists": names})
    return out, info
