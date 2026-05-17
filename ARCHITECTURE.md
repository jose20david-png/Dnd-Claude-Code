# Rurik Stormhammer Campaign System — Architecture Guide

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    SOLO D&D CAMPAIGN SYSTEM                     │
│                  (Claude AI Dungeon Master)                     │
└─────────────────────────────────────────────────────────────────┘

   ┌──────────────────┐                      ┌──────────────────┐
   │  Campaign.exe    │◄─────── Git Sync ───►│  GitHub Repo     │
   │  (Node.js app)   │                      │  + History       │
   └──────────────────┘                      └──────────────────┘
          │
     ┌────┴─────────────────┬─────────────────┐
     │                      │                 │
  Port 3140              Port 3141         Port 3000+
  (State API)        (DM Relay SSE)     (Dashboard HTTP)
     │                      │                 │
     ▼                      ▼                 ▼
┌─────────────┐      ┌─────────────┐  ┌──────────────────┐
│ Campaign    │      │  DM Relay   │  │  Web Browser     │
│ State API   │      │  (Agentic   │  │  ┌────────────┐  │
│ (CRUD ops) │      │   Claude)   │  │  │ Dashboard  │  │
└─────────────┘      └─────────────┘  │  │ HTML/JS    │  │
                                       │  └────────────┘  │
                                       └──────────────────┘
```

---

## Server Architecture (campaign.exe / launcher.js)

### Three HTTP Servers

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LAUNCHER.JS — THREE SERVERS                      │
└─────────────────────────────────────────────────────────────────────┘

1. CAMPAIGN API SERVER (Port 3140)
   ├─ GET  /api/state          → Return campaign_state.json
   └─ POST /api/state          → Save updated state
      (Used by dashboard for inventory, quest, NPC updates)

2. RELAY SERVER (Port 3141) — Main DM Loop
   ├─ GET  /api/chat/history   → Load chat history
   ├─ GET  /api/chat/clear     → Reset conversation
   └─ POST /api/chat           → [MAIN] Send prompt to Claude
      │
      └─→ AGENTIC LOOP (up to 6 iterations)
          ├─ Call Anthropic API (streaming)
          ├─ Parse SSE: text, tool calls, stop reason
          ├─ Execute tools (roll dice, update HP, etc)
          ├─ Add tool results to context
          └─ Loop if Claude called tools, else break
      │
      └─→ Collect all text from all turns
          ├─ If empty: Show error message to user
          └─ If has text: Save to history, persist to disk

3. DASHBOARD SERVER (Port 3000+)
   └─ GET  /*                  → Serve HTML, CSS, JS files
      (All frontend assets come from disk)
```

---

## DM Relay Server — The Agentic Loop

```
USER SENDS MESSAGE
       │
       ▼
   (Browser posts to /api/chat with {prompt: "..."})
       │
       ├─ Load chat history from JSON disk file
       ├─ Push user message to history
       └─ Build system prompt (state summary + campaign context)
       │
       ▼
   ╔═════════════════════════════════════════════════════════╗
   ║          AGENTIC LOOP (up to 6 iterations)             ║
   ║                                                          ║
   ║  Loop starts:                                          ║
   ║  • All messages (user + all prior assistant + tools)  ║
   ║  • Are sent to Anthropic API                          ║
   ║  • Stream back: text + tool calls                     ║
   ║                                                         ║
   ║  ITERATION OUTCOME:                                    ║
   ║  ┌─────────────────────────────────────────────┐      ║
   ║  │ Stop Reason = "end_turn" (no tools called) │      ║
   ║  │ → BREAK (done with this turn)              │      ║
   ║  ├─────────────────────────────────────────────┤      ║
   ║  │ Stop Reason = "tool_use" (tools called)    │      ║
   ║  │ → Execute each tool                        │      ║
   ║  │ → Add {role: 'user', content: toolResults} │      ║
   ║  │ → Continue loop (iteration N+1)            │      ║
   ║  ├─────────────────────────────────────────────┤      ║
   ║  │ HTTP 429 / 500 / 529 (API error)           │      ║
   ║  │ → Break, set apiError flag                 │      ║
   ║  │ → Show error to user                       │      ║
   ║  └─────────────────────────────────────────────┘      ║
   ║                                                         ║
   ║  Loop exits when:                                      ║
   ║  • stop_reason ≠ 'tool_use' (natural end)             ║
   ║  • API error occurs                                    ║
   ║  • 6 iterations completed (safety limit)              ║
   ╚═════════════════════════════════════════════════════════╝
       │
       ▼
   COLLECT FINAL TEXT
   (concatenate all text blocks from all assistant messages)
       │
       ├─ If text: Save to history, write to disk
       └─ If empty:
          ├─ API Error? Show "[DM connection issue: ...]"
          └─ No error? Try 1 fallback call ("please narrate")
             └─ Still empty? Show "[No narration this turn]"
       │
       ▼
   SEND TO BROWSER
   (SSE stream: text events, state updates, music changes, done)
```

