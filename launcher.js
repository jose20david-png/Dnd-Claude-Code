#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════
//  CAMPAIGN LAUNCHER — Single-process, all servers in one exe
//  Ports: 8080 (dashboard), 3140 (campaign API), 3141 (DM relay)
// ═══════════════════════════════════════════════════════════════════

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const { execSync, exec } = require('child_process');

// When running as a pkg exe, data files live next to the exe.
// When running as plain node, they live next to this script.
const APP_DIR = process.pkg
  ? path.dirname(process.execPath)
  : path.resolve(__dirname);

const CAMPAIGN_STATE_PATH = path.join(APP_DIR, 'campaign_state.json');
const CONTEXT_PATH        = path.join(APP_DIR, 'Campaign Context full.md');
const CHAT_HISTORY_PATH   = path.join(APP_DIR, 'claude_chat_history.json');
const DASHBOARD_PATH      = path.join(APP_DIR, 'Campaign Dashboard HTML.html');
const ENV_PATH            = path.join(APP_DIR, '.env');

const MODEL = 'claude-haiku-4-5';
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;

// ─── STARTUP BANNER ─────────────────────────────────────────────────────────
console.log('');
console.log('  ╔══════════════════════════════════════════╗');
console.log('  ║   ⚔️  D&D Campaign — Rurik Stormhammer   ║');
console.log('  ║      Lost Mine of Phandelver             ║');
console.log('  ╚══════════════════════════════════════════╝');
console.log('');

// ─── API KEY ─────────────────────────────────────────────────────────────────
let API_KEY = '';
try {
  const envContent = fs.readFileSync(ENV_PATH, 'utf8');
  const match = envContent.match(/ANTHROPIC_API_KEY=(.+)/);
  if (match) API_KEY = match[1].trim();
} catch (e) {}

if (!API_KEY) {
  console.error('  ❌  .env file not found or ANTHROPIC_API_KEY missing.');
  console.error(`  Create a file called .env in:\n  ${APP_DIR}`);
  console.error('  Containing one line:  ANTHROPIC_API_KEY=sk-ant-...');
  console.error('');
  process.exit(1);
}

// ─── DEFAULT CAMPAIGN STATE ──────────────────────────────────────────────────
const DEFAULT_STATE = {
  campaign_id: 'lost-mine-phandelver-witness-arc',
  world: {
    name: 'Forgotten Realms — Phandelver Region',
    lore_summary: 'The Witness is sealed beneath Wave Echo Cave. Breeding chamber destroyed Day 6. Mind Flayer at large. Phandalin occupied by Redbrands.',
    current_location: "Old Marta's Cabin, Phandalin outskirts",
    time: 'Day 7 — Morning',
    seal_integrity: 100,
    seal_status: 'Stable — years'
  },
  party: [{
    id: 'rurik',
    name: 'Rurik Stormhammer',
    class: 'Cleric (Storm Domain)',
    level: 3,
    hp: 27,
    status: 'active',
    spell_slots: {
      cantrip:  { max: 0, used: 0 },
      level_1:  { max: 4, used: 0 },
      level_2:  { max: 2, used: 0 },
      level_3:  { max: 0, used: 0 },
      level_4:  { max: 0, used: 0 },
      level_5:  { max: 0, used: 0 }
    },
    channel_divinity: { max: 1, used: 0 },
    inventory: [
      { name: 'Warhammer +1', quantity: 1, rarity: 'uncommon' },
      { name: 'Holy Symbol of Talos (amulet)', quantity: 1, rarity: 'common' },
      { name: 'Chain Mail', quantity: 1, rarity: 'common' },
      { name: 'Shield', quantity: 1, rarity: 'common' },
      { name: 'Torch', quantity: 3, rarity: 'common' },
      { name: 'Healing Kit', quantity: 1, rarity: 'common' }
    ]
  }],
  npcs: [],
  quests: [],
  encounters: [],
  history_log: [{ timestamp: new Date().toISOString(), event: 'Campaign loaded.' }]
};

// ─── STATE HELPERS ────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(CAMPAIGN_STATE_PATH))
      return JSON.parse(fs.readFileSync(CAMPAIGN_STATE_PATH, 'utf8'));
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}
function saveState(s) { fs.writeFileSync(CAMPAIGN_STATE_PATH, JSON.stringify(s, null, 2), 'utf8'); }

