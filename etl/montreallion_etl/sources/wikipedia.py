"""Wikipedia list pages (facts only: names and table cells; no prose is reused).

Each page is fetched once via the MediaWiki API with its revision id, so every
question cites an exact, permanent revision (…/index.php?oldid=N).
"""

from __future__ import annotations

import re

from ..http import fetch_json

API = "https://{lang}.wikipedia.org/w/api.php"
LICENSE = "CC BY-SA 4.0 (facts only reused)"


def page(title: str, lang: str = "en", refresh: bool = False) -> tuple[str, dict]:
    """Returns (wikitext, source) for the current revision of `title`."""
    key = "wp-" + lang + "-" + re.sub(r"[^A-Za-z0-9]+", "_", title)[:80]
    data, f = fetch_json(
        key,
        API.format(lang=lang),
        params={"action": "parse", "page": title, "prop": "wikitext|revid", "redirects": 1, "format": "json", "formatversion": 2},
        refresh=refresh,
    )
    p = data["parse"]  # type: ignore[index]
    src = {
        "title": f"Wikipedia ({lang}): {p['title']}",
        "url": f"https://{lang}.wikipedia.org/w/index.php?oldid={p['revid']}",
        "license": LICENSE,
        "retrieved": f.retrieved,
    }
    return p["wikitext"], src


LINK = re.compile(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]")
TEMPLATE = re.compile(r"\{\{[^{}]*\}\}")
REF = re.compile(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", re.S)
TAGS = re.compile(r"<[^>]+>")
FILE = re.compile(r"\[\[(File|Image|Fichier):[^\[\]]*(\[\[[^\]]*\]\][^\[\]]*)*\]\]", re.I)


def plain(s: str) -> str:
    """Wikitext cell → plain text: link labels kept, refs/templates/markup dropped."""
    s = REF.sub("", s)
    s = FILE.sub("", s)
    for _ in range(3):
        s = TEMPLATE.sub("", s)
    s = LINK.sub(r"\1", s)
    s = TAGS.sub("", s).replace("'''", "").replace("''", "")
    return re.sub(r"\s+", " ", s).strip()


def link_targets(s: str) -> list[str]:
    s = FILE.sub("", REF.sub("", s))
    return [m.split("|")[0].split("#")[0].strip() for m in re.findall(r"\[\[([^\]]+)\]\]", s)]


def tables(wikitext: str) -> list[list[list[str]]]:
    """Very small wikitable parser: returns tables → rows → raw cells (wikitext)."""
    out = []
    for block in re.findall(r"\{\|.*?\n\|\}", wikitext, re.S):
        rows, cur = [], None
        for line in block.split("\n")[1:]:
            if line.startswith("|-") or line.startswith("|}"):
                if cur:
                    rows.append(cur)
                cur = []
                continue
            if cur is None:
                cur = []
            if line.startswith("|+"):
                continue
            if line.startswith("|") or line.startswith("!"):  # "!" = header cell (also row headers: ! scope="row" | Name)
                for cell in re.split(r"\|\||!!", line[1:]):
                    # drop cell attributes: 'style="…" | value'
                    if re.match(r'^\s*([a-z-]+="[^"]*"\s*)+\|', cell) or re.match(r"^\s*(rowspan|colspan|style|align|data-sort-value)=[^|]*\|", cell):
                        cell = cell.split("|", 1)[1]
                    cur.append(cell.strip().lstrip("|").strip())
            elif cur:
                cur[-1] += "\n" + line
        if cur:
            rows.append(cur)
        out.append([r for r in rows if r])
    return out


def category(title: str, lang: str = "fr", refresh: bool = False) -> tuple[list[str], list[str], dict]:
    """Article titles and subcategory names in a Wikipedia category (one level), plus a source record."""
    prefix = "Catégorie:" if lang == "fr" else "Category:"
    key = "wpcat-" + lang + "-" + re.sub(r"[^A-Za-z0-9]+", "_", title.encode("ascii", "ignore").decode())[:70]
    pages: list[str] = []
    subs: list[str] = []
    cont: dict = {}
    retrieved = ""
    for i in range(10):
        data, f = fetch_json(
            f"{key}-{i}",
            API.format(lang=lang),
            params={"action": "query", "list": "categorymembers", "cmtitle": prefix + title, "cmlimit": 500, "cmtype": "page|subcat", "format": "json", **cont},
            refresh=refresh,
        )
        retrieved = f.retrieved
        for m in data["query"]["categorymembers"]:  # type: ignore[index]
            (pages if m["ns"] == 0 else subs).append(m["title"].split(":", 1)[1] if m["ns"] == 14 else m["title"])
        if "continue" not in data:  # type: ignore[operator]
            break
        cont = {"cmcontinue": data["continue"]["cmcontinue"]}  # type: ignore[index]
    src = {
        "title": f"Wikipedia ({lang}): {prefix}{title}",
        "url": f"https://{lang}.wikipedia.org/wiki/{prefix}{title.replace(' ', '_')}",
        "license": LICENSE,
        "retrieved": retrieved,
    }
    return pages, subs, src
