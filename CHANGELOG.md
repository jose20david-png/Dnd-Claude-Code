# Campaign Launcher — Changelog

---

## [2026-05-23] — Build 16 (current)

### API Migration — Anthropic → Mistral AI
- **Model changed** to `open-mistral-nemo` (Mistral free tier, 12B, function-calling capable).
- **Token rate limit** raised to `40,000 TPM` (Mistral free tier vs. Anthropic Tier 1 ~10K).
- **`.env` key** changed from `ANTHROPIC_API_KEY` to `MISTRAL_API_KEY`.
- **`makeAPICall()`** rewritten for Mistral REST API (`api.mistral.ai/v1/chat/completions`, `Authorization: Bearer` header, no `anthropic-version` header).
- **`streamAgenticLoop()`** rewritten for OpenAI-compatible SSE format:
  - System prompt sent as first message in array (`{role:'system', content:...}`), not a top-level field.
  - SSE parsed from `choices[0].delta.content` / `choices[0].delta.tool_calls[].index`.
  - Tool results sent as individual `{role:'tool', tool_call_id, content}` messages (not batched user-turn blocks).
  - Stream terminates on `data: [DONE]` line.
  - Tool calls accumulated by `index` to handle parallel/chunked streaming.
  - Narration nudge message injected after tool execution.
- **`MISTRAL_TOOLS`** array built from TOOLS using `{type:'function', function:{name,description,parameters}}` schema (OpenAI tool format).
- **Startup error message** updated to reference `MISTRAL_API_KEY`.
- **Console label** updated: `Claude DM → Mistral DM`.
- **Prompt caching** (`TOOLS_CACHED`, `cache_control`) removed — Mistral does not support Anthropic's caching headers.

---

## [2026-05-23] — Build 15

### Performance — Token Rate Fix
- **Prompt caching** — system prompt and last tool definition tagged with `cache_control: {type:'ephemeral'}`. Cache hits reduce input token cost by ~75%.
- **History budget** reduced from 4500 → 2500 tokens per call.
- **Recent events** trimmed from last 5 → last 3 per system prompt.

---

## [2026-05-23] — Build 14

### Performance
- **`TOOLS` token count cached at startup** — `getToolsJson()` serializes the 14 tool definitions once; the agentic loop no longer calls `JSON.stringify(TOOLS)` on every iteration (6× per user turn).
- **`RECENT EVENTS:` label restored** in system prompt (was accidentally dropped during an edit).

### Engine — New Tools
- **`set_weather`** — sets `world.weather` (condition + flavour text), logs to history, emits `weather_update` SSE event to dashboard. 10 weather conditions: clear, cloudy, overcast, light_rain, heavy_rain, thunderstorm, fog, snow, blizzard, heatwave, magical.
- **`roll_encounter`** — rolls from terrain-specific encounter tables (road, forest, dungeon, mountain, coastal, urban, plains, swamp, underdark). Returns encounter description and difficulty. Logs to history.

### Engine — API
- **`GET /api/notes`** — returns `notes.md` content (DM scratchpad).
- **`POST /api/notes`** — writes `notes.md` to disk (auto-save from dashboard).

### Dashboard — New Features
- **Session timer** — `MM:SS` / `H:MM:SS` elapsed display in header, ticks every second from page load.
- **📝 Notes tab** — DM scratchpad textarea, auto-saves to `notes.md` via debounced POST (1 s delay). Shows "Saved" flash on success. Persists across sessions.
- **Export Journal button** — in Notes tab header. Downloads `journal.md` as `{CharName}-journal.md` via browser download.
- **Weather overlay on map** — `map-weather-label` shows weather icon + condition name (top-right of map canvas). Updates on `weather_update` SSE event and `state_update`. Loaded from initial state on page load.
- **Spell search** — search input above spell compendium filters by name, school, and description in real-time. Shows "No spells matching X" when empty.

### Dashboard — Wiring
- **`weather_update` SSE event** wired in stream parser → `handleWeatherUpdate()`.
- **`applyStateUpdate`** now calls `updateWeatherOverlay()` on every state sync.

---

## [2026-05-23] — Build 13

