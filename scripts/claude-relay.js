#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const PORT = 3141;
const MODEL = 'claude-haiku-4-5';
const REPO_PATH = path.join(__dirname, '..');
const CHAT_HISTORY_PATH = path.join(REPO_PATH, 'claude_chat_history.json');
const CAMPAIGN_STATE_PATH = path.join(REPO_PATH, 'campaign_state.json');
const CONTEXT_PATH = path.join(REPO_PATH, 'Campaign Context full.md');
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── API KEY ────────────────────────────────────────────────────────────────
let API_KEY = '';
try {
  const envContent = fs.readFileSync(path.join(REPO_PATH, '.env'), 'utf8');
  const match = envContent.match(/ANTHROPIC_API_KEY=(.+)/);
  if (match) API_KEY = match[1].trim();
} catch (e) {}

if (!API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY not found in .env file');
  process.exit(1);
}

// ─── CAMPAIGN STATE ─────────────────────────────────────────────────────────
function loadCampaignState() {
  try {
    if (fs.existsSync(CAMPAIGN_STATE_PATH))
      return JSON.parse(fs.readFileSync(CAMPAIGN_STATE_PATH, 'utf8'));
  } catch (e) { console.warn('⚠️  Could not load campaign state:', e.message); }
  return null;
}

function saveCampaignState(state) {
  fs.writeFileSync(CAMPAIGN_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ─── CONTEXT FILE SYNC ──────────────────────────────────────────────────────
function updateContextFile(state) {
  if (!state) return;
  try {
    if (!fs.existsSync(CONTEXT_PATH)) return;
    let content = fs.readFileSync(CONTEXT_PATH, 'utf8');

    const rurik = state.party[0];
    const world = state.world;
    const now = new Date().toISOString().slice(0, 10);

    // Format spell slots
    const slotNames = { level_1: '1st', level_2: '2nd', level_3: '3rd', level_4: '4th', level_5: '5th' };
    const slotParts = Object.entries(rurik.spell_slots)
      .filter(([, v]) => v.max > 0)
      .map(([k, v]) => `${v.max - v.used}× ${slotNames[k]}`);
    const allFull = Object.entries(rurik.spell_slots)
      .filter(([, v]) => v.max > 0)
      .every(([, v]) => v.used === 0);
    const slotsDisplay = slotParts.length
      ? slotParts.join(', ') + (allFull ? ' (full)' : '')
      : 'none';

    // Format HP
    const cd = rurik.channel_divinity;
    const cdStr = `${cd.max - cd.used} / ${cd.max} available`;
    const hpStatus = rurik.hp === 27 ? 'full — long rest complete'
      : rurik.hp >= 20 ? 'lightly wounded'
      : rurik.hp >= 10 ? 'wounded'
      : 'critical';
    const hpStr = `${rurik.hp} / 27 (${hpStatus})`;

    // Build replacement SESSION STATE block
    const newStateBlock = `## SESSION STATE — ${world.time}

| Field | Value |
|---|---|
| Location | ${world.current_location} |
| HP | ${hpStr} |
| Spell Slots | ${slotsDisplay} |
| Channel Divinity | ${cdStr} |`;

    // Replace SESSION STATE section (up to next ---)
    content = content.replace(/## SESSION STATE[\s\S]*?(?=\n---\n)/, newStateBlock);

    // Update last-updated date in header
    content = content.replace(/\*Last updated: \d{4}-\d{2}-\d{2}/, `*Last updated: ${now}`);

    // Append recent session events as a SESSION NOTES block (if not present, add before CHARACTER QUICK REFERENCE)
    const recentEvents = state.history_log
      .filter(e => e.timestamp > (state._last_context_sync || ''))
      .slice(-8)
      .map(e => `- ${e.event}`)
      .join('\n');

    if (recentEvents) {
      const notesBlock = `\n## SESSION NOTES (auto-generated)\n\n${recentEvents}\n`;
      if (content.includes('## SESSION NOTES (auto-generated)')) {
        content = content.replace(/## SESSION NOTES \(auto-generated\)[\s\S]*?(?=\n## |$)/, notesBlock.trim() + '\n');
      } else {
        content = content.replace('## CHARACTER QUICK REFERENCE', notesBlock + '\n## CHARACTER QUICK REFERENCE');
      }
    }

    fs.writeFileSync(CONTEXT_PATH, content, 'utf8');

    // Record sync timestamp in state
    state._last_context_sync = new Date().toISOString();
    saveCampaignState(state);

    console.log('✓ Campaign Context full.md updated');
  } catch (e) {
    console.error('⚠️  Failed to update context file:', e.message);
  }
}

// ─── AUTO-SAVE ───────────────────────────────────────────────────────────────
function autoSave() {
  try {
    const status = execSync('git status --porcelain', { cwd: REPO_PATH, stdio: 'pipe' }).toString().trim();
    if (!status) return; // nothing changed
    execSync('git add campaign_state.json claude_chat_history.json', { cwd: REPO_PATH, stdio: 'pipe' });
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    execSync(`git commit -m "Auto-save: ${ts}"`, { cwd: REPO_PATH, stdio: 'pipe' });
    console.log(`✓ Auto-saved at ${ts} (local commit, not pushed)`);
  } catch (e) {
    const msg = e.stdout ? e.stdout.toString() : e.message;
    if (!msg.includes('nothing to commit')) {
      console.warn('⚠️  Auto-save skipped:', msg.slice(0, 100));
    }
  }
}

// ─── CHAT HISTORY ───────────────────────────────────────────────────────────
function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_HISTORY_PATH))
      return JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH, 'utf8'));
  } catch (e) {}
  return { messages: [], created_at: new Date().toISOString(), token_count: 0, model: MODEL };
}

