#!/usr/bin/env python3
"""Promote ONE chosen boon into a character's permanent collection.

This is the ONLY tool permitted to write a canonical character file.
Keeping canonical writes in a single, single-purpose place is what makes
the "characters change only via creation or loot" invariant auditable.

The boon is appended to the character's boons[] with provenance. The
collection is uncapped; the 2-equipped limit is enforced at JOIN time
(new_campaign), not here.

Usage:
  promote_boon.py <campaign_id> <characterId> '<boon_json>'
"""
import json
import os
import sys
from common import load_character, save_character, campaign_dir, append_event, now_iso


def promote(cid, char_id, boon):
    char = load_character(char_id)

    # stamp provenance
    boon.setdefault("id", f"boon_{char_id}_{len(char['boons'])+1}")
    boon["grantedBy"] = f"campaign:{cid}"
    boon["grantedAt"] = now_iso()[:10]
    boon.setdefault("replaces", None)

    # handle replace-in-place if this boon supersedes an older one
    if boon.get("replaces"):
        char["boons"] = [b for b in char["boons"] if b["id"] != boon["replaces"]]

    char["boons"].append(boon)
    save_character(char_id, char)

    # mark the loot box resolved for this character
    lb_path = os.path.join(campaign_dir(cid), "lootbox.json")
    if os.path.exists(lb_path):
        with open(lb_path, "r", encoding="utf-8") as f:
            lb = json.load(f)
        lb.setdefault("picks", {})[char_id] = boon["id"]
        if all(pid_char in lb["picks"] for pid_char in
               {b["characterId"] for b in lb["boxes"].values()}):
            lb["resolved"] = True
        with open(lb_path, "w", encoding="utf-8") as f:
            json.dump(lb, f, indent=2, ensure_ascii=False)

    append_event(cid, {"event": {"type": "promote_boon", "characterId": char_id, "boonId": boon["id"]},
                       "result": {"ok": True}})
    return {"ok": True, "characterId": char_id, "boonId": boon["id"], "totalBoons": len(char["boons"])}


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("usage: promote_boon.py <campaign_id> <characterId> '<boon_json>'", file=sys.stderr)
        sys.exit(1)
    out = promote(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))
    print(json.dumps(out, indent=2, ensure_ascii=False))
