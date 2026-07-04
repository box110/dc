// Data-driven dashboard: a reactive store the poll updates; Vue + PrimeVue
// render from it. No manual DOM manipulation. Read-only — never writes state.
import { createApp, reactive, computed, watch, nextTick } from "vue";
import PrimeVue from "primevue/config";
import Aura from "@primevue/themes/aura";
import Select from "primevue/select";
import Panel from "primevue/panel";
import Card from "primevue/card";
import Tag from "primevue/tag";
import ProgressBar from "primevue/progressbar";
import Chip from "primevue/chip";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tooltip from "primevue/tooltip";

const POLL_MS = 2000;
const LS_KEY = "dm-dashboard-campaign";

// Universal 5e spell reference — shown as PrimeVue tooltips on the sheet.
const SPELL_DESC = {
  "Fire Bolt": "Cantrip. Ranged spell attack, 120 ft. 2d10 fire (scales). Ignites flammables.",
  "Light": "Cantrip. Touch an object to shed 20 ft bright light for 1 hour.",
  "Mage Hand": "Cantrip. A spectral hand manipulates objects up to 10 lb within 30 ft.",
  "Prestidigitation": "Cantrip. Minor tricks — clean, chill, flavor, spark, tiny illusions.",
  "Burning Hands": "1st. 15-ft cone, DEX save, 3d6 fire (half on save). Ignites flammables.",
  "Shield": "1st. Reaction. +5 AC until your next turn; no Magic Missile damage.",
  "Magic Missile": "1st. Three darts, 1d4+1 force each, auto-hit. +1 dart per higher slot.",
  "Detect Magic": "1st. Concentration. Sense magic within 30 ft and each aura's school.",
  "Comprehend Languages": "1st. Understand any spoken/written language for 1 hour.",
  "Scorching Ray": "2nd. Three rays, spell attack each, 2d6 fire per hit. +1 ray per higher slot.",
  "Web": "2nd. Concentration. 20-ft cube of webbing; DEX save or restrained. Flammable.",
  "Misty Step": "2nd. Bonus action. Teleport 30 ft to a space you can see.",
  "Detect Thoughts": "2nd. Concentration. Read surface thoughts within 30 ft (WIS save resists).",
  "Fireball": "3rd. 20-ft radius at 150 ft, DEX save, 8d6 fire (half on save). +1d6 per higher slot.",
  "Counterspell": "3rd. Reaction. Interrupt a spell; auto-stops 3rd level or lower.",
  "Dispel Magic": "3rd. End one spell on a target; auto for 3rd level or lower.",
};

// ---------- reactive store ----------
const S = reactive({
  campaigns: [],
  cid: null,
  bundle: null,   // {campaign, state, characters, recap, dialog}
  selectedChar: null,
  live: "connecting",
  leftPct: Number(localStorage.getItem("dm-split")) || 50,  // story-pane width %
  audioOn: localStorage.getItem("dm-audio") === "1",         // remembered across reloads
  speechRate: Number(localStorage.getItem("dm-rate")) || 1,  // global TTS speed multiplier
  speakingId: null,                                          // id of the line being read aloud
  ttsPaused: false,                                          // narration paused (spacebar)
  draft: "",                                                 // player compose box
  sending: false,
  thinking: false,                                           // DM is composing a response
  thinkSince: 0,
  quip: "",
  roll: null,                                                // the roll being shown (structured)
  rollFace: 0,                                               // number on the die (cycles while spinning)
  rolling: false,
  rollLanded: false,
  diceOpen: localStorage.getItem("dm-dice-open") !== "0",    // dice tile expanded (default yes)
  diceMuted: localStorage.getItem("dm-dice-mute") === "1",   // dice roll sound off
});

// ---------- dice roll sound (Web Audio: hollow tumble across a tabletop) ----------
const DiceSound = {
  ctx: null, delay: null, feedback: null, wet: null,
  muted: localStorage.getItem("dm-dice-mute") === "1",
  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = this.ctx = new AC();
    // reverb/delay module (fast room echo)
    const delay = this.delay = ctx.createDelay(1.0);
    const feedback = this.feedback = ctx.createGain();
    const wet = this.wet = ctx.createGain();
    delay.delayTime.value = 0.045;
    feedback.gain.value = 0.45;
    wet.gain.value = 0.25;
    delay.connect(feedback); feedback.connect(delay);
    delay.connect(wet); wet.connect(ctx.destination);
    return ctx;
  },
  unlock() { const c = this.ensure(); if (c && c.state === "suspended") c.resume(); },
  _hit(time, volume, pitch) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    osc.type = "square";
    osc.frequency.setValueAtTime(pitch, time);
    osc.frequency.linearRampToValueAtTime(pitch * 0.7, time + 0.04);
    filt.type = "bandpass";
    filt.frequency.setValueAtTime(pitch, time);
    filt.Q.value = 5;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.045);
    osc.connect(filt); filt.connect(gain);
    gain.connect(ctx.destination);  // raw clear sound
    gain.connect(this.delay);       // + into the echo room
    osc.start(time); osc.stop(time + 0.05);
  },
  roll() {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const seq = [[0, .35, 420], [.06, .25, 460], [.15, .30, 410], [.26, .20, 390],
                 [.35, .15, 440], [.42, .10, 400], [.47, .06, 420], [.51, .03, 415]];
    for (const [t, v, p] of seq) this._hit(now + t, v, p);
  },
};

