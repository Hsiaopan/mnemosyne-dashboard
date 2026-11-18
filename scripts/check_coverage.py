"""Report i18n dictionary coverage against extracted UI candidates.

Prints which candidate strings are NOT in zh-CN.json so the maintainer can
decide whether each is genuine UI text (should translate) or noise (ignore).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cands = json.loads((ROOT / "scripts" / "ui_text_candidates.json").read_text(encoding="utf-8"))
zh = json.loads((ROOT / "static" / "locales" / "zh-CN.json").read_text(encoding="utf-8"))

# Strings that are legitimately left untranslated.
NOISE = re.compile(
    r"^(?:"
    r"0\.0\.0\.0|127\.0\.0\.1|8765|"
    r"[A-Z]{2,4}|"                      # acronym nav badges: OV TD 3D KG ...
    r"\S*\.db|\S*\/\S*|"                # paths
    r"(?:wysie|AxDSan|Mnemosyne|Hermes|MEMORIA|LAB v22).*|"
    r"[\"'`=<>\/\{\}\[\]]|"             # code fragments
    r".*(?:class=|id=|data-|stop-|offset=|aria-|\$|\(\)|=>).*"
    r")$"
)

missing: dict[str, list[str]] = {}
covered = 0
for kind, items in cands.items():
    miss = []
    for s in items:
        if s in zh:
            covered += 1
        elif not NOISE.match(s):
            miss.append(s)
    if miss:
        missing[kind] = miss

total = sum(len(v) for v in cands.values())
print(f"covered {covered} / {total} candidates")
print("=" * 60)
for kind, miss in missing.items():
    print(f"\n[{kind}] {len(miss)} not covered (review these):")
    for s in miss:
        print(f"  - {s}")
