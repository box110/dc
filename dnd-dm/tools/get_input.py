#!/usr/bin/env python3
"""Read the player-input queue submitted from the web app.

The web app POSTs the player's composed response to the server, which appends it
to player_input.jsonl. The DM reads it here, narrates the outcome (say.py), and
applies mechanics (apply_event.py).

Usage:
  get_input.py <cid> [count]     # default: last 5 submissions (peek, no cursor)
  get_input.py <cid> --new       # only UNprocessed submissions; advances a cursor
                                   # (use this in the auto-response loop)
"""
import json
import os
import sys

from common import input_path, campaign_dir


def _cursor_path(cid):
    return os.path.join(campaign_dir(cid), "input_cursor.txt")


def _all_lines(cid):
    try:
        with open(input_path(cid), "r", encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip()]
    except FileNotFoundError:
        return []


def tail(cid, n=5):
    out = []
    for l in _all_lines(cid)[-n:]:
        try:
            out.append(json.loads(l))
        except ValueError:
            pass
    return out


def new(cid):
    """Return submissions past the cursor and advance it to the end."""
    lines = _all_lines(cid)
    cp = _cursor_path(cid)
    try:
        cursor = int(open(cp).read().strip())
    except (OSError, ValueError):
        cursor = 0
    fresh = []
    for l in lines[cursor:]:
        try:
            fresh.append(json.loads(l))
        except ValueError:
            pass
    with open(cp, "w", encoding="utf-8") as f:
        f.write(str(len(lines)))
    return fresh


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: get_input.py <cid> [count|--new]", file=sys.stderr)
        sys.exit(1)
    cid = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] == "--new":
        print(json.dumps(new(cid), indent=2, ensure_ascii=False))
    else:
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        print(json.dumps(tail(cid, n), indent=2, ensure_ascii=False))