---

## Tools: What Claude Can Call

```
┌─────────────────────────────────────────────────────────────────────┐
│                    11 TOOLS AVAILABLE TO CLAUDE                    │
└─────────────────────────────────────────────────────────────────────┘

MECHANICS (Immediate state changes):
  roll_dice(expression, purpose)       → "2d6+3" → {total, breakdown}
  update_hp(hp, reason)                → Set Rurik's current HP
  use_spell_slot(level, spell_name)    → Decrement spell slot
  use_channel_divinity(ability)        → Decrement channel divinity
  restore_resources(rest_type)         → Long/short rest reset

INVENTORY & QUESTS:
  add_inventory_item(name, qty, rarity)    → Add to Rurik's inventory
  remove_inventory_item(name, qty)         → Consume an item
  complete_quest_step(quest_id, step_id)   → Mark progress

NARRATIVE:
  append_history_log(event)            → Log significant event
  set_music_scene(scene)               → Switch background music
                                           (exploration|combat|rest|tavern|silence)

SESSION:
  end_session(summary, recap)          → End turn, write journal
                                           (calls Git commit + push)
```

**Tool Execution Flow:**
```
Claude calls: roll_dice("d20+3", "Perception check")
       │
       ├─ Server: Execute tool (rollDice function)
       ├─ Return: {rolled, purpose, result, total}
       ├─ If state_updated flag: Send SSE state_update event
       ├─ Continue loop: Add tool_result to messages
       └─ Continue agentic loop (iteration N+1)
```

---

## State Management: campaign_state.json

```
campaign_state.json (persisted to disk after every change):

{
  "campaign_id": "lost-mine-phandelver-witness-arc",
  
  "world": {
    "name": "Forgotten Realms — Phandelver Region",
    "current_location": "Old Marta's Cabin",
    "time": "Day 7 — Morning",
    "seal_integrity": 100,        ← Witness containment %
    "seal_status": "Stable"
  },
  
  "party": [
    {
      "id": "rurik",
      "name": "Rurik Stormhammer",
      "class": "Cleric (Storm Domain)",
      "level": 3,
      "hp": 27,
      "spell_slots": {
        "level_1": { "max": 4, "used": 1 },
        "level_2": { "max": 2, "used": 0 }
      },
      "channel_divinity": { "max": 1, "used": 0 },
      "inventory": [
        { "name": "Warhammer +1", "quantity": 1, "rarity": "uncommon" },
        { "name": "Holy Symbol", "quantity": 1, "rarity": "common" }
      ]
    }
  ],
  
  "quests": [
    {
      "id": "liberate_phandalin",
      "title": "Liberate Phandalin from the Redbrands",
      "status": "active",
      "steps": [
        { "step_id": "talk_wester", "description": "...", "completed": true },
        { "step_id": "rescue_silga", "description": "...", "completed": false }
      ]
    }
  ],
  
  "npcs": [ ... ],
  
  "history_log": [
    { "timestamp": "2026-05-17T12:34:56Z", "event": "Wester offered intelligence on Silga..." },
    { "timestamp": "...", "event": "Long rest — all resources restored." }
  ]
}
```

**Update Flow:**
```
Claude calls tool_name(input)
       │
       ├─ executeTool() reads campaign_state.json
       ├─ Modifies state
       ├─ saveState() writes back to disk (JSON serialized)
       ├─ Returns {success, state_updated: true, ...}
       │
       └─ If state_updated:
          └─ Server sends SSE event:
             {type: 'state_update', state: {...full state...}}
                │
                └─ Dashboard receives, calls applyStateUpdate()
                   ├─ Updates W object (UI globals)
                   └─ Calls updateHP(), updateSpellSlots(), etc.
```

---

## Server-to-Dashboard Communication (SSE)

