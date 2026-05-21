# Campaign Launcher — Changelog

---

## [2026-05-21] — Build 7 (current)

### Fixes
- **429 Rate Limit — round 3**: added rolling token-rate limiter. Previous fixes only addressed per-call token count, but the agentic loop fires multiple API calls within seconds (each adding tool results, growing the context). Now tracks cumulative input tokens in a 60-second window and waits if the next call would exceed 8,500 tokens/min (1.5K buffer below the 10K ceiling). Tool definitions are now counted in the budget (they're large).
- Console will now log `⏳ Token rate guard: X+Y > 8500/min — waiting Zs` when waiting

---

## [2026-05-21] — Build 6

### Fixes
- **429 Rate Limit — round 2**: replaced fixed 20-message history window with token-budget windowing. Now caps conversational history at 4,500 estimated tokens with a hard limit of 30 messages. Math: 4500 (history) + 250 (system prompt) + 1000 (max output) ≈ 6K tokens per request, well under the 10K/min ceiling even with the 1.5s throttle.
- `max_tokens` reduced 1200 → 1000 to give more headroom under the rate limit
- Anthropic API requirement: drops a leading assistant message if windowing lands on one (must start with user)

---

## [2026-05-21] — Build 5

### New Features
- **Fully Dynamic Dashboard** — all 4 main tabs (Character, Quests, Events, NPCs) now render entirely from `campaign_state.json`. No Rurik data bleeds through when loading a different campaign.
- **Character tab**: ability scores with click-to-roll, saving throws with proficiency markers, all 18 skills with proficiency markers, traits & features, active conditions, spell list grouped by level, portrait generated from character name/class
- **Quests tab**: active and completed quests from state, with steps and quest giver
- **Events tab**: full `history_log` timeline, newest first
- **NPCs tab**: NPC cards grouped by disposition (Allies / Neutral / Threats), all data from state
- **Spell slots**: all 9 levels handled dynamically; `longRest()` resets all levels; `toggleSlot()` works on any level
- **build-campaign.js**: parses `## Stats`, `## Saving Throws`, `## Skills`, `## Spells`, `## Traits & Features`, `## Conditions`, `## Description` from MD files
- **campaign-template.md**: updated with all new sections
- **Page title**: updates to character name on load

---

## [2026-05-21] — Build 4

### New Features
- **MD Campaign Importer** (`scripts/build-campaign.js`) — parse a Markdown file into a save bundle loadable from the menu
- **campaign-template.md** — fillable template with format documentation
- **Launcher: Import from .md file** — new menu option `[4]` runs the importer inline

### Fixes
- **429 Rate Limit fix** — chat history windowed to last 20 messages sent to API (full history still persisted to disk). `msgStartIdx` alignment fixed so `collectFinalText()` works correctly with the windowed slice.

---

## [2026-05-21] — Build 3

### New Features
- **Save System** — `saves/` folder; auto-saves current campaign before any wipe
- **Load Campaign menu** — `[3]` lists all saves with character/class/level/location/date
- **New Campaign confirmation** — warns that current campaign will be saved first
- **Launcher banner fix** — shows character details only for real campaigns; generic title for new/blank state

### New Features (Dashboard)
- **HP Bar in Header** — live bar with critical/wounded/healthy color states
- **Sound Effects** — procedural Web Audio API module (nat20, nat1, combat start, spell cast, healing)
- **Combat Tracker** — full tab: initiative order, HP bars, round counter, add enemy, damage/heal buttons
- **New Campaign wipe** — all 6 tabs + quick-roll bar clear on new campaign; Claude tab opens with welcome card; `location.reload()` restores hardcoded HTML on first real state update

---

## [2026-05-17] — Build 2

### New Features
- `SYSTEM_DIAGRAM.html` — interactive architecture guide (908 lines)
- Dashboard State Integration — HTTP API server (`campaign-api.js`, port 3140)
- Inventory tab — add/use/delete items, persisted to `campaign_state.json`
- Quests tab — quest steps with checkbox toggle
- Spell slot persistence — POST to API on every toggle, optimistic UI with server validation

### Fixes
- `scripts/load-context.js` — parses `Campaign Context full.md`, merges into state, handles long rest reset
- `campaign_state.json` extended with `spell_slots`, `channel_divinity`, `inventory` fields

---

## [2026-05-16] — Build 1 (initial)

- Agentic DM loop (up to 6 iterations, SSE streaming)
- Three servers: port 3140 (API), 3141 (DM relay), 8080 (dashboard static)
- Campaign Dashboard HTML — Character, Quests, Events, NPCs, Spells, Inventory tabs
- Tool executor: `update_quest`, `update_npc`, `update_world`, `record_history`, `update_hp`, `start_combat`
- `campaign_state.json` as authoritative machine state
- `claude_chat_history.json` for full conversation persistence
- Map canvas with hex grid rendering
- NPC portrait cards with disposition colors
- Dice roller with history log
