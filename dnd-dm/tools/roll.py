#!/usr/bin/env python3
"""Roll dice AND record a structured roll the web app animates as a spinning die.

Use this for any roll that DECIDES something (attacks, saves, ability checks,
initiative) so the players see the right die tumble and land in the dashboard.
It rolls the dice, appends a structured entry to rolls.jsonl (which the web app
turns into a suspenseful animated die), and prints the result so the DM can act
on it.

Usage:
  roll.py <cid> '<json>'
    {"label":"Thordak attack","notation":"1d20+7","adv":true,"vs":16,"kind":"attack"}
    {"label":"Lyra DEX save","notation":"1d20+2","vs":15,"kind":"save"}
    {"label":"Fireball damage","notation":"8d6","kind":"damage"}

  Fields:
    notation  NdM+K  (e.g. 1d20+7, 2d6, 8d6-1). Default 1d20.
    label     what the roll is for (shown above the die)
    adv/dis   advantage/disadvantage — only for a single d20 (rolls 2, keeps hi/lo)
    vs        optional target DC/AC → reports HIT/MISS or SUCCESS/FAIL
    kind      attack | save | check | initiative | damage  (drives styling)
"""
import json
import re
import random
import sys

from common import rolls_path, now_iso


def _next_id(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return sum(1 for _ in f) + 1
    except FileNotFoundError:
        return 1


def _parse(notation):
    m = re.match(r"^\s*(\d*)\s*d\s*(\d+)\s*([+-]\s*\d+)?\s*$", str(notation), re.I)
    if not m:
        raise ValueError("bad notation: %r (want NdM+K, e.g. 1d20+7)" % notation)
    count = int(m.group(1)) if m.group(1) else 1
    sides = int(m.group(2))
    mod = int(m.group(3).replace(" ", "")) if m.group(3) else 0
    return count, sides, mod


def roll(cid, spec):
    notation = spec.get("notation", "1d20")
    count, sides, mod = _parse(notation)
    adv = bool(spec.get("adv"))
    dis = bool(spec.get("dis"))

    if sides == 20 and count == 1 and (adv or dis):
        pair = [random.randint(1, 20), random.randint(1, 20)]
        nat = max(pair) if adv else min(pair)
        dice = pair                # both shown; UI knows which was kept
        kept = nat
    else:
        dice = [random.randint(1, sides) for _ in range(count)]
        kept = sum(dice)
        nat = dice[0] if (sides == 20 and count == 1) else None

    total = kept + mod
    crit = nat == 20
    fumble = nat == 1
    vs = spec.get("vs")
    hit = None
    if vs is not None and not (sides != 20):
        hit = (total >= int(vs)) or crit
        if fumble:
            hit = False

    entry = {
        "id": _next_id(rolls_path(cid)),
        "ts": now_iso(),
        "label": spec.get("label", "Roll"),
        "kind": spec.get("kind", "check"),
        "notation": notation,
        "sides": sides,
        "count": count,
        "mod": mod,
        "dice": dice,
        "adv": adv,
        "dis": dis,
        "kept": kept,       # natural die face to land on (single die) / subtotal
        "total": total,     # kept + mod — the number that matters
        "nat": nat,         # the d20 natural, when applicable
        "vs": vs,
        "hit": hit,
        "crit": crit,
        "fumble": fumble,
    }
    with open(rolls_path(cid), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: roll.py <cid> '<json>'", file=sys.stderr)
        sys.exit(1)
    e = roll(sys.argv[1], json.loads(sys.argv[2]))
    # concise line for the DM
    detail = "/".join(map(str, e["dice"]))
    modstr = ("%+d" % e["mod"]) if e["mod"] else ""
    line = "%s: %s [%s]%s = %s" % (e["label"], e["notation"], detail, modstr, e["total"])
    if e["vs"] is not None:
        line += " vs %s -> %s" % (e["vs"], ("HIT" if e["hit"] else "MISS"))
    if e["crit"]:
        line += "  (CRIT!)"
    if e["fumble"]:
        line += "  (nat 1)"
    print(line)