function loadHistory() {
  try {
    if (fs.existsSync(CHAT_HISTORY_PATH))
      return JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH, 'utf8'));
  } catch (e) {}
  return { messages: [], created_at: new Date().toISOString(), token_count: 0, model: MODEL };
}
function saveHistory(h) { fs.writeFileSync(CHAT_HISTORY_PATH, JSON.stringify(h, null, 2), 'utf8'); }
function estimateTokens(t) { return Math.ceil(t.length / 4); }

// ─── DICE ─────────────────────────────────────────────────────────────────────
function rollDice(expr) {
  const m = expr.match(/(\d+)d(\d+)([+-]\d+)?/i);
  if (!m) return { total: 0, breakdown: `Invalid: ${expr}` };
  const num = parseInt(m[1]), sides = parseInt(m[2]), mod = parseInt(m[3] || '0');
  const rolls = Array.from({ length: num }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const bd = mod !== 0
    ? `[${rolls.join(', ')}]${mod >= 0 ? '+' : ''}${mod} = **${total}**`
    : `[${rolls.join(', ')}] = **${total}**`;
  return { total, rolls, modifier: mod, breakdown: bd };
}

// ─── TOOLS ────────────────────────────────────────────────────────────────────
const TOOLS = [
  { name: 'roll_dice', description: 'Roll dice for any D&D check. ALWAYS use this for every dice roll.',
    input_schema: { type: 'object', properties: {
      expression: { type: 'string', description: 'e.g. "1d20+5", "2d6", "1d8"' },
      purpose:    { type: 'string', description: 'What the roll is for' }
    }, required: ['expression', 'purpose'] }
  },
  { name: 'update_hp', description: "Update Rurik's HP after damage or healing.",
    input_schema: { type: 'object', properties: {
      hp:     { type: 'number', description: 'New current HP (0–27)' },
      reason: { type: 'string', description: 'Why HP changed' }
    }, required: ['hp', 'reason'] }
  },
  { name: 'use_spell_slot', description: 'Spend a spell slot when a leveled spell is cast.',
    input_schema: { type: 'object', properties: {
      level:      { type: 'number', description: 'Slot level (1 or 2)' },
      spell_name: { type: 'string', description: 'Spell being cast' }
    }, required: ['level', 'spell_name'] }
  },
  { name: 'use_channel_divinity', description: 'Spend Channel Divinity.',
    input_schema: { type: 'object', properties: {
      ability: { type: 'string', description: 'Which ability used' }
    }, required: ['ability'] }
  },
  { name: 'restore_resources', description: 'Restore resources after a rest.',
    input_schema: { type: 'object', properties: {
      rest_type: { type: 'string', enum: ['long_rest', 'short_rest'] }
    }, required: ['rest_type'] }
  },
  { name: 'add_inventory_item', description: "Add item to Rurik's inventory.",
    input_schema: { type: 'object', properties: {
      name: { type: 'string' }, quantity: { type: 'number' },
      rarity: { type: 'string', enum: ['common','uncommon','rare','very rare','legendary'] }
    }, required: ['name','quantity','rarity'] }
  },
  { name: 'remove_inventory_item', description: 'Remove or consume an inventory item.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'Exact item name' },
      quantity: { type: 'number' }
    }, required: ['name','quantity'] }
  },
  { name: 'complete_quest_step', description: 'Mark a quest step as completed.',
    input_schema: { type: 'object', properties: {
      quest_id: { type: 'string' }, step_id: { type: 'string' }
    }, required: ['quest_id','step_id'] }
  },
  { name: 'append_history_log', description: 'Record a significant narrative event.',
    input_schema: { type: 'object', properties: {
      event: { type: 'string', description: 'One-sentence event description' }
    }, required: ['event'] }
  },
  { name: 'end_session', description: 'End the session, sync context file, commit and push to GitHub.',
    input_schema: { type: 'object', properties: {
      summary: { type: 'string', description: 'Brief session summary for git commit' }
    }, required: ['summary'] }
  }
];