### Engine — Architecture & Safety
- **State mutex** — promise-based async lock queue prevents interleaved concurrent writes to `campaign_state.json`.
- **State cache** — `_stateCache` keeps the last loaded state in memory. Tool calls in the same agentic loop skip the disk read; cache invalidated on `loadSave()` / `resetToBrandNew()`.
- **State validation** — `validateState()` checks type, party array presence, HP bounds (≥0, ≤hp_max+50), and spell slot bounds before every write. POST /api/state returns 400 on bad data.
- **Saves pruning** — `pruneSaves()` keeps the 30 most-recent saves by mtime; called on every auto-save. Prevents unbounded `saves/` growth.

### Engine — New Mechanics Tools
- **`death_save`** — full 5e death saving throw state machine: tracks successes/failures, nat20 regains 1 HP, nat1 counts as 2 failures, auto-stabilizes at 3 successes, auto-sets `status:'dead'` at 3 failures.
- **`skill_check`** — records DC vs roll result in `history_log`; DM narrates, engine doesn't.
- **`set_concentration`** — drops any existing "Concentrating on X" condition before setting the new one; enforces one-concentration rule automatically.
- **`award_xp`** — uses standard 5e XP threshold table (levels 1–20); auto-levels character (updates proficiency bonus, hit dice), emits `level_up` SSE event to dashboard.

### Dashboard — UX & Polish
- **Level-up toast** — `level_up` SSE event triggers a full-screen animated "★ LEVEL UP ★" overlay with sound. Dismisses after 3.5 s.
- **SSE / server health check** — `checkServerHealth()` polls `/api/state` every 15 s; reconnects state and updates DM status indicator when server comes back online.
- **Music scene indicator** — `updateMusicUI()` now correctly targets the existing `music-label` element; shows named scene (♪ Explore / ⚔ Combat / 🌙 Rest / 🍺 Tavern) when music is on.
- **Tab scroll preservation** — `switchTab` wrapper saves and restores each panel's scroll position so returning to a tab picks up where you left off.
- **Clipboard copy on dice overlay** — new ⎘ button copies the last roll result (`Label: total (breakdown)`) to clipboard; button flashes ✓ on success.
- **Claude tab label** — tab button now shows `🤖 <CharFirstName>` instead of `🤖 DM`; updates on state load and every `state_update` event.

### Dashboard — Wiring
- **`level_up` SSE event** now handled in stream parser (calls `handleLevelUp()`).
- **`music_scene` SSE event** now calls `updateMusicUI()` to refresh the label immediately on scene change.

---

## [2026-05-23] — Build 12

### Bugs Fixed
1. **`complete_quest_step` now uses fuzzy matching** on quest title + step description — no more needing exact internal IDs. Returns actionable error showing available options if nothing matches.
2. **`update_npc` notes now append** (` | ` separator) instead of overwriting. DM can layer new info without losing history.
3. **`add_npc` deduplication** — if an NPC with the same name/id already exists, updates it instead of creating a duplicate entry.
4. **`end_session` git steps separated** — journal write, context sync, commit, and push each handle their own errors. Missing remote skips push gracefully instead of crashing the whole tool.
5. **Proficiency bonus formula corrected** everywhere — was `Math.ceil(1+level/4)` (wrong). Now uses correct 5e table: +2 at 1–4, +3 at 5–8, +4 at 9–12, +5 at 13–16, +6 at 17–20.
6. **`passive_perception` operator precedence fixed** in `create_character`.
7. **Warlock short rest** — `restore_resources` and dashboard `shortRest()` now correctly restore all Warlock pact slots on short rest.
8. **`longRest()` stale W** — fixed `W.charHpMax` to read from `p.hp_max` (not `p.hp`). All W values now synced from state, not from stale display variables.
9. **`showDMRoll` pip parsing** — now extracts die values from `[n, n, …]` bracket groups instead of splitting on `+`. Handles complex expressions like `2d6+1d4+3`.
10. **`renderCharacterTab` undefined stat guard** — `_mod()` and `_modVal()` now parseInt their input, defaulting to 10 for any undefined/null stat.
11. **Combat HP persisted to state** — `damageInCombat()` and `healInCombat()` now POST the updated player HP to `/api/state`. HP survives page refresh mid-combat.
12. **Death prompt at 0 HP** — combat tracker shows alert with death saving throw instructions when player hits 0.
13. **SSE 90-second timeout** — `makeAPICall` now sets a 90s timeout on the HTTP request so the SSE connection can't hang forever if Anthropic stops responding.
14. **Token window pruning** — `pruneTokenUsage()` uses shift() correctly; array can't grow unbounded. Also added hourly on-disk history pruning (cap 500 messages).
15. **Crash save** — `uncaughtException`, `SIGTERM`, and `SIGINT` all call `emergencySave()` before exiting.