// ---------- dice: animate the newest roll as a suspenseful spinning die ----------
const DICE = {
  lastId: 0,
  primed: false,
  spin: null,
  hideT: null,
  animate(roll) {
    clearTimeout(this.spin);
    DiceSound.roll();   // hollow tumble
    const sides = roll.sides || 20;
    S.roll = roll; S.rolling = true; S.rollLanded = false;
    S.rollFace = 1 + Math.floor(Math.random() * sides);
    // spin: cycle random faces, decelerating for suspense
    let t = 0;
    const step = () => {
      S.rollFace = 1 + Math.floor(Math.random() * sides);
      t += 1;
      const delay = 45 + t * t * 1.6;           // slows down as it "settles"
      if (t < 20) this.spin = setTimeout(step, delay);
      else this.land(roll);
    };
    this.spin = setTimeout(step, 45);
  },
  land(roll) {
    clearTimeout(this.spin); this.spin = null;
    S.rollFace = (roll.count === 1) ? roll.kept : roll.total;  // die shows the natural face / total
    S.rolling = false; S.rollLanded = true;
    // no auto-hide — the die persists showing the last result in the tile
  },
  check(rolls) {
    if (!rolls || !rolls.length) return;
    const newest = rolls[rolls.length - 1];
    if (!this.primed) {
      // on load: show the latest roll statically (no spin) so die + history are populated
      this.lastId = newest.id; this.primed = true;
      S.roll = newest; S.rolling = false; S.rollLanded = true;
      S.rollFace = newest.count === 1 ? newest.kept : newest.total;
      return;
    }
    if (newest.id > this.lastId) { this.lastId = newest.id; this.animate(newest); }
  },
};

// "the DM is thinking" flavor quips
const QUIPS = [
  "The DM consults the ancient tomes…",
  "Rolling the dice behind the screen…",
  "Summoning the next encounter…",
  "Thumbing through the Monster Manual…",
  "The dungeon shifts around you…",
  "Bribing the dice gods…",
  "Unfurling the battle map…",
  "Whispering to the NPCs…",
  "Checking the corridor for traps…",
  "The candles gutter as fate is decided…",
  "Consulting the alignment chart…",
  "Rerolling a natural 1…",
  "Feeding the owlbear…",
  "Sharpening the plot hooks…",
  "Aligning the planes…",
  "The tavern goes quiet…",
];
let quipTimer = null, thinkTimeout = null;
function pickQuip() { S.quip = QUIPS[Math.floor(Math.random() * QUIPS.length)]; }
function startThinking(sinceId) {
  S.thinkSince = sinceId;
  S.thinking = true;
  pickQuip();
  clearInterval(quipTimer); quipTimer = setInterval(pickQuip, 2800);
  clearTimeout(thinkTimeout); thinkTimeout = setTimeout(stopThinking, 90000); // safety net
}
function stopThinking() {
  S.thinking = false;
  clearInterval(quipTimer); quipTimer = null;
  clearTimeout(thinkTimeout); thinkTimeout = null;
}

// ---------- victory fireworks (fires when a battle ends in a win) ----------
let prevCombatActive = false;
function launchFireworks() {
  if (typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  canvas.className = "fx-canvas";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const size = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  size();
  window.addEventListener("resize", size);
  const COLORS = ["#f0a95a", "#d9b661", "#b7abf0", "#7fb069", "#cf5b48", "#f0c9c0", "#ffffff"];
  const parts = [];
  const burst = (x, y) => {
    const n = 60 + Math.floor(Math.random() * 45);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2) * (i / n), sp = 2 + Math.random() * 4.5;
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color, r: 1.4 + Math.random() * 1.8 });
    }
  };
  let launched = 0;
  const spawn = setInterval(() => {
    burst(canvas.width * (0.12 + Math.random() * 0.76), canvas.height * (0.12 + Math.random() * 0.45));
    if (++launched >= 16) clearInterval(spawn);
  }, 240);
  let raf, start = null;
  const frame = (t) => {
    if (start === null) start = t;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.vy += 0.055; p.vx *= 0.99; p.vy *= 0.99;
      p.x += p.vx; p.y += p.vy; p.life -= 0.012;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (t - start < 5200 || parts.length) { raf = requestAnimationFrame(frame); }
    else { cancelAnimationFrame(raf); window.removeEventListener("resize", size); canvas.remove(); }
  };
  raf = requestAnimationFrame(frame);
  setTimeout(() => { clearInterval(spawn); if (canvas.parentNode) { window.removeEventListener("resize", size); canvas.remove(); } }, 9000);

  const banner = document.createElement("div");
  banner.className = "fx-banner";
  banner.textContent = "⚔  VICTORY  ⚔";
  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add("show"), 40);
  setTimeout(() => banner.classList.remove("show"), 3200);
  setTimeout(() => banner.remove(), 3800);
}

let pollTimer = null;

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}

async function tick() {
  try {
    const data = await fetchJSON("/api/data/" + encodeURIComponent(S.cid));
    S.bundle = data;
    S.live = "live";
    // fireworks when a battle just ended in a win (combat true -> false, party alive)
    const combatActive = !!(data.state && data.state.combat && data.state.combat.active);
    if (prevCombatActive && !combatActive) {
      const ps = (data.state && data.state.participations) || {};
      if (Object.values(ps).some((p) => p.hp > 0)) launchFireworks();
    }
    prevCombatActive = combatActive;
    DICE.check(data.rolls || []);   // animate the newest roll
    const dl = data.dialog || [];
    // the DM has "answered" once a non-player line appears past the send point
    if (S.thinking && dl.some((l) => l.id > S.thinkSince && l.type !== "player")) {
      stopThinking();
    }
    if (!TTS.primed) {
      // first load (incl. a remembered audioOn=true): mark everything already
      // seen so we only speak lines that arrive from here on — never the backlog.
      TTS.lastSpokenId = dl.reduce((m, l) => Math.max(m, l.id), 0);
      TTS.primed = true;
    } else if (S.audioOn) {
      TTS.speakNew(dl);
    }
  } catch (e) {
    S.live = "offline";
  }
}

function selectCampaign(cid) {
  if (!cid) return;
  S.cid = cid;
  S.selectedChar = null;
  localStorage.setItem(LS_KEY, cid);
  if (pollTimer) clearInterval(pollTimer);
  tick();
  pollTimer = setInterval(tick, POLL_MS);
}

