# DM Engine — Web Dashboard (read-only)

A small local viewer onto the campaign files. It **never writes** live state —
the DM loop (`apply_event`) is the only writer, so there are almost no
concurrency concerns. Because the tools write atomically (temp file +
`os.replace`), the dashboard only ever reads complete files.

## Frontend: Vue 3 + PrimeVue (data-driven, no build step)

The UI is a **reactive Vue app** — a single reactive store (`S`) that the 2s poll
updates, bound to a declarative template. No manual DOM manipulation. Vue +
PrimeVue load as **ES modules from a CDN** (esm.sh, via the import map in
`index.html`), so there is still **no npm/build step** — but the page needs
**internet access** to fetch the CDN modules on load. If the CDN is blocked, the
page shows a message instead of hanging (and the pre-Vue vanilla version is
recoverable from backup).

Pinned: `vue@3.5.13`, `primevue@4.2.5`, `@primevue/themes@4.2.5` (Aura dark),
`primeicons@7`.

## Run

```bash
python3 webapp/server.py            # http://localhost:8787
python3 webapp/server.py --port 9000
```

The **server** is still pure Python stdlib (no dependencies), reusing
`tools/common.py` for paths and atomic reads. Open the URL, pick a campaign; the
app polls `state.json` every 2s and re-renders reactively.

## API (read-only)

| Route | Returns |
|-------|---------|
| `GET /api/campaigns` | every `campaigns/*/` with a `campaign.json` (id, name, tone, gameTime, status) |
| `GET /api/data/<cid>` | one bundle: `{campaign, state, characters, recap}` — canonical character records are folded in so the roster can show ability scores + boon detail the participation snapshot omits |

Unknown campaign ids and path-traversal attempts return 404.

## Layout: story pane + dashboard

The window splits into a **story pane** (left) and the **dashboard** (right),
with a **draggable splitter** (default 50/50, persisted to `localStorage`).

- **Story pane** renders the campaign's `dialog.jsonl` feed (attributed lines
  the DM writes with `tools/say.py`). Click **"enable narration"** (a browser
  gesture is required before speech) and each new line is read aloud via the
  **SpeechSynthesis API**, with a **distinct, consistent voice per speaker**
  (curated preferences for the main cast — Narrator/Thordak/Lyra/Sella/bosses —
  and a deterministic hash for everyone else; pitch/rate tuned per actor). A
  **Stop** button halts speech; click any past line to replay it.
- The **dashboard** (below/right) is everything else, unchanged.

## What's built

- **Campaign switcher** (remembers your last pick in `localStorage`).
- **Party roster** — a tab per character: HP bar + temp HP, AC/speed, gold
  (with a party total in the header), ability scores + modifiers, conditions,
  spell slots as pips, resources, owned boons (equipped ones highlighted,
  showing the 2-boon rule), inventory, notes.
- **Boss tree** — neighborhood → borough → level with cleared / current /
  locked status, the `position` marker, and completion/next-level banners.
- **Combat feed** — when `combat.active`, the initiative order with per-combatant
  HP bars and conditions (party vs. foe).

## Not yet built

- **Loot-box screen** (SPEC.md §9). This is the *one* place the web layer
  triggers a write, and it must route through `promote_boon` rather than editing
  files directly. Deferred until the completion flow is wired up.