### New Engine Features
- **`add_condition` / `remove_condition` tools** — track Poisoned, Frightened, Prone, Concentrating, etc. Conditions shown in character sheet and included in system prompt.
- **Advantage/Disadvantage in `roll_dice`** — append `"advantage"` or `"disadvantage"` to any d20 expression. Rolls 2d20, keeps highest/lowest, logs both dice in breakdown.
- **Hit Dice tracking** — `create_character` sets `hit_dice_total`/`hit_dice_used`. Long rest recovers half. `restore_resources` schema exposes `hit_dice_spent` for short rest healing.
- **Death saving throw guidance** — system prompt now tells DM to initiate death saves at 0 HP.

### Dashboard Improvements
- **NPC search + disposition filter** — search box + dropdown on NPCs tab. Filters update live on input.
- **`→ DM` dice format fixed** — now sends `[Player rolled X: total N (breakdown)] Please narrate the outcome.` so Claude narrates instead of re-rolling.
- **DM status indicator** — `● Connected / ● Thinking… / ● Disconnected` in Claude tab header.
- **Journal tab loads once** — `_journalLoaded` guard prevents redundant fetches on every tab click. Refresh button explicitly resets it.
- **Journal renders Markdown** — headings, bold, italic now display as HTML instead of raw `##`/`**`.
- **`longRest()` / `shortRest()`** sync W from state (not stale display variables).
- **`buildQuickRollBar` weapon detection** — fixed regex, magic bonus parsing, finesse detection, unarmed fallback, correct per-class spell attack stat.
- **`_profBonus()` helper** added to dashboard JS — used in `renderCharacterTab` and quick-roll bar.

### Performance
- **System prompt ~500 tokens lighter** — `history_log` now truncated to last 5 events in the prompt (was sending the entire log every call).
- **System prompt shows conditions** — `Conditions: none/Poisoned/…` added to character block.
- **System prompt shows Hit Dice** — `3/3 HD` shown if tracked.

---

## [2026-05-23] — Build 11

### Engine — New DM Tools
- **`add_npc`**: Add any NPC to the world tracker mid-session — name, role, disposition, notes, location auto-set to current.
- **`update_npc`**: Fuzzy name match; update disposition, notes, or location after events change the relationship.
- **`add_quest`**: Create a quest with step objects from a plain string array; auto-generates stable `step_id`s for `complete_quest_step`.
- **`update_location`**: Move character to new location, advance time, optionally update lore summary or switch dashboard map via `map_id`.

### Engine — Map Fix
- **`world.map_id`** field added to `BLANK_STATE` and `create_character` world object (defaults `null`).
- `update_location` tool accepts optional `map_id` parameter to explicitly switch the dashboard map.
- **Dead code**: `RURIK_STATE` (~50 lines) removed from launcher.js — no longer referenced anywhere.

### Dashboard — Fixes & Features
- **Map fallback bug fixed**: `currentMap` now respects `world.map_id` first; falls back to `campaign_id` match; no longer incorrectly loads Phandelver map for unrelated campaigns.
- **DM dice roll display**: When the DM's `roll_dice` tool fires, a `dice_roll` SSE event is emitted and the dashboard shows the result in the dice overlay with nat20/nat1 sounds. Function `showDMRoll(event)` added.
- **Journal tab added**: New 📖 Journal tab fetches `GET /api/journal` and renders `journal.md` in a monospaced scrollable view with a Refresh button.
- **`/api/journal` endpoint**: Returns contents of `journal.md` as JSON `{content}`. Returns empty string if file doesn't exist yet.
- **Dead code removed**: `drawRurikPortrait()` and `drawAllNpcPortraits()` (with hardcoded NPC KEY_MAP) removed — replaced by description-driven portrait system from Build 8.

---

## [2026-05-23] — Build 10

### Engine — Full Generic Refactor
- **`loadState()` fallback changed** from `RURIK_STATE` to `BLANK_STATE`. Any machine without a `campaign_state.json` now starts at character creation, not Rurik's campaign.
- **`updateContextFile()`** completely rewritten. Generic for any character. Uses `hp_max` dynamically. If the campaign has a hand-authored context MD file, patches it. Otherwise creates a `{campaign-id}-context.md` auto-file.
- **`end_session` journal** now uses character name from state for the file header. No more "Rurik Stormhammer — Campaign Journal".
- **Banner** reads `world.name` from state instead of hardcoded "Lost Mine of Phandelver · The Witness Arc".
- **Stat summary** uses `hp_max` from state (not hardcoded `/27`).
- **Tool descriptions** genericized ("Update the character's HP" not "Update Rurik's HP").

