# D&D DM Engine — Build Spec

A file-backed, event-sourced Dungeon Master you drive from the Claude Code CLI,
with a read-only web dashboard for the humans at the table.

This spec is self-contained. A working skeleton already exists (see
`dnd-dm/`) — treat it as the reference implementation for the data layer and
extend from there. Where this spec and the skeleton disagree, this spec wins.

---

## 1. Core idea & why it's shaped this way

Each DM turn is a stateless CLI call. Claude Code does not remember prior calls,
and that is the point: **no game state lives in the conversation.** It lives in
JSON on disk. Every turn reads the small slice it needs, narrates, and writes
changes back as events. The files remember so the model doesn't have to.

Two hard principles fall out of this, and everything else serves them:

1. **Claude decides; code does arithmetic.** The model chooses that the ogre
   hits for 12. A deterministic script computes 52 − 12 = 40 and logs it. This
   is why HP never drifts across a long fight. The model must never hand-edit
   whole state objects — it emits events.
2. **One writer per file class.** Live campaign state is written only by
   `apply_event`. Canonical character files are written only by `promote_boon`.
   Single-writer paths make every mutation auditable and make corruption hard.

Keep each CLI call's context small: sliced reads, a rolling recap instead of the
full log, and lazy generation of content the party hasn't reached yet.

---

## 2. Data model

### 2.1 Characters (canonical, reusable)

`characters/<id>.json`. Durable identity, shared across campaigns. Owns an
**uncapped** collection of earned boons. Carries **no live HP** — current HP,
conditions, and spent resources are campaign-scoped, never stored here.

Changes to a character file happen in exactly two situations: character creation,
or a loot-box grant at campaign end via `promote_boon`. Nothing during play
touches it.

Boon records carry provenance (`grantedBy`, `grantedAt`) so any permanent power
can be traced to the campaign that awarded it, and cleanly undone.

### 2.2 Snapshot-on-join

When a character joins a campaign, their base stats **plus their equipped boons**
are resolved into a campaign-local **participation** record in that campaign's
`state.json`. All change during play mutates the participation, never the
canonical character. Consequence: the same character can be wounded and level-5
in one campaign and untouched and level-12 in another, with no conflict.

"Snapshot" is not a raw copy — it is base stats **with equipped boons resolved**
into concrete inventory / spells / stat effects.

### 2.3 The 2-boon rule (own vs. equip)

- **Owning** is uncapped: a character accumulates boons for life.
- **Equipping** is capped at **2** per campaign, chosen at intake.
- Loadout is **locked** for the whole campaign — no mid-campaign swaps.

A brand-new character has zero boons and skips the choice. A returning character
with more than two picks which two to bring; the rest stay home for a future
campaign.

### 2.4 Boss tree (indefinite games only)

Three tiers, nested as a containment tree, à la *Dungeon Crawler Carl*:

```
Level (floor)
 └─ Borough
     └─ Neighborhood
```

Each tier is a **gate**:

- Defeat a **neighborhood** boss → mark it cleared, advance to the next
  neighborhood in the borough.
- Clear the **last neighborhood** in a borough → unlock the **borough** boss.
- Defeat a **borough** boss → advance to the next borough, or if it was the
  last, unlock the **level** boss.
- Defeat the **level** boss → descend to the next level, or if it was the final
  level, the **campaign completes** and the loot box drops.

Short (`<1hr`) and session (`1–2hr`) campaigns skip the tree entirely: one flat
boss. Game-time controls whether the tree exists at all.

A `position` pointer in `state.json` tracks where the party is in the tree; it
is what the DM reads to know which boss is next.

### 2.5 Two reward lanes

- **Neighborhood / borough bosses** drop **campaign-local** rewards (gear,
  consumables, gold, temporary powers). These live in the participation and
  vanish when the campaign archives. They never touch the permanent collection.
- **The final level boss** (campaign completion) drops the **permanent** boon
  via the loot box. This is the only path to a canonical write.

Keeping the two lanes separate is what lets the crawl reward the party
constantly without inflating their permanent power.

### 2.6 The loot box

On campaign completion, generate **3 themed candidate boons per character**,
drawn from what actually happened in the campaign and scaled to tone + length
(short = minor; session = moderate; indefinite = significant but capped — never
mint a game-breaker). The human picks **one per character**; the unchosen
evaporate. The pick is promoted into the permanent collection via `promote_boon`.

---

## 3. Directory layout

```
dnd-dm/
  CLAUDE.md                       # standing DM instructions + tool contract (exists)
  characters/
    <id>.json                     # canonical, reusable, owns boons[]
  campaigns/
    <campaign-id>/
      campaign.json               # config: tone, premise, time, roster, boss tree
      state.json                  # live: participations, position, combat, rewards
      session-log.jsonl           # append-only event history
      recap.md                    # rolling narrative summary (read each turn)
      lootbox.json                # written at completion; picks recorded here
      lore/*.md                   # campaign notes for retrieval
  tools/
    common.py                     # atomic IO, paths, event log (exists)
    get_state.py                  # sliced reads (exists)
    apply_event.py                # the only live-state mutator (exists)
    complete_campaign.py          # generate loot box, archive (exists)
    promote_boon.py               # the only canonical-character writer (exists)
    query_lore.py                 # retrieval over lore/ + log (exists, grep-based)
    new_campaign.py               # OPTIONAL helper; intake is conversational
  webapp/                         # TO BUILD — read-only dashboard
```

