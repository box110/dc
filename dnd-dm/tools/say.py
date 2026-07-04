#!/usr/bin/env python3
"""Append story dialogue to a campaign's story feed.

This is how the DM narrates: attributed lines the web app renders on its story
pane and (optionally) reads aloud with a distinct voice per speaker. It is
NARRATIVE content — appended to dialog.jsonl — NOT live game state. State stays
in state.json (written only by apply_event); this never touches it.

Usage:
  say.py <campaign_id> '<json>'

  <json> is a single line object, or an ARRAY of them (a scene = many lines):
    {"speaker":"Sella","type":"npc","text":"You drained my Row!"}
    [ {"speaker":"Narrator","type":"narrator","text":"The reservoir crashes in."},
      {"speaker":"Thordak","type":"pc","text":"Then we go down together."} ]

  Fields:
    text     required
    speaker  default "Narrator"
    type     narrator | pc | npc | boss   (default "narrator")
             drives the speaker color + voice category in the web app.
"""
import json
import sys

from common import dialog_path, now_iso


def _next_id(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return sum(1 for _ in f) + 1
    except FileNotFoundError:
        return 1


def say(cid, lines):
    if isinstance(lines, dict):
        lines = [lines]
    path = dialog_path(cid)
    nid = _next_id(path)
    written = []
    with open(path, "a", encoding="utf-8") as f:
        for ln in lines:
            entry = {
                "id": nid,
                "ts": now_iso(),
                "speaker": ln.get("speaker", "Narrator"),
                "type": ln.get("type", "narrator"),
                "text": ln["text"],
            }
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            written.append(entry)
            nid += 1
    return written


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: say.py <campaign_id> '<json>'", file=sys.stderr)
        sys.exit(1)
    out = say(sys.argv[1], json.loads(sys.argv[2]))
    print(json.dumps(
        {"ok": True, "added": len(out), "lastId": out[-1]["id"] if out else None},
        ensure_ascii=False,
    ))