// ─── TOOL EXECUTOR ───────────────────────────────────────────────────────────
function executeTool(name, input) {
  const state = loadState();

  switch (name) {
    case 'roll_dice': {
      const r = rollDice(input.expression);
      return { rolled: input.expression, purpose: input.purpose, result: r.breakdown, total: r.total };
    }
    case 'update_hp': {
      const hp = Math.max(0, Math.min(27, Math.round(input.hp)));
      state.party[0].hp = hp;
      state.history_log.push({ timestamp: new Date().toISOString(), event: input.reason });
      saveState(state);
      return { success: true, hp, max_hp: 27, state_updated: true };
    }
    case 'use_spell_slot': {
      const slots = state.party[0].spell_slots;
      const key = `level_${input.level}`;
      if (!slots[key] || slots[key].used >= slots[key].max)
        return { error: `No level ${input.level} spell slots remaining` };
      slots[key].used++;
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Cast ${input.spell_name} (Lv${input.level} slot). ${slots[key].max - slots[key].used}/${slots[key].max} remaining.` });
      saveState(state);
      return { success: true, remaining: slots[key].max - slots[key].used, state_updated: true };
    }
    case 'use_channel_divinity': {
      const cd = state.party[0].channel_divinity;
      if (cd.used >= cd.max) return { error: 'No Channel Divinity remaining' };
      cd.used++;
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Used Channel Divinity: ${input.ability}` });
      saveState(state);
      return { success: true, remaining: cd.max - cd.used, state_updated: true };
    }
    case 'restore_resources': {
      const r = state.party[0];
      if (input.rest_type === 'long_rest') {
        for (const k of Object.keys(r.spell_slots)) r.spell_slots[k].used = 0;
        r.channel_divinity.used = 0;
        r.hp = 27;
        state.history_log.push({ timestamp: new Date().toISOString(), event: 'Long rest — all resources restored, HP at maximum.' });
      } else {
        r.channel_divinity.used = 0;
        state.history_log.push({ timestamp: new Date().toISOString(), event: 'Short rest — Channel Divinity restored.' });
      }
      saveState(state);
      return { success: true, rest_type: input.rest_type, state_updated: true };
    }
    case 'add_inventory_item': {
      const inv = state.party[0].inventory;
      const ex = inv.find(i => i.name.toLowerCase() === input.name.toLowerCase());
      if (ex) ex.quantity += input.quantity;
      else inv.push({ name: input.name, quantity: input.quantity, rarity: input.rarity });
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Acquired: ${input.name} ×${input.quantity}` });
      saveState(state);
      return { success: true, state_updated: true };
    }
    case 'remove_inventory_item': {
      const inv = state.party[0].inventory;
      const idx = inv.findIndex(i => i.name.toLowerCase() === input.name.toLowerCase());
      if (idx === -1) return { error: `"${input.name}" not in inventory` };
      inv[idx].quantity -= input.quantity;
      if (inv[idx].quantity <= 0) inv.splice(idx, 1);
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Used/removed: ${input.name} ×${input.quantity}` });
      saveState(state);
      return { success: true, state_updated: true };
    }
    case 'complete_quest_step': {
      const quest = state.quests.find(q => q.id === input.quest_id);
      if (!quest) return { error: `Quest ${input.quest_id} not found` };
      const step = quest.steps.find(s => s.step_id === input.step_id);
      if (!step) return { error: `Step ${input.step_id} not found` };
      step.completed = true;
      if (quest.steps.every(s => s.completed)) quest.status = 'completed';
      state.history_log.push({ timestamp: new Date().toISOString(), event: `Quest step completed: "${step.description}"` });
      saveState(state);
      return { success: true, state_updated: true };
    }
    case 'append_history_log': {
      state.history_log.push({ timestamp: new Date().toISOString(), event: input.event });
      saveState(state);
      return { success: true };
    }
    case 'end_session': {
      try {
        updateContextFile(loadState());
        execSync('git add -A', { cwd: APP_DIR, stdio: 'pipe' });
        const msg = input.summary.replace(/"/g, "'").replace(/\n/g, ' ').slice(0, 120);
        execSync(`git commit -m "Session end: ${msg}"`, { cwd: APP_DIR, stdio: 'pipe' });
        execSync('git push', { cwd: APP_DIR, stdio: 'pipe' });
        return { success: true, message: 'Context synced. Committed and pushed to GitHub.' };
      } catch (e) {
        const msg = e.stdout ? e.stdout.toString() : e.message;
        if (msg.includes('nothing to commit')) return { success: true, message: 'Nothing new to commit.' };
        return { error: `Git error: ${msg.slice(0, 200)}` };
      }
    }
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── CONTEXT FILE SYNC ────────────────────────────────────────────────────────
function updateContextFile(state) {
  if (!state || !fs.existsSync(CONTEXT_PATH)) return;
  try {
    let content = fs.readFileSync(CONTEXT_PATH, 'utf8');
    const rurik = state.party[0];
    const world = state.world;
    const now = new Date().toISOString().slice(0, 10);
    const slotNames = { level_1:'1st', level_2:'2nd', level_3:'3rd', level_4:'4th', level_5:'5th' };
    const slotParts = Object.entries(rurik.spell_slots)
      .filter(([, v]) => v.max > 0)
      .map(([k, v]) => `${v.max - v.used}× ${slotNames[k]}`);
    const allFull = Object.entries(rurik.spell_slots).filter(([, v]) => v.max > 0).every(([, v]) => v.used === 0);
    const slotsDisplay = slotParts.join(', ') + (allFull ? ' (full)' : '');
    const cd = rurik.channel_divinity;
    const hpTag = rurik.hp === 27 ? 'full — long rest complete' : rurik.hp >= 20 ? 'lightly wounded' : rurik.hp >= 10 ? 'wounded' : 'critical';
    const newBlock = `## SESSION STATE — ${world.time}\n\n| Field | Value |\n|---|---|\n| Location | ${world.current_location} |\n| HP | ${rurik.hp} / 27 (${hpTag}) |\n| Spell Slots | ${slotsDisplay || 'none'} |\n| Channel Divinity | ${cd.max - cd.used} / ${cd.max} available |`;
    content = content.replace(/## SESSION STATE[\s\S]*?(?=\n---\n)/, newBlock);
    content = content.replace(/\*Last updated: \d{4}-\d{2}-\d{2}/, `*Last updated: ${now}`);
    const recent = state.history_log.slice(-8).map(e => `- ${e.event}`).join('\n');
    if (recent) {
      const notesBlock = `\n## SESSION NOTES (auto-generated)\n\n${recent}\n`;
      if (content.includes('## SESSION NOTES')) {
        content = content.replace(/## SESSION NOTES[\s\S]*?(?=\n## |$)/, notesBlock.trim() + '\n');
      } else {
        content = content.replace('## CHARACTER QUICK REFERENCE', notesBlock + '\n## CHARACTER QUICK REFERENCE');
      }
    }
    fs.writeFileSync(CONTEXT_PATH, content, 'utf8');
    console.log('✓ Campaign Context full.md synced');
  } catch (e) { console.warn('⚠️  Context sync failed:', e.message); }
}

// ─── AUTO-SAVE ────────────────────────────────────────────────────────────────
function autoSave() {
  try {
    const status = execSync('git status --porcelain', { cwd: APP_DIR, stdio: 'pipe' }).toString().trim();
    if (!status) return;
    execSync('git add campaign_state.json claude_chat_history.json', { cwd: APP_DIR, stdio: 'pipe' });
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    execSync(`git commit -m "Auto-save: ${ts}"`, { cwd: APP_DIR, stdio: 'pipe' });
    console.log(`✓ Auto-saved at ${ts}`);
  } catch (e) {
    const msg = (e.stdout || '').toString();
    if (!msg.includes('nothing to commit')) console.warn('Auto-save skipped');
  }
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
function buildSystemPrompt(state) {
  if (!state) return 'You are a D&D 5e Dungeon Master. Use tools for all dice rolls and state changes.';
  const rurik = state.party[0];
  const world = state.world;
  const slotNames = { level_1:'1st', level_2:'2nd', level_3:'3rd', level_4:'4th', level_5:'5th' };
  const slots = Object.entries(rurik.spell_slots)
    .filter(([, v]) => v.max > 0)
    .map(([k, v]) => `Lv${k.replace('level_','')}: ${v.max - v.used}/${v.max}`)
    .join(', ');
  const cd = rurik.channel_divinity;
  const inv = rurik.inventory.map(i => `${i.name}${i.quantity>1?` ×${i.quantity}`:''}`).join(', ');
  const activeQuests = (state.quests||[]).filter(q=>q.status==='active')
    .map(q=>`${q.title}\n${q.steps.map(s=>`  ${s.completed?'[x]':'[ ]'} ${s.description}`).join('\n')}`).join('\n\n');
  const allies = (state.npcs||[]).filter(n=>['ally','redeemed-enemy','civilian-ally'].includes(n.role))
    .map(n=>`• ${n.name} (${n.location}) — ${n.personality}`).join('\n');

  return `You are the Dungeon Master running a solo D&D 5e campaign. Use tools for ALL mechanical actions — never narrate a dice roll without calling roll_dice, never describe HP/slot changes without the corresponding tool call.

BEHAVIOR:
- Call roll_dice for EVERY dice roll (attacks, saves, damage, checks, initiative)
- Call use_spell_slot immediately when a leveled spell is cast
- Call update_hp after any damage or healing resolves
- Call append_history_log after major narrative events
- After tool calls, ALWAYS continue with vivid DM narration describing the outcome
- Be dramatic, specific, and reference the actual numbers from tool results

════════════════════════════
CAMPAIGN: Lost Mine of Phandelver — The Witness Arc
════════════════════════════
Location: ${world.current_location}
Time: ${world.time}
Seal: ${world.seal_integrity}% (${world.seal_status})
Situation: ${world.lore_summary}

CHARACTER — ${rurik.name} | ${rurik.class} Lv${rurik.level}
HP: ${rurik.hp}/27 | AC: 18 | Prof: +2
Spell Slots: ${slots||'none'} | Channel Divinity: ${cd.max-cd.used}/${cd.max}
Spell Save DC 13 | Spell Attack +5
Warhammer +1: +4 to hit, 1d8+2 bludg.
Inventory: ${inv}

ACTIVE QUESTS
${activeQuests||'None active'}

ALLIES
${allies||'None present'}

ANTAGONISTS
• Silga — Redbrand field commander, Phandalin, 8-12 soldiers
• The Mind Flayer — location unknown, ancient, severed from the Witness

KEY INTEL: Iarno knows patrol schedules & 3-5am south road gap. Qelline scouted all three escape routes. Harpers arrive Day 9.
PENDING DECISION: South Road (3-5am gap) / Forest Path NE / Wait for Harpers`;
}

// ─── AGENTIC DM LOOP ─────────────────────────────────────────────────────────
function makeAPICall(bodyStr) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(bodyStr);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, resolve);
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function streamAgenticLoop(messages, systemPrompt, res) {
  let totalTokens = 0;
  for (let loop = 0; loop < 6; loop++) {
    const body = JSON.stringify({ model: MODEL, max_tokens: 2000, system: systemPrompt, tools: TOOLS, messages, stream: true });
    const apiRes = await makeAPICall(body);

    let textTurn = '', toolUses = [], currentTU = null, currentJson = '', stopReason = 'end_turn', stateUpdated = false;

    await new Promise(resolve => {
      apiRes.on('data', chunk => {
        for (const line of chunk.toString().split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === 'content_block_start' && d.content_block.type === 'tool_use') {
              currentTU = { id: d.content_block.id, name: d.content_block.name };
              currentJson = '';
            }
            if (d.type === 'content_block_delta') {
              if (d.delta.type === 'text_delta') {
                textTurn += d.delta.text;
                res.write(`data: ${JSON.stringify({ type: 'text', content: d.delta.text })}\n\n`);
              }
              if (d.delta.type === 'input_json_delta') currentJson += d.delta.partial_json;
            }
            if (d.type === 'content_block_stop' && currentTU) {
              try { currentTU.input = JSON.parse(currentJson); } catch { currentTU.input = {}; }
              toolUses.push(currentTU);
              currentTU = null; currentJson = '';
            }
            if (d.type === 'message_delta') {
              stopReason = d.delta.stop_reason || 'end_turn';
              if (d.usage) totalTokens += d.usage.output_tokens || 0;
            }
          } catch {}
        }
      });
      apiRes.on('end', resolve);
    });

    const assistantContent = [];
    if (textTurn) assistantContent.push({ type: 'text', text: textTurn });
    for (const tu of toolUses) assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    if (assistantContent.length) messages.push({ role: 'assistant', content: assistantContent });

    if (stopReason !== 'tool_use' || !toolUses.length) break;

    const toolResults = [];
    for (const tu of toolUses) {
      console.log(`  🔧 ${tu.name}(${JSON.stringify(tu.input).slice(0, 60)})`);
      const result = executeTool(tu.name, tu.input);
      if (result.state_updated) {
        stateUpdated = true;
        console.log(`  ✓ state updated`);
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }

    if (stateUpdated) {
      const ns = loadState();
      if (ns) res.write(`data: ${JSON.stringify({ type: 'state_update', state: ns })}\n\n`);
    }

    toolResults.push({ type: 'text', text: 'Tool calls complete. Now continue the scene with vivid DM narration, referencing the exact dice result.' });
    messages.push({ role: 'user', content: toolResults });
  }
  return totalTokens;
}

// ─── CAMPAIGN STATE API — port 3140 ──────────────────────────────────────────
const campaignApiServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/api/state') {
    const state = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/state') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const newState = JSON.parse(body);
        saveState(newState);
        newState.history_log = newState.history_log || [];
        newState.history_log.push({ timestamp: new Date().toISOString(), event: 'State updated via dashboard.' });
        saveState(newState);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state: newState }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── CLAUDE DM RELAY — port 3141 ─────────────────────────────────────────────
const relayServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/api/chat/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadHistory()));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/chat/clear') {
    saveHistory({ messages: [], created_at: new Date().toISOString(), token_count: 0, model: MODEL });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        if (!prompt) { res.writeHead(400); res.end(JSON.stringify({ error: 'prompt required' })); return; }

        const history = loadHistory();
        history.messages.push({ role: 'user', content: prompt });

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

        const messagesForAPI = history.messages.map(m => ({ role: m.role, content: m.content }));
        const systemPrompt = buildSystemPrompt(loadState());
        console.log(`\n→ "${prompt.slice(0, 70)}"`);

        const outTokens = await streamAgenticLoop(messagesForAPI, systemPrompt, res);

        let finalText = '';
        for (let i = history.messages.length; i < messagesForAPI.length; i++) {
          const m = messagesForAPI[i];
          if (m.role === 'assistant') {
            if (Array.isArray(m.content)) finalText += m.content.filter(b => b.type === 'text').map(b => b.text).join('');
            else if (typeof m.content === 'string') finalText += m.content;
          }
        }

        history.messages.push({ role: 'assistant', content: finalText });
        history.token_count += estimateTokens(prompt) + (outTokens || estimateTokens(finalText));
        history.model = MODEL;
        saveHistory(history);

        res.write(`data: ${JSON.stringify({ type: 'done', token_count: history.token_count, model: MODEL })}\n\n`);
        res.end();
        console.log(`✓ Done (${finalText.length} chars)`);

      } catch (err) {
        console.error('Relay error:', err.message);
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── DASHBOARD HTTP SERVER — port 8080 ───────────────────────────────────────
const dashboardServer = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;
  try { pathname = decodeURIComponent(pathname); } catch {}
  if (pathname.startsWith('/')) pathname = pathname.slice(1);
  if (!pathname) pathname = 'Campaign Dashboard HTML.html';

  const filePath = path.join(APP_DIR, pathname);
  if (!filePath.startsWith(APP_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + pathname); return; }
    let ct = 'text/plain';
    if (pathname.endsWith('.html')) ct = 'text/html; charset=utf-8';
    else if (pathname.endsWith('.js')) ct = 'application/javascript';
    else if (pathname.endsWith('.json')) ct = 'application/json';
    else if (pathname.endsWith('.css')) ct = 'text/css';
    else if (pathname.endsWith('.png')) ct = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) ct = 'image/jpeg';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
});

