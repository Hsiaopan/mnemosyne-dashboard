"""Extract English UI text candidates from the dashboard frontend.

Produces a de-duplicated, sorted list of human-readable English strings that
are candidates for i18n. Heuristics deliberately favour recall over precision:
the translator reviews the output and decides what is actually UI text.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

results: dict[str, list[str]] = {}


def add(kind: str, text: str) -> None:
    text = text.strip()
    if len(text) < 2 or len(text) > 160:
        return
    results.setdefault(kind, []).append(text)


# ---- index.html: text nodes and translatable attributes ----
html = (STATIC / "index.html").read_text(encoding="utf-8")
# <title> and element text nodes
for m in re.finditer(r">([^<>{}]+)<", html):
    add("html.text", m.group(1))
# attributes likely to be user-facing
for attr in ("placeholder", "aria-label", "title", "alt"):
    for m in re.finditer(rf'\b{attr}="([^"]+)"', html):
        add(f"html.{attr}", m.group(1))

# ---- app.js: string literals that look like UI text ----
js = (STATIC / "app.js").read_text(encoding="utf-8")
STRING_RE = re.compile(r"(['\"`])((?:\\.|(?!\1).)*)\1", re.DOTALL)
for m in STRING_RE.finditer(js):
    raw = m.group(2)
    if "${" in raw or "\\" in raw or "\n" in raw:
        continue
    if not re.search(r"[A-Za-z]", raw):
        continue
    # Require a space OR a capitalized first letter: filters out class names,
    # keys, ids, css values, etc.
    if " " not in raw and not (raw[:1].isupper() and len(raw) > 3):
        continue
    add("js.string", raw)

# ---- de-duplicate within each kind, sort ----
out = {k: sorted(set(v), key=str.lower) for k, v in results.items()}
target = ROOT / "scripts" / "ui_text_candidates.json"
target.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

total = sum(len(v) for v in out.values())
print(f"candidates written to {target.relative_to(ROOT)}: {total}")
for k, v in out.items():
    print(f"  {k}: {len(v)}")