```
                    HTTP GET → Upgrade to SSE Stream
                               │
                               ├─ {type: 'text', content: "DM narration..."}
                               │   (streamed as Claude speaks)
                               │
                               ├─ {type: 'state_update', state: {...}}
                               │   (when HP/slots/inventory change)
                               │
                               ├─ {type: 'music_scene', scene: 'combat'}
                               │   (when DM calls set_music_scene tool)
                               │
                               ├─ {type: 'error', error: "HTTP 429..."}
                               │   (on API or stream errors)
                               │
                               └─ {type: 'done', token_count: 1234, ...}
                                  (end of response, re-enable textarea)
```

---

## Dashboard Architecture (Campaign Dashboard HTML.html)

### Five Tabs

```
┌─────────────────────────────────────────────────────────────────┐
│ ◈ RURIK STORMHAMMER           Day 7 — Morning   [MUSIC] [STATUS]│
├─────────────────────────────────────────────────────────────────┤
│ MAP │ CHARACTER │ QUESTS │ EVENTS │ NPCs │ INVENTORY │ 🤖 CLAUDE│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                        [Active Tab Content]                    │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ [🎲 Quick-Roll Bar: PERCEPTION d20+3 | INSIGHT d20+5 | ...]    │
├─────────────────────────────────────────────────────────────────┤
│ [Type action or ask DM] [SEND]                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Claude Tab (Main Chat)

```
┌─────────────────────────────────────────────────────────┐
│ History (auto-scroll)                                   │
│                                                         │
│ USER: "I approach the guards cautiously"               │
│                                                         │
│ DM: "The two Redbrand soldiers notice you. The one     │
│     on the left reaches for his sword, eyes narrowing. │
│     Roll a Perception check."                          │
│     [**16** — 16 + 0 = 16]                             │
│                                                         │
│ USER: "I rolled Perception: total 18"                  │
│                                                         │
│ DM: (streaming...) "Your keen eye picks up the        │
│     lieutenant's hand on his sword hilt..."           │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ Input: [Type your action]        [Send] [Clear]        │
│ Model: claude-haiku-4-5          Tokens: 12,456        │
└─────────────────────────────────────────────────────────┘
```

### Character Tab

```
NAME: Rurik Stormhammer            LEVEL: 3    CLASS: Cleric

HP: 27 / 27  ████████████████████████ (100%)
AC: 18       Prof: +2

SPELL SLOTS:
  1st Level: ████░ (4/4)   [Toggle to use slots]
  2nd Level: ██░░░ (2/2)

CHANNEL DIVINITY: █ (1/1)

SKILLS:
  ✓ Perception (+3)   — Proficient
  ○ Insight (+2)
  ○ Medicine (+2)
  ○ Survival (+2)
  ... (10 skills total)

INVENTORY:
  • Warhammer +1 ×1
  • Holy Symbol ×1
  • Chain Mail ×1
  ... (10 items)
```

### Quick-Roll Bar

```
┌─────────────────────────────────────────────────────────┐
│ QUICK ROLL │ PERCEPTION │ INSIGHT │ INITIATIVE │ ATK │...
│            │   d20+3    │ d20+5   │   d20−1    │     │
│                                                         │
│ Click any button:                                       │
│ 1. Roll the dice (shows overlay with result)           │
│ 2. Auto-sends formatted message to DM                  │
│    "[Player rolled Perception: total 18 (15+3)]"       │
│ 3. Switches to Claude tab                              │
│ 4. If DM is mid-response (textarea disabled):          │
│    just shows the roll, doesn't interrupt              │
└─────────────────────────────────────────────────────────┘
```

---

## Data Flow: A Complete Turn

```
┌─────────────────────────────────────────────────────────────────┐
│                   COMPLETE MESSAGE FLOW                         │
└─────────────────────────────────────────────────────────────────┘

STEP 1: USER SENDS MESSAGE
┌────────────────────────────────────┐
│ Dashboard (Browser)                │
│  User types: "I cast Guiding Bolt" │
│  Clicks SEND or presses Enter       │
└────────────────────────────────────┘
            │
            └─ POST to http://localhost:3141/api/chat
               {prompt: "I cast Guiding Bolt"}

STEP 2: SERVER RECEIVES, LOADS CONTEXT
┌────────────────────────────────────┐
│ Launcher.js (campaign.exe)         │
│  1. Load history.json              │
│  2. Add user message to history    │
│  3. Load campaign_state.json       │
│  4. Build system prompt (state +   │
│     campaign context)              │
└────────────────────────────────────┘

