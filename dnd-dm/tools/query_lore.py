#!/usr/bin/env python3
"""Semantic-ish recall over a campaign's lore/ notes and session log.

Starts simple: keyword/substring search across lore markdown and the log.
For a single campaign the corpus is small enough that grep-quality recall is
often fine. Swap in embeddings later ONLY if retrieval quality demands it —
don't over-build RAG on day one.

IMPORTANT: this is for UNSTRUCTURED recall (what an NPC said, faction motives,
past events). NEVER use it for current HP/positions/conditions — those are
structured state; read them with get_state.py. Mixing the two is how you get
hallucinated hit points.

Usage:
  query_lore.py <campaign_id> '<query>'
"""
import glob
import json
import os
import sys
from common import campaign_dir, log_path


def query(cid, q):
    terms = [t.lower() for t in q.split() if len(t) > 2]
    hits = []

    # lore markdown
    for path in glob.glob(os.path.join(campaign_dir(cid), "lore", "*.md")):
        with open(path, "r", encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                low = line.lower()
                if any(t in low for t in terms):
                    hits.append({"source": os.path.basename(path), "line": i, "text": line.strip()})

    # session log (narrative events)
    lp = log_path(cid)
    if os.path.exists(lp):
        with open(lp, "r", encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                if any(t in line.lower() for t in terms):
                    try:
                        ev = json.loads(line)
                        hits.append({"source": "session-log", "line": i, "event": ev.get("event")})
                    except json.JSONDecodeError:
                        pass

    return {"query": q, "hits": hits[:20]}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: query_lore.py <campaign_id> '<query>'", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(query(sys.argv[1], sys.argv[2]), indent=2, ensure_ascii=False))
