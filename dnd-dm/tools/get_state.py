#!/usr/bin/env python3
"""Read a SLICE of campaign state. Keeping reads small is how we keep
each stateless CLI call's context lean.

Usage:
  get_state.py <campaign_id> [slice]

Slices:
  scene    (default) position + party vitals + active combat
  party    full participation records
  combat   initiative + combatant HP/conditions only
  position where the party is in the boss tree
  bosses   the current unlocked/next boss at each tier
  all      everything (use sparingly)
"""
import json
import sys
from common import load_state, load_campaign


def _vitals(part):
    return {
        "characterId": part["characterId"],
        "hp": part["hp"],
        "maxHp": part["maxHp"],
        "tempHp": part.get("tempHp", 0),
        "ac": part["ac"],
        "gold": part.get("gold", 0),
        "conditions": part.get("conditions", []),
        "equippedBoons": part.get("equippedBoons", []),
    }


def _find_node(campaign, pos):
    """Resolve the position pointer into the current tree nodes."""
    out = {"level": None, "borough": None, "neighborhood": None}
    for lvl in campaign["structure"]["levels"]:
        if lvl["id"] != pos.get("level"):
            continue
        out["level"] = {"id": lvl["id"], "name": lvl["name"], "boss": lvl["boss"]}
        for bor in lvl.get("boroughs", []):
            if bor["id"] != pos.get("borough"):
                continue
            out["borough"] = {"id": bor["id"], "name": bor["name"], "boss": bor["boss"]}
            for nb in bor.get("neighborhoods", []):
                if nb["id"] == pos.get("neighborhood"):
                    out["neighborhood"] = nb
    return out


def get_slice(cid, which="scene"):
    state = load_state(cid)
    if which == "party":
        return state["participations"]
    if which == "combat":
        return state["combat"]
    if which == "position":
        return state["position"]
    if which == "bosses":
        return _find_node(load_campaign(cid), state["position"])
    if which == "all":
        return {"state": state, "campaign": load_campaign(cid)}
    # default: scene
    return {
        "position": state["position"],
        "party": [_vitals(p) for p in state["participations"].values()],
        "combat": {
            "active": state["combat"]["active"],
            "round": state["combat"]["round"],
        },
        "here": _find_node(load_campaign(cid), state["position"]),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: get_state.py <campaign_id> [slice]", file=sys.stderr)
        sys.exit(1)
    cid = sys.argv[1]
    which = sys.argv[2] if len(sys.argv) > 2 else "scene"
    print(json.dumps(get_slice(cid, which), indent=2, ensure_ascii=False))
