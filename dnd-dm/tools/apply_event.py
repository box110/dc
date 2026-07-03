#!/usr/bin/env python3
"""Apply a single event to campaign state, deterministically.

Claude DECIDES what happens (the ogre hits, for 12). This script DOES the
arithmetic (52 - 12 = 40) and logs it. Claude should never rewrite whole
state objects; it emits events and lets this enforce the rules.

Usage:
  apply_event.py <campaign_id> '<event_json>'

Event types:
  damage        {target, amount, source?}      target = participationId or bossId
  heal          {target, amount}
  temp_hp       {target, amount}
  add_condition {target, condition}
  remove_condition {target, condition}
  spend_slot    {target, level}
  regain_slot   {target, level}                 recover ONE spent slot (Arcane Recovery / short rest)
  restore_slots {target}                        (long rest)
  use_resource  {target, resource}
  adjust_gold   {target, amount}                gain (+) or spend (-); clamps at 0
  add_item      {target, item}                  item={name,qty?,...}; stacks by name
  use_item      {target, item, qty?}            consume/remove from inventory (default qty 1)
  start_combat  {combatants:[{id,name,hp,maxHp?,tempHp?,conditions?}], initiative?}
  end_combat    {}                               close encounter, clear combatants
  boss_defeated {bossId}                         -> triggers cascade
  local_reward  {reward}                         campaign-scoped drop
  set_position  {level, borough?, neighborhood?}
"""
import json
import sys
from common import load_state, save_state, load_campaign, save_campaign, append_event


# ---- target resolution ------------------------------------
def _get_target(state, tid):
    """Return (kind, obj). Participation or boss combatant."""
    if tid in state["participations"]:
        return "participation", state["participations"][tid]
    if tid in state["combat"]["combatants"]:
        return "boss", state["combat"]["combatants"][tid]
    raise KeyError(f"unknown target: {tid}")


# ---- damage with temp-HP-first rule -----------------------
def _apply_damage(obj, amount):
    temp = obj.get("tempHp", 0)
    if temp > 0:
        absorbed = min(temp, amount)
        obj["tempHp"] = temp - absorbed
        amount -= absorbed
    obj["hp"] = max(0, obj["hp"] - amount)
    return obj["hp"]


# ---- the tiered cascade -----------------------------------
def _cascade_boss_defeat(cid, state, campaign, boss_id):
    """Resolve a boss death by tier, advance position, unlock the next
    boss, and fire campaign_complete only if it was the final level boss.
    Returns a list of human-readable consequences.
    """
    events = []
    struct = campaign["structure"]

    for lvl in struct["levels"]:
        # neighborhood?
        for bor in lvl.get("boroughs", []):
            for i, nb in enumerate(bor["neighborhoods"]):
                if nb["boss"]["id"] == boss_id:
                    nb["cleared"] = True
                    events.append(f"Neighborhood '{nb['name']}' cleared.")
                    # advance to next uncleared neighborhood in this borough
                    nxt = next((n for n in bor["neighborhoods"] if not n["cleared"]), None)
                    if nxt:
                        state["position"] = {"level": lvl["id"], "borough": bor["id"], "neighborhood": nxt["id"]}
                        events.append(f"Advance to '{nxt['name']}'.")
                    else:
                        bor["boss"]["revealed"] = True
                        state["position"] = {"level": lvl["id"], "borough": bor["id"], "neighborhood": None}
                        events.append(f"All neighborhoods cleared -- BOROUGH BOSS '{bor['boss']['name']}' unlocked.")
                    save_campaign(cid, campaign)
                    return events
            # borough boss?
            if bor["boss"]["id"] == boss_id:
                bor["cleared"] = True
                events.append(f"Borough '{bor['name']}' cleared.")
                nxt = next((b for b in lvl["boroughs"] if not b.get("cleared")), None)
                if nxt:
                    first_nb = nxt["neighborhoods"][0]
                    state["position"] = {"level": lvl["id"], "borough": nxt["id"], "neighborhood": first_nb["id"]}
                    events.append(f"Advance to borough '{nxt['name']}'.")
                else:
                    lvl["boss"]["revealed"] = True
                    state["position"] = {"level": lvl["id"], "borough": None, "neighborhood": None}
                    events.append(f"All boroughs cleared -- LEVEL BOSS '{lvl['boss']['name']}' unlocked.")
                save_campaign(cid, campaign)
                return events
        # level boss?
        if lvl["boss"]["id"] == boss_id:
            events.append(f"LEVEL BOSS '{lvl['boss']['name']}' defeated.")
            if lvl.get("boss_final_for_campaign"):
                events.append("FINAL LEVEL -- campaign complete. Run complete_campaign to generate the loot box.")
                state.setdefault("flags", {})["awaitingCompletion"] = True
            else:
                events.append("Descend to the next level. (Generate it lazily if not yet built.)")
                state.setdefault("flags", {})["awaitingNextLevel"] = True
            save_campaign(cid, campaign)
            return events

    events.append(f"WARNING: boss '{boss_id}' not found in structure.")
    return events


