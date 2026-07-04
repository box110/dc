# Ashfall — a file-backed D&D Dungeon Master

An event-sourced Dungeon Master you drive from the command line, with an
interactive web app for the players at the table. The DM narrates, calls for
rolls, and voices NPCs; the JSON files on disk are the source of truth, so game
state never lives in the conversation.

Two design rules everything serves:

1. **Claude decides; code does arithmetic.** The model says "the ogre hits for
   12"; a deterministic script computes `52 − 12 = 40` and logs it. HP never
   drifts.
2. **One writer per file class.** Live campaign state is written only by
   `apply_event`; canonical characters only by `promote_boon`.

See [`SPEC.md`](SPEC.md) for the full design, and
[`dnd-dm/webapp/README.md`](dnd-dm/webapp/README.md) for web-app internals.

---

## Requirements

- **Python 3** (standard library only — no pip installs).
- A **modern browser** for the web app. It loads Vue 3 + PrimeVue from a CDN, so
  it needs **internet access** the first time it renders (no build step).
- **[Claude Code](https://claude.com/claude-code) CLI** (`claude`) — to run the
  DM. Interactive play, or the headless per-turn mode below.

Nothing to install or build. Clone and go.

```bash
git clone git@github.com:box110/dc.git
cd dc/dnd-dm
```

Everything below is run from the `dnd-dm/` directory.

---

## Run the web app (dashboard + story stage)

```bash
python3 webapp/server.py            # http://localhost:8787
python3 webapp/server.py --port 9000
```

A small local Python server. Open the URL and pick a campaign from the switcher.
It shows the **story pane** (narration + per-actor text-to-speech), the party
roster, boss tree, an animated **dice tray**, and a **compose box** the players
type into. It is read-only for game state — the DM loop is the only writer — with
one narrow write path (the player-input queue). See the webapp README for the
controls (narration, spacebar-pause, splitter, dice sound, etc.).

> A fresh clone has the engine + two example characters but **no campaign**
> (campaign data is gitignored). Create one first (next section), then it will
> appear in the switcher.

---

## Play the game

The DM is Claude Code, guided by [`dnd-dm/CLAUDE.md`](dnd-dm/CLAUDE.md) (loaded
automatically when you run `claude` in this directory).

### Start / create a campaign (interactive)

```bash
cd dnd-dm
claude
```

Then tell it you want a new campaign. It runs a conversational intake (tone →
players → roster → premise → game length), scaffolds
`campaigns/<id>/` (config, state, recap, lore, boss tree), and you play from
there. Each turn it reads the small slice it needs, narrates, and writes changes
back as events.

### Headless auto-DM (fast, hands-off turns)

Instead of playing inside one long chat, run each turn as a **fresh**
`claude -p` with a tiny context. A watcher fires a turn whenever a player submits
from the web app:

```bash
tools/dm_watch.sh <campaign_id>          # e.g. tools/dm_watch.sh ashfall
DM_MODEL=haiku tools/dm_watch.sh ashfall # pick the model (default: sonnet)
```

Now the loop is: player types in the browser → Ctrl/⌘+Enter → the watcher plays
the turn → narration + dice appear in the web app. Stop with `pkill -f dm_watch`.

---

## Tools (`dnd-dm/tools/`)

CLI scripts, one per action. All writes are atomic (temp file + rename), so the
web app never reads a half-written file.

| Tool | What it does |
|------|--------------|
| `get_state.py <cid> [slice]` | Read a small slice: `scene`, `party`, `combat`, `bosses`, `position`, `all`. |
| `apply_event.py <cid> '<event>'` | **The only** mutator of live state (damage, heal, conditions, slots, gold, inventory, combat, boss cascade). |
| `roll.py <cid> '<json>'` | Roll dice; records a structured roll the web app animates as a spinning die. |
| `say.py <cid> '<json>'` | Append attributed story dialogue to the web app's story feed (spoken aloud). |
| `prompt.py <cid> '<json>'` | Publish the player prompt + suggestion buttons to the web app. |
| `get_input.py <cid> [--new]` | Read player responses submitted from the web app. |
| `promote_boon.py <cid> <charId> '<boon>'` | **The only** writer of canonical character files. |
| `complete_campaign.py <cid> '<lootbox>'` | Runs after the final boss; generates the loot box. |
| `query_lore.py <cid> '<query>'` | Unstructured recall over `lore/` + the log. |

---

## Project layout

```
dnd-dm/
  CLAUDE.md              standing DM instructions + tool contract
  characters/<id>.json   canonical, reusable characters (own boons[])
  campaigns/<id>/        live campaign data — gitignored (state, log, recap, lore, dialog, rolls)
  tools/                 the CLI scripts above + dm_watch.sh (headless runner)
  webapp/                the read-only Vue + PrimeVue dashboard / story stage
SPEC.md                  full build spec & design
```

Live campaign data under `campaigns/` is intentionally **not** committed — it
changes every turn. Canonical characters (`characters/`) are tracked as
reusable fixtures.
