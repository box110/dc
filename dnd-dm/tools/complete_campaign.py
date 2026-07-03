#!/usr/bin/env python3
"""Finalize a campaign after its FINAL level boss falls.

This writes a lootbox.json holding candidate boons (one set per character).
Claude generates the candidates -- themed to what happened, scaled to tone
and length -- and passes them in. The human then picks one per character,
and promote_boon.py writes the chosen boon to the canonical file.

Usage:
  complete_campaign.py <campaign_id> '<lootbox_json>'

lootbox_json shape:
  {
    "part_thordak_ashfall": {
      "characterId": "thordak",
      "candidates": [ {boon}, {boon}, {boon} ]   # 3 themed options
    },
    ...
  }
"""
import json
import os
import sys
from common import load_state, save_state, load_campaign, save_campaign, campaign_dir, append_event, now_iso


def complete(cid, lootbox):
    state = load_state(cid)
    campaign = load_campaign(cid)

    # write the loot box for the human to choose from
    lb_path = os.path.join(campaign_dir(cid), "lootbox.json")
    payload = {"generatedAt": now_iso(), "resolved": False, "picks": {}, "boxes": lootbox}
    with open(lb_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    # freeze the campaign
    campaign["status"] = "completed"
    state.setdefault("flags", {})["awaitingCompletion"] = False
    save_campaign(cid, campaign)
    save_state(cid, state)
    append_event(cid, {"event": {"type": "campaign_complete"}, "result": {"lootbox": lb_path}})

    return {"ok": True, "lootbox": lb_path, "message": "Loot box generated. Human picks one boon per character, then run promote_boon."}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: complete_campaign.py <campaign_id> '<lootbox_json>'", file=sys.stderr)
        sys.exit(1)
    out = complete(sys.argv[1], json.loads(sys.argv[2]))
    print(json.dumps(out, indent=2, ensure_ascii=False))