---

## 4. Tool contract

All tools are CLI scripts under `tools/`, invoked one per action. All writes are
atomic (temp file + `os.replace`) so the web app never reads a half-written file.
Every mutation appends to `session-log.jsonl`.

| Tool | Signature | Role |
|------|-----------|------|
| `get_state.py` | `<cid> [slice]` | Read a slice: `scene` (default), `party`, `combat`, `position`, `bosses`, `all`. Keep reads small. |
| `apply_event.py` | `<cid> '<event_json>'` | **Only** mutator of live state. Deterministic arithmetic + boss cascade. |
| `complete_campaign.py` | `<cid> '<lootbox_json>'` | Fires after the final level boss. Writes `lootbox.json`, freezes campaign. |
| `promote_boon.py` | `<cid> <charId> '<boon_json>'` | **Only** writer of canonical character files. Appends to `boons[]` with provenance. |
| `query_lore.py` | `<cid> '<query>'` | Unstructured recall over `lore/` + log. Never for HP/positions. |

### 4.1 Event types (`apply_event`)

`damage`, `heal`, `temp_hp`, `add_condition`, `remove_condition`, `spend_slot`,
`regain_slot`, `restore_slots`, `use_resource`, `adjust_gold`, `add_item`,
`use_item`, `start_combat`, `end_combat`, `boss_defeated`, `local_reward`,
`set_position`.

`add_item` / `use_item` maintain a character's own `inventory[]` (per-character
live state): `add_item` appends gear and stacks consumables by name; `use_item`
decrements a numeric `qty` and drops the entry at 0. Carried, quantity-tracked
items belong here — `local_reward` is for campaign-scoped *drop records* and
party quest-items, not for things a specific character consumes.

`regain_slot` hands back a single spent spell slot (Arcane Recovery, short-rest
features) without touching resources like Rage — which is what distinguishes a
short rest from `restore_slots`' full long-rest reset.

`adjust_gold` changes a participation's campaign-scoped `gold` purse (positive
to gain, negative to spend; clamps at 0). Gold is live state, so it lives on the
participation, never the canonical character.

`start_combat` opens a fresh encounter: it registers the non-party combatants
(bosses/monsters) into `combat.combatants` so damage can target them and the web
combat feed has state to render, sets `active`/`round`, and records the DM's
initiative order. Party members stay in participations; they are referenced in
the initiative list by participation id. `end_combat` closes the encounter —
flips `active` off and clears the transient combatants and initiative; party
participation state (HP, conditions) carries forward untouched.

Rules the mutator must enforce:

- **Damage applies to temp HP first**, then real HP, floored at 0.
- **Temp HP does not stack** — a new grant takes the max, not the sum.
- **A boss combatant reaching 0 HP auto-fires the tiered cascade** (same logic
  as an explicit `boss_defeated`): resolve the tier, advance `position`, unlock
  the next boss, and set a completion flag only if it was the final level boss.
- Healing is capped at maxHp. Slot/resource spends clamp at their max.

### 4.2 Retrieval: two distinct lanes — do not conflate

- **Structured state** (HP, positions, conditions, slots, initiative): read
  exactly from JSON via `get_state`. This is not RAG.
- **Unstructured recall** (what an NPC said, faction motives, past events):
  `query_lore` over `lore/` and the log. This is the only place fuzzy retrieval
  belongs. Never fetch a hit-point total through retrieval — that is how you get
  hallucinated numbers.

Start `query_lore` as keyword/substring search (already implemented). Upgrade to
embeddings only if recall quality demands it — do not over-build RAG on day one.

---

## 5. The turn loop

```
1. get_state <cid> scene        # small current slice
2. read recap.md                # story so far (not the full log)
3. query_lore if narrative recall is needed
4. narrate, voice NPCs, call for rolls
5. apply_event ...              # once per mechanical change
6. turn ends — state is on disk, context discarded
```

The web app polls `state.json` and updates the human dashboard independently of
the DM loop.

---

## 6. Campaign creation (conversational intake)

Intake is run **conversationally by Claude Code** (guided by `CLAUDE.md`), not by
a rigid script. A `new_campaign.py` helper may scaffold empty files, but the
interview and all creative generation are conversational.

Interview order matters — **roster before premise** so the story can hook into
the party:

1. **Tone** — mature / comedic / family / heroic / horror / gritty, plus an
   optional free-text modifier ("comedic but with real stakes").
2. **Player count.**
3. **Roster** — per slot, pick an existing character from `characters/` or
   create a new one (writes a new canonical file with empty `boons[]`). For each
   returning character with more than two boons, have the player **pick up to 2
   to equip**; locked for the campaign.