function saveChatHistory(history) {
  try {
    fs.writeFileSync(CHAT_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) { console.error('❌ Failed to save chat history:', e.message); }
}

function estimateTokens(text) { return Math.ceil(text.length / 4); }

// ─── DICE ROLLER ────────────────────────────────────────────────────────────
function rollDice(expression) {
  const match = expression.match(/(\d+)d(\d+)([+-]\d+)?/i);
  if (!match) return { total: 0, breakdown: `Invalid: ${expression}` };
  const numDice = parseInt(match[1]);
  const dieSize = parseInt(match[2]);
  const modifier = parseInt(match[3] || '0');
  const rolls = Array.from({ length: numDice }, () => Math.floor(Math.random() * dieSize) + 1);
  const rollSum = rolls.reduce((a, b) => a + b, 0);
  const total = rollSum + modifier;
  const breakdown = modifier !== 0
    ? `[${rolls.join(', ')}]${modifier >= 0 ? '+' : ''}${modifier} = **${total}**`
    : `[${rolls.join(', ')}] = **${total}**`;
  return { total, rolls, modifier, breakdown };
}

// ─── TOOL DEFINITIONS ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'roll_dice',
    description: 'Roll dice for any D&D check — attacks, damage, saving throws, skill checks, etc. ALWAYS use this tool for every dice roll instead of describing a number.',
    input_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Dice expression e.g. "1d20+5", "2d6+3", "1d8"' },
        purpose: { type: 'string', description: 'What this roll is for e.g. "attack roll vs goblin", "Healing Word restore HP"' }
      },
      required: ['expression', 'purpose']
    }
  },
  {
    name: 'update_hp',
    description: "Update Rurik's current HP after damage or healing. Call this whenever HP changes.",
    input_schema: {
      type: 'object',
      properties: {
        hp: { type: 'number', description: 'New current HP (clamp to 0–27)' },
        reason: { type: 'string', description: 'Why HP changed e.g. "Took 7 piercing damage from Redbrand crossbow"' }
      },
      required: ['hp', 'reason']
    }
  },
  {
    name: 'use_spell_slot',
    description: "Spend one of Rurik's spell slots. Call this every time a leveled spell is cast.",
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Slot level spent (1 or 2)' },
        spell_name: { type: 'string', description: 'Spell being cast' }
      },
      required: ['level', 'spell_name']
    }
  },
  {
    name: 'use_channel_divinity',
    description: "Spend Rurik's Channel Divinity charge.",
    input_schema: {
      type: 'object',
      properties: {
        ability: { type: 'string', description: 'Which Channel Divinity ability was used' }
      },
      required: ['ability']
    }
  },
  {
    name: 'restore_resources',
    description: "Restore Rurik's spell slots and/or channel divinity after a rest.",
    input_schema: {
      type: 'object',
      properties: {
        rest_type: { type: 'string', enum: ['long_rest', 'short_rest'], description: 'long_rest restores all slots and CD; short_rest restores CD only' }
      },
      required: ['rest_type']
    }
  },
  {
    name: 'add_inventory_item',
    description: "Add an item to Rurik's inventory.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        quantity: { type: 'number' },
        rarity: { type: 'string', enum: ['common', 'uncommon', 'rare', 'very rare', 'legendary'] }
      },
      required: ['name', 'quantity', 'rarity']
    }
  },
  {
    name: 'remove_inventory_item',
    description: "Remove or consume an item from Rurik's inventory.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact item name as it appears in inventory' },
        quantity: { type: 'number', description: 'How many to consume/remove' }
      },
      required: ['name', 'quantity']
    }
  },
  {
    name: 'complete_quest_step',
    description: 'Mark a quest step as completed when the party accomplishes it.',
    input_schema: {
      type: 'object',
      properties: {
        quest_id: { type: 'string', description: 'The quest id field from campaign state' },
        step_id: { type: 'string', description: 'The step_id field within that quest' }
      },
      required: ['quest_id', 'step_id']
    }
  },
  {
    name: 'append_history_log',
    description: 'Record a significant narrative event in the campaign history log. Call after major story beats.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'One-sentence description of what happened' }
      },
      required: ['event']
    }
  },
  {
    name: 'end_session',
    description: 'End the play session: commits all state changes and pushes to GitHub. Call when the player says they are done for today.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of key events this session for the git commit message' }
      },
      required: ['summary']
    }
  }
];

