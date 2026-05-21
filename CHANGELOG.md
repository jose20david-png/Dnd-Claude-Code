# Campaign Launcher — Changelog

---

## [2026-05-21] — Build 4 (current)

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
