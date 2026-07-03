// Data-driven dashboard: a reactive store the poll updates; Vue + PrimeVue
// render from it. No manual DOM manipulation. Read-only — never writes state.
import { createApp, reactive, computed } from "vue";
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
  bundle: null,   // {campaign, state, characters, recap}
  selectedChar: null,
  live: "connecting",
});

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

    return {
      S, ABILITIES: ["STR", "DEX", "CON", "INT", "WIS", "CHA"],
      campaign, subtitle, party, partyGold, sel, selectedId,
      levels, lvlStatus, borStatus, nbStatus, flags,
      combat, combatRows, rewards, recapHtml,
      abilityMod, hpPct, hpClass, spellDesc, cidModel,
      selectChar: (id) => { S.selectedChar = id; },
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
              <div class="spell-row"><Chip v-for="s in sel.char.spells.cantrips" :key="s" :label="s" v-tooltip.top="spellDesc(s)" class="spell" /></div>
            </div>
            <div class="spell-lv" v-for="(list, lv) in sel.char.spells.known" :key="lv">
              <span class="lv-tag">L{{ lv }}</span>
              <div class="spell-row"><Chip v-for="s in list" :key="s" :label="s" v-tooltip.top="spellDesc(s)" class="spell" /></div>
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
              <li v-for="(it, idx) in sel.part.inventory" :key="idx">
                <span class="iname">{{ it.name }}<span v-if="it.fromBoon" class="src"> ◆ boon</span><span v-if="it.detail" class="idetail">{{ it.detail }}</span></span>
                <span class="q" v-if="it.qty">×{{ it.qty }}</span>
              </li>
            </ul>
          </div>

          <div class="section" v-if="sel.part.notes"><h4>Notes</h4><div class="notes">{{ sel.part.notes }}</div></div>
        </div>
      </Panel>

      <!-- Combat -->
      <Panel>
        <template #header><span class="pv-title">Combat</span>
          <span class="pv-aux">{{ combat.active ? 'round ' + combat.round : 'no active encounter' }}</span>
        </template>
        <DataTable v-if="combat.active" :value="combatRows" size="small" dataKey="ord">
          <Column field="ord" header="#" style="width:2.5rem" />
          <Column header="Combatant">
            <template #body="{ data }">
              <span :class="{ 'foe-name': data.foe }">{{ data.name }}</span>
              <Tag v-if="!data.foe" value="party" severity="secondary" class="mini-tag" />
              <span class="rowconds"><Tag v-for="c in data.conditions" :key="c" severity="danger" :value="c" class="mini-tag" /></span>
            </template>
          </Column>
          <Column header="HP" style="width:38%">
            <template #body="{ data }">
              <ProgressBar :value="data.pct" :showValue="false" :class="'hpbar ' + data.cls" style="height:10px" />
              <span class="hp-txt">{{ data.hp }}/{{ data.maxHp }}<span v-if="data.tempHp"> +{{ data.tempHp }}</span></span>
            </template>
          </Column>
        </DataTable>
        <p v-else class="empty">Out of combat. The initiative order appears here when the DM calls <code>start_combat</code>.</p>
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
          <li v-for="(r, i) in rewards" :key="i" class="rewards">◆ {{ typeof r === 'string' ? r : (r.name || 'reward') }}</li>
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

  <footer class="foot">
    <span>Read-only dashboard · Vue + PrimeVue · the DM loop is the only writer.</span>
    <span v-if="S.bundle && S.bundle.state && S.bundle.state.updatedAt">state updated {{ new Date(S.bundle.state.updatedAt).toLocaleTimeString() }}</span>
  </footer>
  `,
};

const app = createApp(App);
app.use(PrimeVue, { theme: { preset: Aura, options: { darkModeSelector: ".dark-mode", cssLayer: false } } });
app.mount("#app");
window.__vueMounted = true;
boot();
