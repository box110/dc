#!/usr/bin/env python3
"""Set the player-facing prompt shown in the web app's input area.

Writes prompt.json: the current question plus suggested response buttons. The
web app renders the buttons; clicking one appends its text to the compose box.
This is the DM asking "what do you do?" — narrative, not live state.

Usage:
  prompt.py <cid> '<json>'
    {"text":"Kolt squares up. What do you do?",
     "suggestions":["Thordak charges","Lyra opens with Fireball","Flash the Passage-Token"]}
"""
import json
import sys

from common import prompt_path, now_iso, _atomic_write


def set_prompt(cid, obj):
    data = {
        "text": obj.get("text", ""),
        "suggestions": list(obj.get("suggestions", [])),
        "ts": now_iso(),
    }
    _atomic_write(prompt_path(cid), data)
    return data


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: prompt.py <cid> '<json>'", file=sys.stderr)
        sys.exit(1)
    out = set_prompt(sys.argv[1], json.loads(sys.argv[2]))
    print(json.dumps({"ok": True, "suggestions": len(out["suggestions"])}, ensure_ascii=False))
