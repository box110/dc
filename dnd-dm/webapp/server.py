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
    return {
        "campaign": campaign,
        "state": state,
        "characters": characters,
        "recap": recap,
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