// ─── TOOL EXECUTOR ──────────────────────────────────────────────────────────
function executeTool(name, input) {
  const state = loadCampaignState();

  switch (name) {

    case 'roll_dice': {
      const result = rollDice(input.expression);
      return {
        rolled: input.expression,
        purpose: input.purpose,
        result: result.breakdown,
        total: result.total
      };
    }

    case 'update_hp': {
      if (!state) return { error: 'No campaign state found' };
      const clamped = Math.max(0, Math.min(27, Math.round(input.hp)));
      state.party[0].hp = clamped;
      state.history_log.push({ timestamp: new Date().toISOString(), event: input.reason });
      saveCampaignState(state);
      return { success: true, hp: clamped, max_hp: 27, state_updated: true };
    }

    case 'use_spell_slot': {
      if (!state) return { error: 'No campaign state found' };
      const slots = state.party[0].spell_slots;
      const key = `level_${input.level}`;
      if (!slots[key]) return { error: `No level ${input.level} slots defined` };
      if (slots[key].used >= slots[key].max) return { error: `No level ${input.level} spell slots remaining` };
      slots[key].used += 1;
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Cast ${input.spell_name} (Level ${input.level} slot). Slots remaining: ${slots[key].max - slots[key].used}/${slots[key].max}` });
      saveCampaignState(state);
      return { success: true, remaining: slots[key].max - slots[key].used, max: slots[key].max, state_updated: true };
    }

    case 'use_channel_divinity': {
      if (!state) return { error: 'No campaign state found' };
      const cd = state.party[0].channel_divinity;
      if (cd.used >= cd.max) return { error: 'No Channel Divinity uses remaining' };
      cd.used += 1;
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Used Channel Divinity: ${input.ability}` });
      saveCampaignState(state);
      return { success: true, remaining: cd.max - cd.used, state_updated: true };
    }

    case 'restore_resources': {
      if (!state) return { error: 'No campaign state found' };
      const rurik = state.party[0];
      if (input.rest_type === 'long_rest') {
        for (const key of Object.keys(rurik.spell_slots)) rurik.spell_slots[key].used = 0;
        rurik.channel_divinity.used = 0;
        rurik.hp = 27;
        state.history_log.push({ timestamp: new Date().toISOString(), event: 'Long rest completed. All resources restored. HP at maximum.' });
      } else {
        rurik.channel_divinity.used = 0;
        state.history_log.push({ timestamp: new Date().toISOString(), event: 'Short rest completed. Channel Divinity restored.' });
      }
      saveCampaignState(state);
      return { success: true, rest_type: input.rest_type, state_updated: true };
    }

    case 'add_inventory_item': {
      if (!state) return { error: 'No campaign state found' };
      const inv = state.party[0].inventory;
      const existing = inv.find(i => i.name.toLowerCase() === input.name.toLowerCase());
      if (existing) {
        existing.quantity += input.quantity;
      } else {
        inv.push({ name: input.name, quantity: input.quantity, rarity: input.rarity });
      }
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Acquired: ${input.name} ×${input.quantity}` });
      saveCampaignState(state);
      return { success: true, item: input.name, quantity: input.quantity, state_updated: true };
    }

    case 'remove_inventory_item': {
      if (!state) return { error: 'No campaign state found' };
      const inv = state.party[0].inventory;
      const idx = inv.findIndex(i => i.name.toLowerCase() === input.name.toLowerCase());
      if (idx === -1) return { error: `Item "${input.name}" not found in inventory` };
      inv[idx].quantity -= input.quantity;
      if (inv[idx].quantity <= 0) inv.splice(idx, 1);
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Used/removed: ${input.name} ×${input.quantity}` });
      saveCampaignState(state);
      return { success: true, state_updated: true };
    }

    case 'complete_quest_step': {
      if (!state) return { error: 'No campaign state found' };
      const quest = state.quests.find(q => q.id === input.quest_id);
      if (!quest) return { error: `Quest ${input.quest_id} not found` };
      const step = quest.steps.find(s => s.step_id === input.step_id);
      if (!step) return { error: `Step ${input.step_id} not found in quest ${input.quest_id}` };
      step.completed = true;
      const allDone = quest.steps.every(s => s.completed);
      if (allDone) quest.status = 'completed';
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Quest step completed: "${step.description}" (${quest.title})` });
      saveCampaignState(state);
      return { success: true, quest_complete: allDone, state_updated: true };
    }

    case 'append_history_log': {
      if (!state) return { error: 'No campaign state found' };
      state.history_log.push({ timestamp: new Date().toISOString(), event: input.event });
      saveCampaignState(state);
      return { success: true };
    }

    case 'end_session': {
      try {
        // 1. Sync Campaign Context full.md with live state
        const finalState = loadCampaignState();
        updateContextFile(finalState);

        // 2. Commit everything
        execSync('git add -A', { cwd: REPO_PATH, stdio: 'pipe' });
        const safeMsg = input.summary.replace(/"/g, "'").replace(/\n/g, ' ').slice(0, 120);
        execSync(`git commit -m "Session end: ${safeMsg}"`, { cwd: REPO_PATH, stdio: 'pipe' });

        // 3. Push to GitHub
        execSync('git push', { cwd: REPO_PATH, stdio: 'pipe' });

        return {
          success: true,
          message: 'Campaign Context updated. All changes committed and pushed to GitHub. Session saved.'
        };
      } catch (e) {
        const msg = e.stdout ? e.stdout.toString() : (e.stderr ? e.stderr.toString() : e.message);
        if (msg.includes('nothing to commit')) return { success: true, message: 'Nothing new to commit — already up to date on GitHub.' };
        return { error: `Git error: ${msg.slice(0, 200)}` };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────
function buildSystemPrompt(state) {
  if (!state) return 'You are a D&D 5e Dungeon Master. Use your tools to resolve all dice rolls and state changes.';

  const rurik = state.party[0];
  const world = state.world;

  const slots = Object.entries(rurik.spell_slots)
    .filter(([, v]) => v.max > 0)
    .map(([k, v]) => `Lv${k.replace('level_', '')}: ${v.max - v.used}/${v.max}`)
    .join(', ');

  const cd = rurik.channel_divinity;
  const inv = rurik.inventory.map(i => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ');

  const activeQuests = state.quests.filter(q => q.status === 'active').map(q => {
    const steps = q.steps.map(s => `  ${s.completed ? '[x]' : '[ ]'} ${s.description}`).join('\n');
    return `${q.title}\n${steps}`;
  }).join('\n\n');

  const allies = state.npcs.filter(n => ['ally', 'redeemed-enemy', 'civilian-ally'].includes(n.role))
    .map(n => `• ${n.name} (${n.location}) — ${n.personality}`).join('\n');

  return `You are the Dungeon Master running a solo D&D 5e campaign. You have tools to resolve ALL mechanical actions. Never narrate a dice roll without actually calling roll_dice. Never describe a state change without executing the corresponding tool.

BEHAVIOR RULES:
- Call roll_dice for EVERY dice roll (attacks, saves, damage, skill checks, initiative)
- Call use_spell_slot immediately when a leveled spell is cast
- Call update_hp immediately after any damage or healing resolves
- Call use_channel_divinity when that resource is spent
- Call append_history_log after every significant narrative event (combat, key decisions, discoveries)
- Call complete_quest_step when the party achieves a tracked objective
- Call end_session only when the player explicitly says they are done for the day
- Be a vivid, dramatic DM — describe scenes, voice NPCs, build tension
- Reference the specific NPCs and their personalities when they speak
- Track time of day; narrative should reflect Day ${world.time}

═══════════════════════════════════
CAMPAIGN: Lost Mine of Phandelver — The Witness Arc
═══════════════════════════════════
Location: ${world.current_location}
Time: ${world.time}
Seal: ${world.seal_integrity}% integrity (${world.seal_status})
Situation: ${world.lore_summary}

CHARACTER — ${rurik.name} | ${rurik.class} Lv${rurik.level}
HP: ${rurik.hp}/27
Spell Slots: ${slots || 'none'}
Channel Divinity: ${cd.max - cd.used}/${cd.max}
AC: 18 (Chain Mail + Shield)
Inventory: ${inv}
Proficiency Bonus: +2
Key stats: STR +2, DEX -1, CON +2, INT +0, WIS +5, CHA +1
Save proficiencies: WIS, CHA

ACTIVE QUESTS
${activeQuests || 'None'}

ALLIES PRESENT (Old Marta's Cabin)
${allies}

ANTAGONISTS
• Silga — Redbrand field commander in Phandalin, tactical and brutal, 8-12 soldiers
• The Mind Flayer — location unknown, severed from the Witness, ancient and calculating

KEY INTEL AVAILABLE
• Iarno Albrek knows: patrol rotations, blind spots, 3-5am south road gap
• Qelline Alderleaf: south road gap confirmed, forest NE path scouted, Harpers arrive Day 9

PENDING DECISION: Choose escape route — South Road (3-5am gap) / Forest Path NE / Hold for Harpers (Day 9)`;
}

// ─── AGENTIC STREAM LOOP ────────────────────────────────────────────────────
function makeAPIRequest(requestBody) {
  return new Promise((resolve, reject) => {
    const parsedBody = JSON.parse(requestBody);
    const bodyBuffer = Buffer.from(requestBody);
    const apiReq = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuffer.length,
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, resolve);
    apiReq.on('error', reject);
    apiReq.write(bodyBuffer);
    apiReq.end();
  });
}

async function streamAgenticLoop(messages, systemPrompt, res) {
  const MAX_LOOPS = 6;
  let loopCount = 0;
  let totalOutputTokens = 0;

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    const requestBody = JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      tools: TOOLS,
      messages,
      stream: true
    });

    const apiRes = await makeAPIRequest(requestBody);

    // Accumulate this turn's content
    let textThisTurn = '';
    const toolUsesThisTurn = [];
    let currentToolUse = null;
    let currentToolInputJson = '';
    let stopReason = 'end_turn';
    let stateUpdatedThisTurn = false;

    await new Promise((resolve) => {
      apiRes.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));

            // Content block started
            if (data.type === 'content_block_start') {
              if (data.content_block.type === 'tool_use') {
                currentToolUse = { id: data.content_block.id, name: data.content_block.name };
                currentToolInputJson = '';
              }
            }

            // Content delta
            if (data.type === 'content_block_delta') {
              if (data.delta.type === 'text_delta') {
                textThisTurn += data.delta.text;
                res.write(`data: ${JSON.stringify({ type: 'text', content: data.delta.text })}\n\n`);
              }
              if (data.delta.type === 'input_json_delta') {
                currentToolInputJson += data.delta.partial_json;
              }
            }

            // Content block ended
            if (data.type === 'content_block_stop' && currentToolUse) {
              try { currentToolUse.input = JSON.parse(currentToolInputJson); } catch { currentToolUse.input = {}; }
              toolUsesThisTurn.push(currentToolUse);
              currentToolUse = null;
              currentToolInputJson = '';
            }

            // Message metadata
            if (data.type === 'message_delta') {
              stopReason = data.delta.stop_reason || 'end_turn';
              if (data.usage) totalOutputTokens += data.usage.output_tokens || 0;
            }

          } catch (e) { /* ignore parse errors */ }
        }
      });
      apiRes.on('end', resolve);
    });

    // Build assistant message content for the conversation
    const assistantContent = [];
    if (textThisTurn) assistantContent.push({ type: 'text', text: textThisTurn });
    for (const tu of toolUsesThisTurn) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    if (assistantContent.length > 0) {
      messages.push({ role: 'assistant', content: assistantContent });
    }

    // If no tool calls, we're done
    if (stopReason !== 'tool_use' || toolUsesThisTurn.length === 0) break;

    // Execute tools and collect results
    const toolResults = [];
    for (const tu of toolUsesThisTurn) {
      console.log(`  🔧 Tool: ${tu.name}`, JSON.stringify(tu.input).slice(0, 80));
      const result = executeTool(tu.name, tu.input);
      console.log(`  ✓ Result:`, JSON.stringify(result).slice(0, 80));

      if (result.state_updated) stateUpdatedThisTurn = true;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result)
      });
    }

    // Notify dashboard of state change so it can refresh
    if (stateUpdatedThisTurn) {
      const newState = loadCampaignState();
      if (newState) {
        res.write(`data: ${JSON.stringify({ type: 'state_update', state: newState })}\n\n`);
      }
    }

    // Add tool results + narrative nudge as user message and loop
    toolResults.push({
      type: 'text',
      text: 'Tool calls complete. Now continue the scene — describe what happened with vivid DM narration. Reference the exact dice result in your description.'
    });
    messages.push({ role: 'user', content: toolResults });
  }

  return totalOutputTokens;
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // GET /api/chat/history
  if (req.method === 'GET' && req.url === '/api/chat/history') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadChatHistory()));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/chat — agentic DM stream
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        if (!prompt) { res.writeHead(400); res.end(JSON.stringify({ error: 'prompt required' })); return; }

        const history = loadChatHistory();
        history.messages.push({ role: 'user', content: prompt });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        // Build messages list (user/assistant only — tool turns handled internally)
        // We reconstruct from stored history (text-only) to keep history clean
        const messagesForAPI = history.messages.map(m => ({
          role: m.role,
          content: m.content
        }));

        const systemPrompt = buildSystemPrompt(loadCampaignState());
        console.log(`\n→ Prompt: "${prompt.slice(0, 60)}..."`);

        const outputTokens = await streamAgenticLoop(messagesForAPI, systemPrompt, res);

        // Extract the final assistant text from messagesForAPI for history
        let fullAssistantText = '';
        for (let i = history.messages.length; i < messagesForAPI.length; i++) {
          const msg = messagesForAPI[i];
          if (msg.role === 'assistant') {
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === 'text') fullAssistantText += block.text;
              }
            } else if (typeof msg.content === 'string') {
              fullAssistantText += msg.content;
            }
          }
        }

        history.messages.push({ role: 'assistant', content: fullAssistantText });
        history.token_count += estimateTokens(prompt) + (outputTokens || estimateTokens(fullAssistantText));
        history.model = MODEL;
        saveChatHistory(history);

        res.write(`data: ${JSON.stringify({ type: 'done', token_count: history.token_count, model: MODEL })}\n\n`);
        res.end();

        console.log(`✓ Done (${fullAssistantText.length} chars)`);

      } catch (err) {
        console.error('Error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
      }
    });
    return;
  }

  // GET /api/chat/clear
  if (req.method === 'GET' && req.url === '/api/chat/clear') {
    try {
      saveChatHistory({ messages: [], created_at: new Date().toISOString(), token_count: 0, model: MODEL });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`✓ Campaign DM Relay running on port ${PORT}`);
  console.log(`  Model: ${MODEL} | Tools: ${TOOLS.length} | Agentic loop: up to 6 turns`);
  console.log(`  Auto-save: every ${AUTO_SAVE_INTERVAL_MS / 60000} min (local commit)`);
  console.log(`  POST http://localhost:${PORT}/api/chat`);
  console.log(`  GET  http://localhost:${PORT}/api/chat/history`);
  console.log(`  GET  http://localhost:${PORT}/api/chat/clear`);

  // Start auto-save interval
  setInterval(autoSave, AUTO_SAVE_INTERVAL_MS);
});
