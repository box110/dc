"""Shared helpers for the DM tools.

Design invariants (see CLAUDE.md):
  - The campaign state.json is the source of truth for live play.
  - Canonical character files change ONLY via promote_boon.
  - All writes are atomic (temp file + rename) so the web app never
    reads a half-written file.
  - Every mutation appends an event to session-log.jsonl.
"""
import json
import os
import tempfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARACTERS_DIR = os.path.join(ROOT, "characters")
CAMPAIGNS_DIR = os.path.join(ROOT, "campaigns")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _atomic_write(path, data):
    """Write JSON atomically: temp file in same dir, then rename."""
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)  # atomic on POSIX
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# ---- paths -------------------------------------------------
def campaign_dir(cid):
    return os.path.join(CAMPAIGNS_DIR, cid)


def state_path(cid):
    return os.path.join(campaign_dir(cid), "state.json")


def campaign_path(cid):
    return os.path.join(campaign_dir(cid), "campaign.json")


def log_path(cid):
    return os.path.join(campaign_dir(cid), "session-log.jsonl")


def character_path(char_id):
    return os.path.join(CHARACTERS_DIR, f"{char_id}.json")


# ---- typed accessors --------------------------------------
def load_state(cid):
    return _read(state_path(cid))


def save_state(cid, state):
    state["updatedAt"] = now_iso()
    _atomic_write(state_path(cid), state)


def load_campaign(cid):
    return _read(campaign_path(cid))


def save_campaign(cid, campaign):
    _atomic_write(campaign_path(cid), campaign)


def load_character(char_id):
    return _read(character_path(char_id))


def save_character(char_id, char):
    """ONLY promote_boon should call this. See invariants."""
    _atomic_write(character_path(char_id), char)


def append_event(cid, event):
    event = {"ts": now_iso(), **event}
    with open(log_path(cid), "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
    return event