// ─── START ALL SERVERS ───────────────────────────────────────────────────────
function startServer(server, port, name, onReady) {
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  ⚠️  Port ${port} already in use — ${name} skipped (another instance may be running)`);
      if (onReady) onReady(); // still call onReady so browser opens
    } else {
      console.error(`  ✗ ${name} error:`, err.message);
    }
  });
  server.listen(port, () => {
    console.log(`  ✓ ${name.padEnd(18)} → http://localhost:${port}`);
    if (onReady) onReady();
  });
}

startServer(campaignApiServer, 3140, 'Campaign API');
startServer(relayServer,       3141, 'Claude DM Relay');
startServer(dashboardServer,   8080, 'Dashboard', () => {
  console.log('');
  console.log('  Opening browser...');

  setTimeout(() => {
    const dashUrl = 'http://localhost:8080';
    // Windows: use cmd /c start to open browser reliably
    if (process.platform === 'win32') {
      exec(`cmd /c start ${dashUrl}`, err => {
        if (err) console.log(`  Open your browser to: ${dashUrl}`);
        else console.log(`  ✓ Browser opened: ${dashUrl}`);
      });
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${cmd} ${dashUrl}`, err => {
        if (err) console.log(`  Open your browser to: ${dashUrl}`);
        else console.log(`  ✓ Browser opened: ${dashUrl}`);
      });
    }
    console.log('');
    console.log('  Auto-save: every 5 minutes');
    console.log('  Press Ctrl+C to stop');
    console.log('');

    setInterval(autoSave, AUTO_SAVE_INTERVAL_MS);
  }, 500);
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  campaignApiServer.close();
  relayServer.close();
  dashboardServer.close();
  process.exit(0);
});
