#!/usr/bin/env python3
"""Fire a showcase sequence of dice into rolls.jsonl so the web app animates each
one — for demoing the animated dice. Harmless: it only appends to rolls.jsonl,
never touches game state. Rolls are spaced out so each is caught and animated by
the ~2s poll before the next arrives.

Usage:  demo_rolls.py [campaign_id] [seconds_between]
"""
import json
import sys
import time

from common import rolls_path, now_iso

CID = sys.argv[1] if len(sys.argv) > 1 else "ashfall"
GAP = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
PATH = rolls_path(CID)


def next_id():
    try:
        with open(PATH, "r", encoding="utf-8") as f:
            return sum(1 for _ in f) + 1
    except FileNotFoundError:
        return 1


SEQ = [
    dict(label="Thordak — attack (adv)", kind="attack", notation="1d20+7", sides=20, count=1, mod=7,
         dice=[9, 17], adv=True, dis=False, kept=17, total=24, nat=17, vs=16, hit=True, crit=False, fumble=False),
    dict(label="Lyra — spell attack", kind="attack", notation="1d20+7", sides=20, count=1, mod=7,
         dice=[20], adv=False, dis=False, kept=20, total=27, nat=20, vs=16, hit=True, crit=True, fumble=False),
    dict(label="Thordak — DEX save", kind="save", notation="1d20+2", sides=20, count=1, mod=2,
         dice=[1], adv=False, dis=False, kept=1, total=3, nat=1, vs=15, hit=False, crit=False, fumble=True),
    dict(label="Fireball damage", kind="damage", notation="8d6", sides=6, count=8, mod=0,
         dice=[4, 5, 2, 6, 3, 5, 1, 4], adv=False, dis=False, kept=30, total=30, nat=None, vs=None, hit=None, crit=False, fumble=False),
    dict(label="Greataxe damage", kind="damage", notation="1d12+6", sides=12, count=1, mod=6,
         dice=[11], adv=False, dis=False, kept=11, total=17, nat=None, vs=None, hit=None, crit=False, fumble=False),
    dict(label="Alchemist's fire", kind="damage", notation="1d4+1", sides=4, count=1, mod=1,
         dice=[3], adv=False, dis=False, kept=3, total=4, nat=None, vs=None, hit=None, crit=False, fumble=False),
    dict(label="Lyra — Arcana check", kind="check", notation="1d20+6", sides=20, count=1, mod=6,
         dice=[13], adv=False, dis=False, kept=13, total=19, nat=13, vs=12, hit=True, crit=False, fumble=False),
]

for spec in SEQ:
    entry = {"id": next_id(), "ts": now_iso(), **spec}
    with open(PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print("rolled: %-26s -> %s" % (entry["label"], entry["total"]))
    time.sleep(GAP)
