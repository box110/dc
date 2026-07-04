#!/usr/bin/env bash
# Headless auto-DM watcher.
#
# The problem this solves: running the DM turn loop inside a long-lived chat
# session means every turn re-ingests the ENTIRE conversation transcript
# (megabytes). The game files a turn actually needs are ~20KB. So instead we run
# each turn as a FRESH `claude -p` invocation with a tiny context: it loads
# CLAUDE.md (project instructions, auto-loaded from the working dir) + reads the
# recap + a get_state slice + the new input, plays one turn, and exits.
#
# This watcher is deliberately dumb: it only decides WHEN to fire a turn (when
# the input queue has unprocessed lines). The fresh Claude consumes the queue
# via `get_input.py --new` (which advances input_cursor.txt — the source of
# truth for what's processed), so there is no race with this line-count check.
#
# Usage:  tools/dm_watch.sh [campaign_id]
# Model:  override with DM_MODEL env var (default: sonnet — fast + good voice).
set -u
CID="${1:-ashfall}"
MODEL="${DM_MODEL:-sonnet}"
ROOT="/Users/jonathanbishop/development/personal/DND/dnd-dm"
QUEUE="$ROOT/campaigns/$CID/player_input.jsonl"
CURSOR="$ROOT/campaigns/$CID/input_cursor.txt"
PROMPT="$(sed "s/{CID}/$CID/g" "$ROOT/tools/dm_turn_prompt.md")"
LOG="$ROOT/campaigns/$CID/dm_watch.log"

cd "$ROOT" || exit 1
echo "[dm_watch] campaign=$CID model=$MODEL watching $QUEUE" | tee -a "$LOG"

while true; do
  cur=$(wc -l < "$QUEUE" 2>/dev/null || echo 0)
  done_n=$(cat "$CURSOR" 2>/dev/null || echo 0)
  if [ "${cur:-0}" -gt "${done_n:-0}" ]; then
    ts=$(date '+%H:%M:%S')
    echo "[dm_watch $ts] $((cur - done_n)) new submission(s) -> fresh DM turn (claude -p, $MODEL)" | tee -a "$LOG"
    claude -p "$PROMPT" --model "$MODEL" --dangerously-skip-permissions >>"$LOG" 2>&1
    echo "[dm_watch $(date '+%H:%M:%S')] turn done." | tee -a "$LOG"
  fi
  sleep 2
done