STEP 3: AGENTIC LOOP BEGINS
┌─────────────────────────────────────────────────────────┐
│ Iteration 0:                                            │
│  • Call Anthropic API with all messages + system      │
│  • Claude responds with text + tool calls (e.g.)      │
│    - "roll_dice('d20+5', 'Guiding Bolt')"             │
│    - "use_spell_slot(1, 'Guiding Bolt')"              │
│  • Stop reason = 'tool_use' → continue loop           │
│                                                         │
│ Execute tools:                                         │
│  • Roll dice: get {total: 18, breakdown: "..."}      │
│  • Use spell slot: decrement, update state            │
│  • Send SSE state_update event                        │
│                                                         │
│ Iteration 1:                                           │
│  • Send tool results back to Claude                   │
│  • Claude writes narration: "The bolt streaks..."     │
│  • Stop reason = 'end_turn' → break                   │
└─────────────────────────────────────────────────────────┘

STEP 4: COLLECT TEXT, SAVE HISTORY
┌────────────────────────────────────┐
│ finalText = all assistant text     │
│ from all iterations                │
│                                    │
│ Save to history.json:              │
│  • Add user message                │
│  • Add assistant text              │
│  • Update token count              │
│  • Write to disk                   │
└────────────────────────────────────┘

STEP 5: STREAM TO BROWSER
┌────────────────────────────────────────────────────────┐
│ SSE Events (in order):                                 │
│  1. text: "The bolt streaks toward..."                │
│  2. text: "It blazes past the goblin's..."            │
│  3. state_update: {party: [{hp: 24, ...}], ...}       │
│  4. done: {token_count: 12456, model: "..."}          │
└────────────────────────────────────────────────────────┘
            │
            └─ Browser receives, renders
               ├─ Appends text to chat
               ├─ Updates HP bar
               └─ Re-enables textarea

STEP 6: DASHBOARD UPDATES
┌──────────────────────────────────────┐
│ JavaScript handlers:                 │
│  • event.type === 'text'             │
│    → append to chat, scroll          │
│  • event.type === 'state_update'     │
│    → call applyStateUpdate()         │
│    → updateHP(), updateSpellSlots()  │
│  • event.type === 'done'             │
│    → enable textarea, show token     │
│    → renderClaudeHistory()           │
└──────────────────────────────────────┘
```

---

## Error Handling & Recovery

```
┌─────────────────────────────────────────────────────────────────┐
│             WHAT HAPPENS WHEN THINGS BREAK                      │
└─────────────────────────────────────────────────────────────────┘

SCENARIO 1: API Returns HTTP 429 (Rate Limited)
├─ makeAPICall detects statusCode !== 200
├─ Parses JSON body: {error: {type: "rate_limit_error", message: "..."}}
├─ Rejects with: "HTTP 429 — rate_limit_error: Requests exceeded"
├─ Server catches in try/catch
├─ Logs: "✗ Loop 0 API call failed: HTTP 429..."
├─ Returns: {apiError: "HTTP 429..."}
├─ Saves error message to history as assistant response
├─ Sends to browser: {type: 'text', content: "⚠️ DM connection issue: HTTP 429..."}
└─ User sees: "Your message was kept. Try again in 10–20 seconds."

SCENARIO 2: Claude Calls Tools But Writes No Narration
├─ Loop 0: text="", tools=[roll_dice], stop=tool_use
├─ Execute tool, continue
├─ Loop 1: text="", tools=[], stop=end_turn
├─ Break loop, finalText is empty
├─ Trigger fallback: "Please narrate what happens..."
├─ Loop 2: Still empty (Claude is stuck)
├─ Save system message: "⚠️ No DM narration this turn"
└─ User sees: "Try rephrasing your message or send 'continue'"

SCENARIO 3: Network Drops Mid-Stream
├─ apiRes.on('error') fires
├─ streamErr captured, loop breaks
├─ apiError returned
├─ Same as Scenario 1: error visible to user

SCENARIO 4: Dashboard Loses Connection
├─ fetch() fails (network timeout)
├─ Browser catches in catch block
├─ Shows: "Failed to send message. Is the server running?"
└─ User can retry

ALWAYS: Console shows diagnostics
  ━━━ Chat request — history=N msgs, est tokens=X ━━━
  ▶ Agentic loop start — N messages in context
  ⟳ Loop 0: text=123c, tools=2 [roll_dice,use_spell_slot], stop=tool_use
  ⟳ Loop 1: text=456c, tools=0, stop=end_turn
  ▶ Agentic loop end — totalTokens=579
  ✓ Turn saved — 579 chars of narration