### Dashboard — Full Generic Refactor
- **Static Rurik HTML wiped** from all four tabs (Character, Quests, Events, NPCs). Replaced with empty containers — render functions do all the work.
- **Threat board replaced** with generic Campaign Status panel: World, Location, Time. Seal integrity row only appears when a campaign actually tracks it (< 100 or custom status set).
- **`applyStateUpdate()`** fully generic — syncs all spell levels (1–9), reads `hp_max`, updates header, status panel, location label, and quick-roll bar.
- **`updateSpellSlots()`** simplified — pure loop over all 9 levels from `campaignState`, no legacy W-object fallback.
- **`toggleSlot()`** and **`longRest()`** stripped of all level_1/level_2 special casing. Operate on any slot level.
- **`startCombat()`** reads player name, ID, and HP from `campaignState` — no more hardcoded "Rurik Stormhammer" / `maxHP: 27`.
- **`damageInCombat()` / `healInCombat()`** use `combatant.isPlayer` flag instead of checking for the ID `'rurik'`.
- **Quick-roll bar** is now built dynamically from the loaded character's stats, proficiencies, inventory, and class. Shows Initiative, top 3 skill rolls, proficient saving throws, weapon attack/damage, and spell attack — all computed live. No hardcoded buttons.
- **Map** only loads the Phandelver tiles when the `campaign_id` matches a known GRIDS key. Any other campaign shows the generic placeholder.

---

## [2026-05-23] — Build 9

### New Features — New Campaign Flow
- **`create_character` DM tool**: after the character creation conversation the DM calls this once with the full stat block. It auto-computes spell slots from class + level (full caster / half caster / warlock tables), sets `campaign_id` from the character's name, writes `campaign_state.json`, and immediately saves a named file to `saves/`. The dashboard reloads and the full character sheet populates.
- **Guided character creation system prompt**: new-campaign mode now gives the DM a strict 9-step script — setting → class → race → background → ability score rolls (via `roll_dice`) → spells → equipment → name/backstory → `create_character`. Each step is capped at 3-5 lines so creation feels snappy.
- **Richer welcome card**: replaces the minimal "DM is waiting" message with a proper onboarding card explaining how creation works, what each dashboard tab does, and example first messages.
- **Map location label**: a `📍 Location · Time` overlay appears in the top-left corner of the map canvas whenever a real campaign is loaded. Updates live as the DM changes location.

### Fixes
- `update_hp` now clamps to `party[0].hp_max` (not hardcoded 27). Works for any character.
- `restore_resources` long rest now restores to `hp_max` (not hardcoded 27).
- `buildSystemPrompt` ongoing-campaign section is now fully generic — reads character name, class, AC, HP max from state. No hardcoded Rurik references.
- Key-item filter in system prompt is now pattern-matched (weapons/armor/foci/potions) instead of a hardcoded name list.

---

## [2026-05-21] — Build 8

### New Features
- **Description-driven character portraits** — `parsePortraitFeatures()` scans the character's `description` + `conditions` + `class` for keywords (hair color, silver/gold streaks, beard, spectacles, scar, blind, robe/armor/cloak, ethereal) and builds a feature object. `drawPortrait()` paints from that feature set at any size.
- **Kél's portrait now reflects narrative**: dark hair with silver streaks, completely grey blind eyes, wizard robe, fair skin — all generated from the Description section of `Fabrial_Hunt_Import.md`.
- **NPC portraits — fully dynamic**: every NPC card in the NPCs tab now gets a 24×30 procedural portrait built from `npc.notes` + `npc.role`. No hardcoded keys per character. Mira's gold-threaded hair, Thorin's red braided beard, Syl's ethereal shimmer, Pip's spectacles, the Elder Monk's robes — all derived from their narrative descriptions.
- Removed the legacy `drawAllNpcPortraits()` / `drawRurikPortrait()` calls from page init. Portraits are now drawn inside `renderCharacterTab()` and `renderNpcsTab()` from `campaign_state.json`.

---

## [2026-05-21] — Build 7

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