async function boot() {
  try {
    S.campaigns = await fetchJSON("/api/campaigns");
  } catch (e) {
    S.live = "offline";
    return;
  }
  const saved = localStorage.getItem(LS_KEY);
  const pick = S.campaigns.some((c) => c.id === saved) ? saved : (S.campaigns[0] && S.campaigns[0].id);
  if (pick) selectCampaign(pick);
}

// ---------- helpers ----------
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
}
function miniMarkdown(md) {
  return (md || "").split(/\n\s*\n/).map((b) => {
    b = b.trim();
    if (!b) return "";
    const m = b.match(/^#{1,6}\s+(.*)$/);
    return m ? "<h2>" + inline(esc(m[1])) + "</h2>" : "<p>" + inline(esc(b.replace(/\n/g, " "))) + "</p>";
  }).join("");
}

// ---------- speaker identity (voice + color, consistent per actor) ----------
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Curated voice-name preferences for the main cast (best-effort across OSes;
// falls back to a deterministic hash when a named voice isn't present).
const VOICE_PREFS = {
  Narrator: ["Daniel", "Arthur", "Serena", "Google UK English Male"],
  DM: ["Daniel", "Arthur"],
  Thordak: ["Rocko", "Reed", "Fred", "Ralph", "Google UK English Male"],
  Lyra: ["Samantha", "Karen", "Moira", "Tessa", "Google US English"],
  Sella: ["Moira", "Tessa", "Fiona", "Veena"],
};
const BOSS_VOICES = ["Grandpa", "Bad News", "Rocko", "Fred", "Ralph", "Reed"];
const SPEAKER_COLORS = {
  Narrator: "#cdbfa6", DM: "#cdbfa6",
  Thordak: "#f0a95a", Lyra: "#b7abf0", Sella: "#7fb069",
};

const TTS = {
  voices: [],
  lastSpokenId: 0,
  primed: false,   // set once the initial backlog is marked seen
  assign: {},   // speaker -> { voice, pitch, rate }
  supported: typeof window !== "undefined" && "speechSynthesis" in window,

  loadVoices() {
    if (this.supported) this.voices = window.speechSynthesis.getVoices() || [];
  },
  _pickVoice(speaker, type) {
    if (!this.voices.length) return null;
    const prefs = VOICE_PREFS[speaker] || (type === "boss" ? BOSS_VOICES : null);
    if (prefs) {
      for (const p of prefs) {
        const v = this.voices.find((v) => v.name.includes(p));
        if (v) return v;
      }
    }
    const en = this.voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
    const pool = en.length ? en : this.voices;
    return pool[hashStr(speaker) % pool.length];
  },
  _prosody(speaker, type) {
    if (speaker === "Thordak") return { pitch: 0.6, rate: 0.95 };
    if (speaker === "Lyra") return { pitch: 1.2, rate: 1.03 };
    if (type === "boss") return { pitch: 0.65, rate: 0.9 };
    if (type === "narrator") return { pitch: 1.0, rate: 1.0 };
    const h = hashStr(speaker);
    return { pitch: 0.8 + (h % 45) / 100, rate: 0.92 + (h % 22) / 100 };
  },
  assignFor(speaker, type) {
    if (!this.assign[speaker]) {
      this.assign[speaker] = { voice: this._pickVoice(speaker, type), ...this._prosody(speaker, type) };
    }
    return this.assign[speaker];
  },
  // --- one-at-a-time queue: speak a line, and when it ENDS, start the next ---
  queue: [],
  active: false,
  currentId: null,
  _utter(line) {
    const a = this.assignFor(line.speaker || "Narrator", line.type || "narrator");
    const u = new SpeechSynthesisUtterance(line.text);
    if (a.voice) u.voice = a.voice;
    u.pitch = a.pitch;
    // per-speaker base rate scaled by the user's global speed multiplier
    u.rate = Math.max(0.1, Math.min(10, a.rate * (S.speechRate || 1)));
    u.onstart = () => {
      S.speakingId = line.id;   // drives the glow
      S.ttsPaused = false;
      const el = document.querySelector('[data-line-id="' + line.id + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    return u;
  },
  _drain() {
    if (this.active || !this.queue.length || !this.supported) return;
    const line = this.queue.shift();
    this.active = true;
    this.currentId = line.id;
    const advance = () => {
      if (this.currentId !== line.id) return;   // stale (was cancelled/replaced)
      this.active = false;
      this.currentId = null;
      if (S.speakingId === line.id) S.speakingId = null;
      this._drain();                            // section done -> move to the next
    };
    const u = this._utter(line);
    u.onend = advance;
    u.onerror = advance;
    window.speechSynthesis.speak(u);
  },
  speakNew(dialog) {
    for (const line of dialog) {
      if (line.id > this.lastSpokenId) {
        this.lastSpokenId = line.id;
        if (line.type === "roll") continue;  // dice show in the feed but aren't read aloud
        this.queue.push(line);
      }
    }
    this._drain();
  },
  speakLine(line) {   // click-to-replay: interrupt and jump to this line now
    if (!this.supported || !line || !line.text) return;
    this.queue = [];
    this.currentId = null;
    this.active = false;
    window.speechSynthesis.cancel();
    this.queue.push(line);
    this._drain();
  },
  stop() {
    this.queue = [];
    this.currentId = null;
    this.active = false;
    if (this.supported) window.speechSynthesis.cancel();
    S.speakingId = null;
    S.ttsPaused = false;
  },
  pauseToggle() {   // spacebar: pause / resume the current narration
    if (!this.supported) return;
    const ss = window.speechSynthesis;
    if (ss.paused) { ss.resume(); S.ttsPaused = false; }
    else if (ss.speaking) { ss.pause(); S.ttsPaused = true; }
  },
};
if (TTS.supported) {
  TTS.loadVoices();
  window.speechSynthesis.onvoiceschanged = () => TTS.loadVoices();
}

function speakerColor(speaker, type) {
  if (SPEAKER_COLORS[speaker]) return SPEAKER_COLORS[speaker];
  if (type === "roll") return "#d9b661";
  if (type === "player") return "#6fd0cf";
  if (type === "boss") return "#cf5b48";
  return "hsl(" + (hashStr(speaker) % 360) + ", 45%, 68%)";
}

// ---------- root component ----------
const App = {
  components: { Select, Panel, Card, Tag, ProgressBar, Chip, DataTable, Column },
  directives: { tooltip: Tooltip },
  setup() {
    const bundle = computed(() => S.bundle);
    const campaign = computed(() => S.bundle && S.bundle.campaign);
    const gameState = computed(() => S.bundle && S.bundle.state);
    const characters = computed(() => (S.bundle && S.bundle.characters) || {});

    const subtitle = computed(() => {
      const c = campaign.value;
      if (!c) return "read-only table view";
      const t = c.tone || {};
      return [t.primary, c.gameTime, c.playerCount ? c.playerCount + "p" : null].filter(Boolean).join(" · ");
    });

    const partForChar = (charId) => {
      const parts = (gameState.value && gameState.value.participations) || {};
      return Object.values(parts).find((p) => p.characterId === charId) || null;
    };

    const party = computed(() => {
      const c = campaign.value;
      if (!c) return [];
      const roster = c.roster || Object.values((gameState.value.participations) || {}).map((p) => ({ characterId: p.characterId }));
      return roster.map((r) => ({ id: r.characterId, char: characters.value[r.characterId] || {}, part: partForChar(r.characterId) }));
    });
    const partyGold = computed(() => party.value.reduce((s, m) => s + ((m.part && m.part.gold) || 0), 0));

    const selectedId = computed(() => {
      const ids = party.value.map((m) => m.id);
      return (S.selectedChar && ids.includes(S.selectedChar)) ? S.selectedChar : ids[0];
    });
    const sel = computed(() => party.value.find((m) => m.id === selectedId.value) || null);

    // boss tree
    const levels = computed(() => (campaign.value && campaign.value.structure && campaign.value.structure.levels) || []);
    const pos = computed(() => (gameState.value && gameState.value.position) || {});
    const flags = computed(() => (gameState.value && gameState.value.flags) || {});

    const lvlStatus = (lvl) => {
      const p = pos.value, cur = p.level === lvl.id && !p.borough && !p.neighborhood;
      const rev = (lvl.boss || {}).revealed;
      return { cls: cur ? "current" : (rev ? "" : "locked"), ico: cur ? "▸" : (rev ? "◉" : "🔒") };
    };
    const borStatus = (lvl, bor) => {
      const p = pos.value, cur = p.level === lvl.id && p.borough === bor.id && !p.neighborhood;
      const rev = (bor.boss || {}).revealed || bor.cleared;
      return { cls: bor.cleared ? "cleared" : (cur ? "current" : (rev ? "" : "locked")), ico: bor.cleared ? "✓" : (cur ? "▸" : (rev ? "◉" : "🔒")) };
    };
    const nbStatus = (lvl, bor, nb) => {
      const p = pos.value, cur = p.level === lvl.id && p.borough === bor.id && p.neighborhood === nb.id;
      return { cls: nb.cleared ? "cleared" : (cur ? "current" : ""), ico: nb.cleared ? "✓" : (cur ? "▸" : "○") };
    };

    // combat
    const combat = computed(() => (gameState.value && gameState.value.combat) || { active: false });
    const combatRows = computed(() => {
      const cb = combat.value;
      if (!cb.active) return [];
      const parts = (gameState.value.participations) || {};
      const foes = cb.combatants || {};
      const order = (cb.initiative && cb.initiative.length) ? cb.initiative : [...Object.keys(parts), ...Object.keys(foes)];
      return order.map((id, i) => {
        const part = parts[id], foe = foes[id];
        if (!part && !foe) return null;
        const o = part || foe;
        const isFoe = !!foe;
        const name = isFoe ? (foe.name || id) : ((characters.value[part.characterId] || {}).name || part.characterId);
        const pct = o.maxHp ? Math.max(0, Math.min(100, (o.hp / o.maxHp) * 100)) : 0;
        return { ord: i + 1, name, foe: isFoe, hp: o.hp, maxHp: o.maxHp, tempHp: o.tempHp || 0, pct, cls: hpClass(o), conditions: o.conditions || [] };
      }).filter(Boolean);
    });

    const rewards = computed(() => (gameState.value && gameState.value.localRewards) || []);
    const recapHtml = computed(() => miniMarkdown(S.bundle && S.bundle.recap));

    // vitals helpers
    const abilityMod = (score) => {
      const m = Math.floor((Number(score) - 10) / 2);
      return (m >= 0 ? "+" : "−") + Math.abs(m);
    };
    function hpClass(o) {
      const r = o.maxHp ? o.hp / o.maxHp : 0;
      return r > 0.5 ? "good" : (r > 0.25 ? "warn" : "bad");
    }
    const hpPct = (o) => (o && o.maxHp ? Math.max(0, Math.min(100, (o.hp / o.maxHp) * 100)) : 0);
    const spellDesc = (name) => SPELL_DESC[name] || "No description on file.";
    const cidModel = computed({ get: () => S.cid, set: (v) => selectCampaign(v) });

    // ---- story feed + TTS + splitter ----
    const dialog = computed(() => (S.bundle && S.bundle.dialog) || []);
    const prompt = computed(() => (S.bundle && S.bundle.prompt) || null);
    const rolls = computed(() => (S.bundle && S.bundle.rolls) || []);
    const rollsReversed = computed(() => rolls.value.slice().reverse());  // newest first
    watch(() => S.diceOpen, (v) => localStorage.setItem("dm-dice-open", v ? "1" : "0"));
    function toggleDiceSound() {
      DiceSound.unlock();
      DiceSound.muted = !DiceSound.muted;
      S.diceMuted = DiceSound.muted;
      localStorage.setItem("dm-dice-mute", DiceSound.muted ? "1" : "0");
      if (!DiceSound.muted) DiceSound.roll();   // audition on unmute (also unlocks audio)
    }
    const replayRoll = () => { DiceSound.unlock(); if (S.roll) DICE.animate(S.roll); };  // click die to replay + hear it

    // clicking a suggestion toggles its text in the compose box:
    // append if absent, remove if already there.
    function addSuggestion(text) {
      if (S.draft.includes(text)) {
        S.draft = S.draft.replace(text, "").replace(/\s{2,}/g, " ").trim();
      } else {
        S.draft = (S.draft ? S.draft.replace(/\s+$/, "") + " " : "") + text;
      }
    }
    // clicking a spell / weapon / item drops "<who> casts/attacks with/uses <name>" in the box
    function appendAction(text) {
      const cur = S.draft.replace(/[.\s]+$/, "");
      S.draft = (cur ? cur + ". " : "") + text;
    }
    function useSpell(s) {
      const who = sel.value && sel.value.char && sel.value.char.name;
      appendAction((who ? who + " casts " : "Cast ") + s);
    }
    function useItem(it) {
      const who = sel.value && sel.value.char && sel.value.char.name;
      const verb = it.type === "weapon" ? "attacks with" : "uses";
      appendAction((who ? who + " " + verb + " " : (it.type === "weapon" ? "Attack with " : "Use ")) + it.name);
    }
    function useReward(r) {
      const who = sel.value && sel.value.char && sel.value.char.name;
      const name = typeof r === "string" ? r : (r.name || "reward");
      appendAction((who ? who + " uses the " : "Use the ") + name);
    }
    async function sendInput() {
      const text = S.draft.trim();
      if (!text || S.sending) return;
      S.sending = true;
      const maxId = ((S.bundle && S.bundle.dialog) || []).reduce((m, l) => Math.max(m, l.id), 0);
      try {
        await fetch("/api/input/" + encodeURIComponent(S.cid), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        S.draft = "";
        startThinking(maxId);  // show the DM-thinking hourglass until a reply lands
        tick();  // pull the echoed line back immediately
      } catch (e) {
        /* leave draft in place so nothing is lost */
      } finally {
        S.sending = false;
      }
    }
    function onComposeKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); sendInput(); }
    }

    // auto-scroll the story feed to the newest line
    watch(() => dialog.value.length, () => nextTick(() => {
      const el = document.querySelector(".story-feed");
      if (el) el.scrollTop = el.scrollHeight;
    }));

    function toggleAudio() {
      if (!TTS.supported) { alert("This browser has no speech synthesis."); return; }
      if (S.audioOn) {
        S.audioOn = false;
        TTS.stop();
      } else {
        TTS.loadVoices();
        // only auto-speak lines from here forward (don't dump the backlog)
        TTS.lastSpokenId = dialog.value.reduce((m, l) => Math.max(m, l.id), 0);
        S.audioOn = true;
      }
      localStorage.setItem("dm-audio", S.audioOn ? "1" : "0");
    }
    const replay = (line) => TTS.speakLine(line);
    const stopSpeaking = () => TTS.stop();
    const pauseToggle = () => TTS.pauseToggle();
    const fmtTime = (ts) => {
      try {
        return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch (e) { return ""; }
    };
    function setRate(e) {
      S.speechRate = Number(e.target.value);
      localStorage.setItem("dm-rate", String(S.speechRate));
    }

    function startDrag(e) {
      e.preventDefault();
      const root = document.querySelector(".split-root");
      if (!root) return;
      const move = (ev) => {
        const rect = root.getBoundingClientRect();
        let pct = ((ev.clientX - rect.left) / rect.width) * 100;
        S.leftPct = Math.max(22, Math.min(78, pct));
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        localStorage.setItem("dm-split", String(Math.round(S.leftPct)));
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    }

    return {
      S, ABILITIES: ["STR", "DEX", "CON", "INT", "WIS", "CHA"],
      campaign, subtitle, party, partyGold, sel, selectedId,
      levels, lvlStatus, borStatus, nbStatus, flags,
      combat, combatRows, rewards, recapHtml,
      abilityMod, hpPct, hpClass, spellDesc, cidModel,
      selectChar: (id) => { S.selectedChar = id; },
      dialog, speakerColor, toggleAudio, replay, stopSpeaking, pauseToggle, startDrag, setRate, fmtTime,
      prompt, addSuggestion, sendInput, onComposeKey, useSpell, useItem, useReward,
      rolls, rollsReversed, toggleDiceSound, replayRoll,
    };
  },
  template: `
  <header class="topbar">
    <div class="brand">
      <span class="sigil">&#9670;</span>
      <div>
        <h1>{{ campaign ? campaign.name : 'DM Engine' }}</h1>
        <p class="sub">{{ subtitle }}</p>
      </div>
    </div>
    <div class="controls">
      <label class="switcher"><span>Campaign</span>
        <Select v-model="cidModel" :options="S.campaigns" optionLabel="name" optionValue="id"
                placeholder="Pick a campaign" style="min-width:14rem" />
      </label>
      <span class="live" :class="{ stale: S.live !== 'live' }">&#9679; {{ S.live }}</span>
    </div>
  </header>

  <div class="split-root">
    <section class="story-pane" :style="{ flexBasis: S.leftPct + '%' }">
      <div class="story-head">
        <span class="pv-title">Story</span>
        <div class="tts-controls">
          <label class="rate-ctl" title="speech speed">
            <span class="rate-ico">🐢</span>
            <input type="range" min="0.5" max="1.8" step="0.1" :value="S.speechRate" @input="setRate" />
            <span class="rate-ico">🐇</span>
            <span class="rate-val">{{ S.speechRate.toFixed(1) }}×</span>
          </label>
          <button class="ttbtn" :class="{ on: S.audioOn }" @click="toggleAudio">{{ S.audioOn ? '🔊 narration on' : '🔈 enable narration' }}</button>
          <button class="ttbtn" :class="{ on: S.ttsPaused }" @click="pauseToggle" title="spacebar">{{ S.ttsPaused ? '▶ resume' : '⏸ pause' }}</button>
          <button class="ttbtn" @click="stopSpeaking">⏹ stop</button>
        </div>
      </div>
      <div class="story-feed">
        <div v-for="line in dialog" :key="line.id" class="dline"
             :class="['sp-' + line.type, { speaking: line.id === S.speakingId }]"
             :data-line-id="line.id" @click="replay(line)" title="click to hear this line">
          <span class="dline-head">
            <span class="speaker" :style="{ color: speakerColor(line.speaker, line.type) }">{{ line.speaker }}</span>
            <span class="dtime" v-if="line.ts">{{ fmtTime(line.ts) }}</span>
          </span>
          <span class="dtext">{{ line.text }}</span>
        </div>
        <p v-if="!dialog.length" class="empty">The story appears here as it unfolds. Click “enable narration” to hear each new line, or click any line to replay it.</p>
      </div>

      <div class="compose">
        <div class="thinking" v-if="S.thinking"><span class="hourglass">⏳</span><span>{{ S.quip }}</span></div>
        <div class="prompt-text" v-if="prompt && prompt.text">{{ prompt.text }}</div>
        <div class="suggestions" v-if="prompt && prompt.suggestions && prompt.suggestions.length">
          <button v-for="(s, i) in prompt.suggestions" :key="i" class="sug" :class="{ on: S.draft.includes(s) }" @click="addSuggestion(s)">{{ S.draft.includes(s) ? '✓' : '＋' }} {{ s }}</button>
        </div>
        <textarea class="composebox" v-model="S.draft" @keydown="onComposeKey"
                  placeholder="Type your action… (buttons append here) — Ctrl/⌘+Enter to send"></textarea>
        <div class="compose-actions">
          <span class="hint">Ctrl/⌘ + Enter to send</span>
          <button class="sendbtn" :disabled="S.sending || !S.draft.trim()" @click="sendInput">{{ S.sending ? 'sending…' : 'Send ▸' }}</button>
        </div>
      </div>
    </section>

    <div class="splitter" @mousedown="startDrag" title="drag to resize"></div>

    <section class="dash-pane">
      <div class="dice-panel" v-if="rolls.length">
        <div class="dice-head" @click="S.diceOpen = !S.diceOpen">
          <span class="pv-title">Dice</span>
          <span class="dice-head-right">
            <span class="dice-last" v-if="!S.diceOpen && S.roll">{{ S.roll.label }} → <b>{{ S.roll.total }}</b></span>
            <button class="dice-mute" @click.stop="toggleDiceSound" :title="S.diceMuted ? 'roll sound off' : 'roll sound on'">{{ S.diceMuted ? '🔇' : '🔊' }}</button>
            <span class="chev">{{ S.diceOpen ? '▾' : '▸' }}</span>
          </span>
        </div>
        <div class="dice-body" v-show="S.diceOpen">
          <div class="roll-history">
            <div class="rh-row" v-for="r in rollsReversed" :key="r.id"
                 :class="{ crit: r.crit, fumble: r.fumble, current: S.roll && r.id === S.roll.id }">
              <span class="rh-mini" :class="'d' + r.sides">d{{ r.sides }}</span>
              <span class="rh-label">{{ r.label }}<span v-if="r.adv" class="rh-adv">▲</span><span v-if="r.dis" class="rh-adv">▼</span></span>
              <span class="rh-total">{{ r.total }}</span>
              <span class="rh-verdict" v-if="r.vs != null" :class="r.hit ? 'v-hit' : 'v-miss'">{{ r.hit ? 'HIT' : 'MISS' }}</span>
              <span class="rh-verdict muted" v-else>·</span>
            </div>
          </div>
          <div class="dice-stage" v-if="S.roll">
            <div class="dice-label">{{ S.roll.label }}</div>
            <div class="die" @click="replayRoll" title="click to replay (and hear it)" :class="['d' + S.roll.sides, { rolling: S.rolling, landed: S.rollLanded, crit: S.rollLanded && S.roll.crit, fumble: S.rollLanded && S.roll.fumble, hit: S.rollLanded && S.roll.hit === true, miss: S.rollLanded && S.roll.hit === false }]">
              <div class="die-shape"></div>
              <span class="die-face">{{ S.rolling ? S.rollFace : (S.roll.count === 1 ? S.roll.kept : S.roll.total) }}</span>
              <span class="die-kind">d{{ S.roll.sides }}<span v-if="S.roll.adv">▲</span><span v-if="S.roll.dis">▼</span></span>
            </div>
            <div class="dice-result" :class="{ show: S.rollLanded }">
              <span class="dice-total">= {{ S.roll.total }}</span>
              <span class="dice-math">{{ S.roll.notation }}<span v-if="S.roll.adv"> adv</span><span v-if="S.roll.dis"> dis</span></span>
              <span class="dice-verdict" v-if="S.roll.vs != null">vs {{ S.roll.vs }} · <b :class="S.roll.hit ? 'v-hit' : 'v-miss'">{{ S.roll.hit ? 'HIT' : 'MISS' }}</b></span>
              <span class="dice-tag t-crit" v-if="S.roll.crit">✦ CRIT!</span>
              <span class="dice-tag t-fumble" v-if="S.roll.fumble">✖ NAT 1</span>
            </div>
          </div>
        </div>
      </div>
      <div class="combat-tile" :class="{ pinned: combat.active }" v-if="S.bundle">
        <Panel>
          <template #header><span class="pv-title">Combat</span>
            <span class="pv-aux">{{ combat.active ? 'round ' + combat.round : 'no active encounter' }}</span>
          </template>
          <div v-if="combat.active" class="initfeed">
            <div class="init-row" v-for="row in combatRows" :key="row.ord" :class="{ foe: row.foe }">
              <span class="ord">{{ row.ord }}</span>
              <span class="who2">
                <span class="nm">{{ row.name }}<Tag v-if="!row.foe" value="party" severity="secondary" class="mini-tag" /></span>
                <span class="chips" v-if="row.conditions.length"><Tag v-for="c in row.conditions" :key="c" severity="danger" :value="c" class="mini-tag" /></span>
              </span>
              <span class="mini-hp"><ProgressBar :value="row.pct" :showValue="false" :class="'hpbar ' + row.cls" style="height:8px" /></span>
              <span class="hp-txt">{{ row.hp }}/{{ row.maxHp }}<span v-if="row.tempHp"> +{{ row.tempHp }}</span></span>
            </div>
          </div>
          <p v-else class="empty">Out of combat. The initiative order appears here when the DM calls <code>start_combat</code>.</p>
        </Panel>
      </div>
  <main v-if="sel">
    <div class="col-main">
      <!-- Roster -->
      <Panel>
        <template #header>
          <span class="pv-title">Party Roster</span>
          <span class="pv-aux">{{ party.length }} adventurer{{ party.length === 1 ? '' : 's' }} · <span class="gold-txt">{{ partyGold }} gp</span></span>
        </template>
        <div class="tabs">
          <button v-for="m in party" :key="m.id" class="tab" :class="{ active: m.id === selectedId, downed: m.part && m.part.hp === 0 }" @click="selectChar(m.id)">
            <span>{{ m.char.name || m.id }}</span><span class="cls">{{ m.char.class }}</span>
          </button>
        </div>

        <div class="sheet" v-if="sel.part">
          <div class="sheet-top">
            <div class="who">
              <h3>{{ sel.char.name || sel.id }}</h3>
              <div class="meta">{{ sel.char.race }} {{ sel.char.class }} · level {{ sel.part.snapshotLevel || sel.char.level }}</div>
            </div>
            <div class="defense">
              <div class="shieldstat"><div class="n">{{ sel.part.ac }}</div><div class="l">AC</div></div>
              <div class="shieldstat"><div class="n">{{ sel.part.speed || sel.char.speed }}</div><div class="l">Speed</div></div>
              <div class="shieldstat gold"><div class="n">{{ sel.part.gold || 0 }}</div><div class="l">Gold</div></div>
            </div>
          </div>

          <div class="hp">
            <div class="hp-row"><span class="lbl">Hit Points</span>
              <span class="val"><b>{{ sel.part.hp }}</b> / {{ sel.part.maxHp }}<span v-if="sel.part.tempHp" class="temp">+{{ sel.part.tempHp }} temp</span></span>
            </div>
            <ProgressBar :value="hpPct(sel.part)" :showValue="false" :class="'hpbar ' + hpClass(sel.part)" />
          </div>

          <div class="abilities">
            <div class="abil" v-for="k in ABILITIES" :key="k">
              <div class="k">{{ k }}</div>
              <div class="mod">{{ sel.char.scores ? abilityMod(sel.char.scores[k]) : '–' }}</div>
              <div class="raw">{{ sel.char.scores ? sel.char.scores[k] : '' }}</div>
            </div>
          </div>

          <div class="section"><h4>Conditions</h4>
            <div class="chips">
              <Tag v-for="c in (sel.part.conditions || [])" :key="c" severity="danger" :value="c" />
              <span v-if="!(sel.part.conditions || []).length" class="chip none">none</span>
            </div>
          </div>

          <div class="section" v-if="(sel.part.slots || []).some(s => s.max)">
            <h4>Spell Slots</h4>
            <div class="slot-row" v-for="s in sel.part.slots.filter(s => s.max)" :key="s.level">
              <span class="lvl">Level {{ s.level }}</span>
              <span class="pips"><span v-for="i in s.max" :key="i" class="pip" :class="i <= (s.max - s.used) ? 'full' : 'spent'"></span></span>
              <span class="count">{{ s.max - s.used }}/{{ s.max }}</span>
            </div>
          </div>

          <div class="section" v-if="sel.char.spells">
            <h4>Spells · save DC {{ sel.char.spells.saveDC }} · atk +{{ sel.char.spells.attackBonus }}</h4>
            <div class="spell-lv"><span class="lv-tag">cant</span>
              <div class="spell-row"><Chip v-for="s in sel.char.spells.cantrips" :key="s" :label="s" v-tooltip.top="spellDesc(s) + ' — click to add to your action'" class="spell" @click="useSpell(s)" /></div>
            </div>
            <div class="spell-lv" v-for="(list, lv) in sel.char.spells.known" :key="lv">
              <span class="lv-tag">L{{ lv }}</span>
              <div class="spell-row"><Chip v-for="s in list" :key="s" :label="s" v-tooltip.top="spellDesc(s) + ' — click to add to your action'" class="spell" @click="useSpell(s)" /></div>
            </div>
          </div>

          <div class="section" v-if="(sel.part.resources || []).length">
            <h4>Resources</h4>
            <div class="slot-row" v-for="r in sel.part.resources" :key="r.name">
              <span class="lvl" style="width:auto;min-width:9rem">{{ r.name }}</span>
              <span class="pips"><span v-for="i in r.max" :key="i" class="pip" :class="i <= (r.max - r.used) ? 'full' : 'spent'"></span></span>
              <span class="count">{{ r.max - r.used }}/{{ r.max }}<span v-if="r.recharge"> · {{ r.recharge }}</span></span>
            </div>
          </div>

          <div class="section">
            <h4>Boons · equipped {{ (sel.part.equippedBoons || []).length }}/2</h4>
            <div v-if="!(sel.char.boons || []).length" class="empty">No boons earned yet.</div>
            <div class="boon" v-for="b in (sel.char.boons || [])" :key="b.id" :class="{ equipped: (sel.part.equippedBoons || []).includes(b.id) }">
              <div class="bh"><span class="bn">{{ b.name }}</span>
                <Tag :severity="(sel.part.equippedBoons || []).includes(b.id) ? 'warn' : 'secondary'" :value="(sel.part.equippedBoons || []).includes(b.id) ? 'equipped' : 'owned'" />
              </div>
              <div class="bd">{{ b.detail }}</div>
              <div class="prov" v-if="b.grantedBy">from {{ b.grantedBy }}<span v-if="b.grantedAt"> · {{ b.grantedAt }}</span></div>
            </div>
          </div>

          <div class="section"><h4>Inventory</h4>
            <div v-if="!(sel.part.inventory || []).length" class="empty">Empty.</div>
            <ul class="itemlist" v-else>
              <li v-for="(it, idx) in sel.part.inventory" :key="idx" class="clickable" @click="useItem(it)" :title="(it.type === 'weapon' ? 'attack with' : 'use') + ' — click to add to your action'">
                <span class="iname">{{ it.name }}<span v-if="it.fromBoon" class="src"> ◆ boon</span><span v-if="it.detail" class="idetail">{{ it.detail }}</span></span>
                <span class="q" v-if="it.qty">×{{ it.qty }}</span>
              </li>
            </ul>
          </div>

          <div class="section" v-if="sel.part.notes"><h4>Notes</h4><div class="notes">{{ sel.part.notes }}</div></div>
        </div>
      </Panel>

    </div>

    <div class="col-aside">
      <!-- Boss tree -->
      <Panel>
        <template #header><span class="pv-title">Boss Tree</span>
          <span class="pv-aux">{{ campaign && campaign.structure ? campaign.structure.generation : '' }}</span>
        </template>
        <div class="banner complete" v-if="flags.awaitingCompletion">✦ Final boss down — campaign complete. Loot box pending.</div>
        <div class="banner next" v-else-if="flags.awaitingNextLevel">▼ Level cleared — the next floor awaits generation.</div>
        <ul class="tree" v-if="levels.length">
          <li class="lvl-node" v-for="lvl in levels" :key="lvl.id">
            <div class="node" :class="lvlStatus(lvl).cls">
              <span class="ico">{{ lvlStatus(lvl).ico }}</span>
              <span class="nm"><span class="tier-tag">level</span> {{ lvl.name }}<span class="boss-nm" v-if="lvl.boss"> — {{ lvl.boss.name }}</span></span>
            </div>
            <ul v-if="lvl.boroughs && lvl.boroughs.length">
              <li v-for="bor in lvl.boroughs" :key="bor.id">
                <div class="node" :class="borStatus(lvl, bor).cls">
                  <span class="ico">{{ borStatus(lvl, bor).ico }}</span>
                  <span class="nm"><span class="tier-tag">borough</span> {{ bor.name }}<span class="boss-nm" v-if="bor.boss"> — {{ bor.boss.name }}</span></span>
                </div>
                <ul v-if="bor.neighborhoods && bor.neighborhoods.length">
                  <li v-for="nb in bor.neighborhoods" :key="nb.id">
                    <div class="node" :class="nbStatus(lvl, bor, nb).cls">
                      <span class="ico">{{ nbStatus(lvl, bor, nb).ico }}</span>
                      <span class="nm"><span class="tier-tag">nbhd</span> {{ nb.name }}<span class="boss-nm" v-if="nb.boss"> — {{ nb.boss.name }}</span></span>
                    </div>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
        <p v-else class="empty">No boss structure.</p>
      </Panel>

      <!-- Rewards -->
      <Panel v-if="rewards.length">
        <template #header><span class="pv-title">Local Rewards</span><span class="pv-aux">this campaign only</span></template>
        <ul style="margin:0;padding:0">
          <li v-for="(r, i) in rewards" :key="i" class="rewards clickable" @click="useReward(r)" :title="(typeof r === 'string' ? '' : (r.detail || '')) + ' — click to add to your action'">◆ {{ typeof r === 'string' ? r : (r.name || 'reward') }}</li>
        </ul>
      </Panel>

      <!-- Recap -->
      <Panel v-if="S.bundle && S.bundle.recap">
        <template #header><span class="pv-title">Story So Far</span></template>
        <div class="recap" v-html="recapHtml"></div>
      </Panel>
    </div>
  </main>
  <p v-else class="loading">Loading campaign…</p>
    </section>
  </div>

  <footer class="foot">
    <span>Read-only dashboard · Vue + PrimeVue · the DM loop is the only writer.</span>
    <span v-if="S.bundle && S.bundle.state && S.bundle.state.updatedAt">state updated {{ new Date(S.bundle.state.updatedAt).toLocaleTimeString() }}</span>
  </footer>
  `,
};

// unlock Web Audio on user gestures (dice sound is blocked until the AudioContext
// is resumed inside a gesture). Not once — resume() is idempotent, so retry on
// every interaction in case the first didn't take.
["pointerdown", "keydown", "touchstart", "click"].forEach((ev) =>
  window.addEventListener(ev, () => DiceSound.unlock(), { passive: true }));

// spacebar pauses / resumes narration (unless you're typing in the compose box)
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  const t = e.target;
  const tag = t && t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
  e.preventDefault();   // don't scroll the page
  TTS.pauseToggle();
});

const app = createApp(App);
app.use(PrimeVue, { theme: { preset: Aura, options: { darkModeSelector: ".dark-mode", cssLayer: false } } });
app.mount("#app");
window.__vueMounted = true;
boot();