```

---

## File Persistence

```
Desktop/Claude/ (APP_DIR)
│
├─ campaign.exe                    ← Standalone executable (pkg bundled)
│
├─ launcher.js                     ← Server source (required on disk)
├─ Campaign Dashboard HTML.html    ← Frontend source (required on disk)
│
├─ campaign_state.json             ← STATE (read/write every turn)
├─ claude_chat_history.json        ← HISTORY (read/write every turn)
│
├─ Campaign Context full.md        ← Manual session notes (sync after end_session)
├─ journal.md                       ← Session recaps (append after end_session)
│
└─ scripts/
   └─ (helper scripts, if any)

Git Operations:
  1. After every state/history change: auto-save
  2. After end_session:
     • Update Campaign Context full.md
     • Append to journal.md
     • git add -A
     • git commit -m "Session end: ..."
     • git push
```

---

## Features Overview

| Feature | Status | How It Works |
|---------|--------|-------------|
| **Agentic DM** | ✅ | Claude loops up to 6 times, calling tools, receiving results, narrating |
| **Dice Rolls** | ✅ | Player can roll inline in chat or use Quick-Roll buttons; auto-sent to DM |
| **HP Tracking** | ✅ | `update_hp` tool changes state, SSE updates dashboard live |
| **Spell Slots** | ✅ | `use_spell_slot` decrements, toggles in Character tab |
| **Inventory** | ✅ | Add/remove/use items, persists in state |
| **Quests** | ✅ | Track quest steps, mark complete via tool |
| **Background Music** | ✅ | Web Audio API; 5 scenes (exploration, combat, rest, tavern, silence) |
| **Session Save** | ✅ | `end_session` writes journal, commits/pushes to GitHub |
| **Error Visibility** | ✅ | API errors, timeouts, rate limits all shown in chat |
| **History Persistence** | ✅ | All messages saved to disk, survives restarts |
| **Auto-Save** | ✅ | Every state change committed to git |

---

## System Startup Sequence

```
1. User runs campaign.exe
   ├─ Node.js app starts (launcher.js)
   ├─ Loads .env (API_KEY)
   ├─ Loads campaign_state.json (or creates fresh)
   ├─ Loads claude_chat_history.json (or empty)
   └─ Starts three HTTP servers (ports 3140, 3141, 3000+)

2. User opens http://localhost:3000 in browser
   ├─ Downloads Campaign Dashboard HTML.html
   ├─ Loads CSS, inline JavaScript
   ├─ Initializes W object (game globals)
   ├─ Shows current state (HP, spells, day/location)
   ├─ Loads chat history from /api/chat/history
   └─ Renders previous messages

3. User sends first message
   ├─ POST /api/chat with prompt
   ├─ Server runs agentic loop
   ├─ Streams SSE events
   └─ User sees DM narration appear live

4. User clicks Quick-Roll or Character Sheet dice
   ├─ Roll happens locally
   ├─ Auto-sends to /api/chat
   └─ DM responds
```

---

## Debugging Checklist

When something goes wrong:

1. **Check the command line** — look for these diagnostic lines:
   ```
   ✓ Turn saved — N chars of narration
   ✗ Empty turn surfaced to user: (reason)
   ✗ Loop 0 API call failed: HTTP 429...
   ⟳ Loop 0: text=0c, tools=2, stop=tool_use
   ```

2. **Check the chat** — the user always sees an error if one occurred

3. **Check browser console** (F12) — JavaScript errors, network failures

4. **Check git status** — is state being saved?
   ```
   git status
   git log --oneline -5
   ```

5. **Restart campaign.exe** — fresh server state, reload history from disk

6. **Check API_KEY** in .env — is it valid? Try the Anthropic API directly.

---

## Command Reference

Start the server:
```bash
campaign.exe
```

Open the dashboard:
```
http://localhost:3000
```

View state:
```bash
cat campaign_state.json
```

View chat history:
```bash
cat claude_chat_history.json
```

Check git logs:
```bash
git log --oneline -20
```

Clear chat history:
```bash
curl http://localhost:3141/api/chat/clear
```

---

**Last Updated:** 2026-05-17  
**Model:** Claude Haiku 4.5 + Sonnet 4.7  
**Campaign:** Lost Mine of Phandelver — The Witness Arc
