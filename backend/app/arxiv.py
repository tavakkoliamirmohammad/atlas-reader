"""arXiv API client: fetch recent papers and parse the Atom response."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List


_NS = {"atom": "http://www.w3.org/2005/Atom"}
_WS = re.compile(r"\s+")


@dataclass(frozen=True)
class Paper:
    arxiv_id: str
    title: str
    authors: str        # comma-joined
    abstract: str
    categories: str     # comma-joined
    published: str      # ISO-8601


def _clean(text: str | None) -> str:
    return _WS.sub(" ", (text or "")).strip()


def _arxiv_id_from_url(url: str) -> str:
    """http://arxiv.org/abs/2404.12345v1 -> 2404.12345"""
    last = url.rsplit("/", 1)[-1]
    return last.split("v")[0]


def parse_feed(xml_text: str) -> List[Paper]:
    """Parse an arXiv Atom feed into a list of Paper records."""
    root = ET.fromstring(xml_text)
    out: list[Paper] = []
    for entry in root.findall("atom:entry", _NS):
        link_el = entry.find("atom:id", _NS)
        if link_el is None or not link_el.text:
            continue
        out.append(
            Paper(
                arxiv_id=_arxiv_id_from_url(link_el.text),
                title=_clean(entry.findtext("atom:title", default="", namespaces=_NS)),
                authors=", ".join(
                    _clean(a.findtext("atom:name", default="", namespaces=_NS))
                    for a in entry.findall("atom:author", _NS)
                ),
                abstract=_clean(entry.findtext("atom:summary", default="", namespaces=_NS)),
                categories=", ".join(
                    c.get("term", "") for c in entry.findall("atom:category", _NS)
                ),
                published=_clean(
                    entry.findtext("atom:published", default="", namespaces=_NS)
                ),
            )
        )
    return out