# ---- dispatch ---------------------------------------------
def apply(cid, event):
    state = load_state(cid)
    campaign = load_campaign(cid)
    etype = event["type"]
    result = {"type": etype, "ok": True}

    if etype == "damage":
        kind, obj = _get_target(state, event["target"])
        hp = _apply_damage(obj, int(event["amount"]))
        result["hp"] = hp
        # auto-fire boss defeat when a boss combatant hits 0
        if kind == "boss" and hp == 0:
            result["cascade"] = _cascade_boss_defeat(cid, state, campaign, event["target"])

    elif etype == "heal":
        _, obj = _get_target(state, event["target"])
        obj["hp"] = min(obj.get("maxHp", obj["hp"] + int(event["amount"])), obj["hp"] + int(event["amount"]))
        result["hp"] = obj["hp"]

    elif etype == "temp_hp":
        _, obj = _get_target(state, event["target"])
        obj["tempHp"] = max(obj.get("tempHp", 0), int(event["amount"]))  # temp HP doesn't stack
        result["tempHp"] = obj["tempHp"]

    elif etype == "add_condition":
        _, obj = _get_target(state, event["target"])
        conds = obj.setdefault("conditions", [])
        if event["condition"] not in conds:
            conds.append(event["condition"])

    elif etype == "remove_condition":
        _, obj = _get_target(state, event["target"])
        obj["conditions"] = [c for c in obj.get("conditions", []) if c != event["condition"]]

    elif etype == "spend_slot":
        part = state["participations"][event["target"]]
        for s in part["slots"]:
            if s["level"] == int(event["level"]) and s["used"] < s["max"]:
                s["used"] += 1
                break

    elif etype == "regain_slot":
        # Inverse of spend_slot: hand back a single spent slot of the given
        # level (Arcane Recovery, short-rest features). Does not touch resources
        # like Rage — that's what makes it correct for a short rest.
        part = state["participations"][event["target"]]
        for s in part["slots"]:
            if s["level"] == int(event["level"]) and s["used"] > 0:
                s["used"] -= 1
                break
        result["slots"] = part["slots"]

    elif etype == "restore_slots":
        part = state["participations"][event["target"]]
        for s in part["slots"]:
            s["used"] = 0
        for r in part.get("resources", []):
            r["used"] = 0

    elif etype == "use_resource":
        part = state["participations"][event["target"]]
        for r in part.get("resources", []):
            if r["name"] == event["resource"] and r["used"] < r["max"]:
                r["used"] += 1
                break

    elif etype == "adjust_gold":
        # Campaign-scoped currency lives on the participation, never the
        # canonical character. Positive amount = gain, negative = spend; a
        # purchase that would overdraw clamps at 0 (the DM decides affordability).
        part = state["participations"][event["target"]]
        part["gold"] = max(0, int(part.get("gold", 0)) + int(event["amount"]))
        result["gold"] = part["gold"]

    elif etype == "add_item":
        # Put gear/consumables into a character's own inventory (per-character
        # live state). Stacks by name when both entries carry a numeric qty.
        part = state["participations"][event["target"]]
        inv = part.setdefault("inventory", [])
        item = event["item"]
        if isinstance(item, str):
            item = {"name": item, "qty": 1}
        merged = False
        if "qty" in item:
            for it in inv:
                if it.get("name") == item["name"] and "qty" in it:
                    it["qty"] += int(item["qty"])
                    merged = True
                    break
        if not merged:
            inv.append(dict(item))
        result["inventory"] = inv

    elif etype == "use_item":
        # Consume/remove from inventory. Decrements a numeric qty (default 1) and
        # drops the entry at 0; removes an unquantified item outright.
        part = state["participations"][event["target"]]
        inv = part.get("inventory", [])
        name = event["item"]
        qty = int(event.get("qty", 1))
        for it in list(inv):
            if it.get("name") == name:
                if "qty" in it:
                    it["qty"] = max(0, it["qty"] - qty)
                    if it["qty"] == 0:
                        inv.remove(it)
                else:
                    inv.remove(it)
                break
        result["inventory"] = inv

    elif etype == "start_combat":
        # Begin a fresh encounter. The DM has rolled initiative and decided the
        # order; this registers the non-party combatants (bosses/monsters) so
        # damage can target them and the web combat feed has something to show.
        # Party members live in participations, not here.
        combatants = {}
        for c in event.get("combatants", []):
            cbid = c["id"]
            combatants[cbid] = {
                "name": c.get("name", cbid),
                "hp": int(c["hp"]),
                "maxHp": int(c.get("maxHp", c["hp"])),
                "tempHp": int(c.get("tempHp", 0)),
                "conditions": list(c.get("conditions", [])),
            }
        # explicit order if given (party + combatant ids), else party then monsters
        initiative = (list(event["initiative"]) if event.get("initiative")
                      else list(state["participations"].keys()) + list(combatants.keys()))
        state["combat"] = {
            "active": True,
            "round": 1,
            "initiative": initiative,
            "combatants": combatants,
        }
        result.update({"active": True, "round": 1,
                       "initiative": initiative,
                       "combatants": list(combatants.keys())})

    elif etype == "end_combat":
        # Close the encounter: flip active off and clear the transient monster
        # combatants + initiative. Party state (in participations) is untouched;
        # any conditions/HP carry forward as they should.
        state["combat"] = {
            "active": False,
            "round": 0,
            "initiative": [],
            "combatants": {},
        }
        result.update({"active": False})

    elif etype == "boss_defeated":
        result["cascade"] = _cascade_boss_defeat(cid, state, campaign, event["bossId"])

    elif etype == "local_reward":
        state["localRewards"].append(event["reward"])

    elif etype == "set_position":
        state["position"] = {
            "level": event["level"],
            "borough": event.get("borough"),
            "neighborhood": event.get("neighborhood"),
        }

    else:
        result = {"type": etype, "ok": False, "error": "unknown event type"}
        print(json.dumps(result, indent=2))
        return result

    save_state(cid, state)
    append_event(cid, {"event": event, "result": result})
    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: apply_event.py <campaign_id> '<event_json>'", file=sys.stderr)
        sys.exit(1)
    out = apply(sys.argv[1], json.loads(sys.argv[2]))
    print(json.dumps(out, indent=2, ensure_ascii=False))