4. **Premise** — with the party known, propose 2–3 hooks that draw on their
   backstories and boons; riff with the human; converge on one paragraph plus a
   couple of threads and key NPCs.
5. **Game time** — `<1hr` / `1–2hr` / `indefinite`; sets boss topology and pacing.

Then generate the boss structure and write `campaign.json`, `state.json`
(participations with snapshot + ≤2 equipped boons resolved), `recap.md` (the
premise), and `lore/` seed notes.

### 6.1 Party-aware generation

Campaign generation must read each character's profile and boons. A good opening
references at least one thing about at least one character. Bosses should be
seeded from the party where possible — a boon's `grantedBy` provenance is prime
antagonist material (the giant whose axe you carry has kin who want it back).

### 6.2 Lazy generation for indefinite games

Generating a whole boss tree up front is wasted work the party may never reach,
and it bloats context. Instead:

- At intake, generate the **level boss** and the **first borough's**
  neighborhood bosses — enough to start.
- Generate the next borough's contents when the party clears the current one.
- Late bosses should react to earlier play — read the recap/log when generating
  them.

---

## 7. Pacing & scaling by game-time

| Game time | Boss topology | Pacing | Loot tier |
|-----------|---------------|--------|-----------|
| `<1hr` | one flat boss | single contained arc; wrap it up | minor |
| `1–2hr` | one flat boss | a chapter; cliffhanger OK | moderate |
| `indefinite` | full lazy tree | slow-burn subplots, recurring NPCs | significant, capped |

Scale each boss by **player count** (HP, damage, action economy — a solo boss vs.
4 players needs legendary actions / lair effects), by **game-time** (one-shot =
single phase; saga = multi-phase setpiece), and by **tone**.

---

## 8. Losing

If the party loses a boss fight: a TPK ends the campaign **without** a loot box
(optionally a single flavorful "scar" boon). Non-lethal failures can mean retreat
and retry. Never hand out the completion loot box unless the final level boss
actually fell.

---

## 9. Web app — TO BUILD

A **read-only** viewer onto the campaign files. It never writes; the DM loop is
the only writer, which sidesteps almost all concurrency concerns.

Requirements:

- **Campaign switcher** at the top; lists `campaigns/*/` and loads the chosen one.
- **Party roster** — a tab per character showing live participation state: HP
  (with a bar and temp HP), AC, speed, ability scores + modifiers, conditions,
  spell slots as pips, equipped boons, inventory, notes. (An earlier standalone
  React tracker, `CharacterTracker.jsx`, already implements this UI for a single
  party — reuse it as the starting point for the roster view, swapping its local
  state for reads against `state.json`.)
- **Boss tree view** — show the neighborhood → borough → level structure with
  cleared/locked/current status and the `position` marker.
- **Combat feed** — when combat is active, show initiative order and combatant
  HP/conditions, ideally streaming from the session log.
- **Loot-box screen** — at campaign completion, present each character's 3
  candidates and let the human pick one; the pick calls `promote_boon`. (This is
  the one place the web layer triggers a write; route it through the tool, not a
  direct file edit.)

Implementation notes:

- Poll `state.json` (or watch the file) and render progressively; don't block the
  whole UI on one fetch.
- Because writes are atomic renames, the app will only ever read a complete file.
- Keep it a small local server (the humans and the CLI are on the same machine).

---

## 10. Build order

1. **Data layer** (done in skeleton): `common.py`, character + campaign +
   state schemas, two example characters.
2. **Core tools** (done): `get_state`, `apply_event` with the cascade,
   `complete_campaign`, `promote_boon`, `query_lore`.
3. **Prove the loop**: run a fight through stateless calls; kill the tier bosses
   in sequence; confirm the cascade advances position and unlocks the next boss;
   confirm canonical files never move until `promote_boon`. (The skeleton passes
   these.)
4. **Conversational intake**: exercise the `CLAUDE.md` wizard end to end —
   create a party, generate a party-aware boss tree, scaffold the campaign.
5. **Web app**: campaign switcher + roster (reuse the React tracker) first, then
   boss tree, combat feed, and loot-box screen.
6. **Only if needed**: swap `query_lore` grep for embeddings; add a player-input
   queue if you want the web app to be interactive rather than read-only.

---

## 11. Invariants to assert in tests

- Applying `damage` then re-reading in a **separate** call returns the reduced
  HP (state survives statelessness).
- Damage consumes temp HP before real HP; temp HP takes max, not sum.
- Defeating all neighborhoods in a borough unlocks the borough boss; defeating
  all boroughs unlocks the level boss; the final level boss sets the completion
  flag.
- A canonical character file is byte-identical before and after a full combat;
  it changes **only** after `promote_boon`.
- A promoted boon carries `grantedBy` and `grantedAt`.
- The equipped-boon count in any participation is ≤ 2.
- Two concurrent readers of `state.json` never observe a partial write.
