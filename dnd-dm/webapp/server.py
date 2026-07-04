#!/usr/bin/env python3
"""Read-only dashboard server for the DM engine.

A tiny local HTTP server that serves the single-page dashboard and a
read-only JSON API onto the campaign files. It NEVER writes live state —
the DM loop (apply_event) is the only writer, which sidesteps almost all
concurrency concerns. Because the tools write atomically (temp file +
os.replace), every read here sees a complete file, never a half-written one.

The one future exception (see SPEC.md sec.9) is the loot-box screen, which must
route its single write through promote_boon rather than editing files here.
That endpoint is intentionally not implemented yet.

Usage:
  python3 webapp/server.py [--port 8787]
  then open http://localhost:8787
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Reuse the canonical paths + atomic-read loaders from the tools layer.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tools"))
import common  # noqa: E402

CID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}


def list_campaigns():
    """Every campaign dir that has a campaign.json, with a little header info."""
    out = []
    if not os.path.isdir(common.CAMPAIGNS_DIR):
        return out
    for cid in sorted(os.listdir(common.CAMPAIGNS_DIR)):
        cpath = common.campaign_path(cid)
        if not os.path.isfile(cpath):
            continue
        try:
            c = common._read(cpath)
        except (OSError, ValueError):
            continue
        out.append({
            "id": cid,
            "name": c.get("name", cid),
            "tone": c.get("tone", {}),
            "gameTime": c.get("gameTime"),
            "status": c.get("status", "active"),
            "playerCount": c.get("playerCount"),
        })
    return out


def campaign_bundle(cid):
    """Everything the dashboard needs for one campaign in a single read:
    the campaign config, live state, and the canonical character records for
    every roster member (for ability scores + boon detail the snapshot omits).
    Also folds in recap.md so the story panel needs no extra request.
    """
    campaign = common.load_campaign(cid)
    state = common.load_state(cid)
    characters = {}
    for pid, part in state.get("participations", {}).items():
        char_id = part.get("characterId")
        if char_id and char_id not in characters:
            try:
                characters[char_id] = common.load_character(char_id)
            except (OSError, ValueError):
                characters[char_id] = None
    recap = ""
    recap_path = os.path.join(common.campaign_dir(cid), "recap.md")
    if os.path.isfile(recap_path):
        with open(recap_path, "r", encoding="utf-8") as f:
            recap = f.read()
    # Story feed: tail of the append-only dialogue log (narrative, not state).
    dialog = []
    dpath = common.dialog_path(cid)
    if os.path.isfile(dpath):
        with open(dpath, "r", encoding="utf-8") as f:
            for ln in f.readlines()[-150:]:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    dialog.append(json.loads(ln))
                except ValueError:
                    pass
    # Current player-facing prompt + suggested response buttons (DM-authored).
    prompt = None
    ppath = common.prompt_path(cid)
    if os.path.isfile(ppath):
        try:
            prompt = common._read(ppath)
        except (OSError, ValueError):
            prompt = None
    # Dice rolls (structured) — the web app animates the newest as a spinning die.
    rolls = []
    rpath = common.rolls_path(cid)
    if os.path.isfile(rpath):
        with open(rpath, "r", encoding="utf-8") as f:
            for ln in f.readlines()[-25:]:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    rolls.append(json.loads(ln))
                except ValueError:
                    pass
    return {
        "campaign": campaign,
        "state": state,
        "characters": characters,
        "recap": recap,
        "dialog": dialog,
        "prompt": prompt,
        "rolls": rolls,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "DMDashboard/0.1"

    def log_message(self, fmt, *args):  # quieter console
        sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path):
        fname, ctype = STATIC[path]
        fpath = os.path.join(HERE, fname)
        try:
            with open(fpath, "rb") as f:
                self._send(200, f.read(), ctype)
        except OSError:
            self._send(404, {"error": f"missing {fname}"})

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        if path in STATIC:
            return self._serve_static(path)

        if path == "/api/campaigns":
            return self._send(200, list_campaigns())

        m = re.match(r"^/api/data/([^/]+)$", path)
        if m:
            cid = m.group(1)
            if not CID_RE.match(cid) or not os.path.isfile(common.campaign_path(cid)):
                return self._send(404, {"error": "unknown campaign"})
            try:
                return self._send(200, campaign_bundle(cid))
            except (OSError, ValueError) as e:
                return self._send(500, {"error": str(e)})

        self._send(404, {"error": "not found"})

    def do_POST(self):
        # The one write path (SPEC.md sec.10 player-input queue): the web app
        # POSTs the player's composed response. We append it to the input queue
        # (for the DM to read) and echo it into the story feed so it shows up.
        path = self.path.split("?", 1)[0]
        m = re.match(r"^/api/input/([^/]+)$", path)
        if not m:
            return self._send(404, {"error": "not found"})
        cid = m.group(1)
        if not CID_RE.match(cid) or not os.path.isfile(common.campaign_path(cid)):
            return self._send(404, {"error": "unknown campaign"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 8000:
                return self._send(400, {"error": "empty or oversized body"})
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            text = (body.get("text") or "").strip()
            if not text:
                return self._send(400, {"error": "no text"})
        except (ValueError, OSError) as e:
            return self._send(400, {"error": str(e)})

        ts = common.now_iso()
        # 1) queue it for the DM
        with open(common.input_path(cid), "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": ts, "text": text}, ensure_ascii=False) + "\n")
        # 2) echo it into the story feed (party voice) so the player sees it land
        dpath = common.dialog_path(cid)
        try:
            with open(dpath, "r", encoding="utf-8") as f:
                nid = sum(1 for _ in f) + 1
        except FileNotFoundError:
            nid = 1
        with open(dpath, "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": nid, "ts": ts, "speaker": "You", "type": "player", "text": text}, ensure_ascii=False) + "\n")
        return self._send(200, {"ok": True})


def main():
    port = 8787
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"DM dashboard (read-only) on http://localhost:{port}  —  Ctrl+C to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        srv.shutdown()


if __name__ == "__main__":
    main()
