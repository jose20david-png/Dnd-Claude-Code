#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════
//  CAMPAIGN LAUNCHER — D&D 5e Solo Campaign Engine  (Build 12)
//  Ports: 8080 (dashboard), 3140 (campaign API), 3141 (DM relay)
// ═══════════════════════════════════════════════════════════════════

const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const urlMod    = require('url');
const readline  = require('readline');
const { execSync, exec } = require('child_process');

// ─── PATHS ────────────────────────────────────────────────────────────────────
// In pkg exe: data files live next to the exe. In plain node: next to this script.
const APP_DIR             = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname);
const CAMPAIGN_STATE_PATH = path.join(APP_DIR, 'campaign_state.json');
const CONTEXT_PATH        = path.join(APP_DIR, 'Campaign Context full.md');
const CHAT_HISTORY_PATH   = path.join(APP_DIR, 'claude_chat_history.json');
const DASHBOARD_PATH      = path.join(APP_DIR, 'Campaign Dashboard HTML.html');
const JOURNAL_PATH        = path.join(APP_DIR, 'journal.md');
const ENV_PATH            = path.join(APP_DIR, '.env');
const SAVES_DIR           = path.join(APP_DIR, 'saves');

const MODEL                = 'open-mistral-nemo';
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;
const PORTS                = [3140, 3141, 8080];

// ─── REQUEST THROTTLING & TOKEN RATE LIMITER ──────────────────────────────
let lastRequestTime = 0;
const REQUEST_DELAY_MS = 1500; // minimum delay between API calls

// Mistral free tier is much more generous than Anthropic Tier 1.
// We still guard against runaway loops but set a high ceiling.
const TOKEN_LIMIT_PER_MIN = 40000;      // Mistral free tier: ~1 req/sec, high monthly quota
const TOKEN_WINDOW_MS     = 60 * 1000;
const tokenUsage          = [];          // [{ time: ms, tokens: N }, ...]

function pruneTokenUsage() {
  const cutoff = Date.now() - TOKEN_WINDOW_MS;
  while (tokenUsage.length && tokenUsage[0].time < cutoff) tokenUsage.shift();
}
function currentTokenUsage() {
  pruneTokenUsage();
  return tokenUsage.reduce((sum, u) => sum + u.tokens, 0);
}
async function waitForTokenCapacity(estimated) {
  while (true) {
    const used = currentTokenUsage();
    if (used + estimated <= TOKEN_LIMIT_PER_MIN) return;
    // Wait until the oldest entry expires from the window
    const oldest = tokenUsage[0];
    const waitMs = Math.max(500, (oldest.time + TOKEN_WINDOW_MS) - Date.now() + 250);
    console.log(`  ⏳ Token rate guard: ${used}+${estimated} > ${TOKEN_LIMIT_PER_MIN}/min — waiting ${(waitMs/1000).toFixed(1)}s`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}
function recordTokenUsage(tokens) {
  tokenUsage.push({ time: Date.now(), tokens });
}

// ─── API KEY ──────────────────────────────────────────────────────────────────
let API_KEY = '';
try {
  const env = fs.readFileSync(ENV_PATH, 'utf8');
  const m = env.match(/MISTRAL_API_KEY=(.+)/);
  if (m) API_KEY = m[1].trim();
} catch {}

// ─── PORT CLEANUP ─────────────────────────────────────────────────────────────
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `netstat -ano | findstr :${port}`,
        { stdio: 'pipe', shell: true }
      ).toString();
      const lines = out.split('\n').filter(l => l.includes('LISTENING') || l.includes(`0.0.0.0:${port}`) || l.includes(`:::${port}`));
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') {
          try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe', shell: true }); } catch {}
        }
      }
    } else {
      try { execSync(`fuser -k ${port}/tcp`, { stdio: 'pipe' }); } catch {}
    }
  } catch {}
}

function freeAllPorts() {
  for (const p of PORTS) killPort(p);
  // Small pause to let OS release sockets
  const wait = Date.now() + 800;
  while (Date.now() < wait) {}
}

// ─── CLEAR SCREEN ─────────────────────────────────────────────────────────────
function cls() { process.stdout.write('\x1B[2J\x1B[0f'); }

// ─── BANNER ───────────────────────────────────────────────────────────────────
function showBanner() {
  cls();

  // Read campaign state to decide what to show in the box
  let line1 = 'D&D 5e Campaign Launcher';
  let line2 = '';
  let line3 = '';
  try {
    if (fs.existsSync(CAMPAIGN_STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(CAMPAIGN_STATE_PATH, 'utf8'));
      if (s.campaign_id !== 'new-campaign' && s.party && s.party[0]) {
        const r = s.party[0];
        const w = s.world;
        line1 = `${(w.name||'Campaign').slice(0,50)}`;
        line2 = `${r.name} · ${r.class} · Level ${r.level}`;
        line3 = `${(w.current_location||'').slice(0,38)} · ${w.time||''}`;
      }
    }
  } catch {}

  // Pad lines to fit the box (52 chars wide inside)
  const pad = (str) => str.slice(0, 50).padEnd(50);

  console.log('');
  console.log('  ██████╗ ██╗   ██╗██████╗ ██╗██╗  ██╗');
  console.log('  ██╔══██╗██║   ██║██╔══██╗██║██║ ██╔╝');
  console.log('  ██████╔╝██║   ██║██████╔╝██║█████╔╝ ');
  console.log('  ██╔══██╗██║   ██║██╔══██╗██║██╔═██╗ ');
  console.log('  ██║  ██║╚██████╔╝██║  ██║██║██║  ██╗');
  console.log('  ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝');
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║                                                      ║');
  console.log(`  ║   ${pad(line1)}  ║`);
  if (line2) {
  console.log('  ║                                                      ║');
  console.log(`  ║   ${pad(line2)}  ║`);
  console.log(`  ║   ${pad(line3)}  ║`);
  }
  console.log('  ║                                                      ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
}

// ─── QUICK STATE SUMMARY ──────────────────────────────────────────────────────
function showStateSummary() {
  try {
    if (!fs.existsSync(CAMPAIGN_STATE_PATH)) { console.log('  No saved campaign found.\n'); return; }
    const s = JSON.parse(fs.readFileSync(CAMPAIGN_STATE_PATH, 'utf8'));
    const r = s.party && s.party[0];
    if (!r) return;
    const slots = Object.entries(r.spell_slots || {})
      .filter(([,v]) => v.max > 0)
      .map(([k,v]) => `Lv${k.replace('level_','')}: ${v.max-v.used}/${v.max}`)
      .join('  ');
    const cd = r.channel_divinity || { max:1, used:0 };
    const lastEvent = (s.history_log || []).slice(-1)[0];
    console.log(`  ┌─ Saved Campaign ─────────────────────────────────────┐`);
    console.log(`  │  Character : ${(r.name || '').padEnd(38)}│`);
    console.log(`  │  Location  : ${((s.world||{}).current_location||'Unknown').slice(0,38).padEnd(38)}│`);
    console.log(`  │  Time      : ${((s.world||{}).time||'').padEnd(38)}│`);
    const hpMax = r.hp_max || r.hp || 0;
    console.log(`  │  HP        : ${String(r.hp||0).padStart(2)} / ${hpMax}${' '.repeat(33)}│`);
    console.log(`  │  Slots     : ${slots.padEnd(38)}│`);
    console.log(`  │  CD        : ${String(cd.max-cd.used)+'/'+cd.max}${' '.repeat(35)}│`);
    if (lastEvent) {
      const ev = lastEvent.event.slice(0,38);
      console.log(`  │  Last event: ${ev.padEnd(38)}│`);
    }
    console.log(`  └──────────────────────────────────────────────────────┘`);
    console.log('');
  } catch {}
}

// ─── DEFAULT STATE ─────────────────────────────────────────────────────────────
const BLANK_STATE = {
  campaign_id: 'new-campaign',
  world: { name: 'Forgotten Realms', lore_summary: 'New campaign — character creation in progress.',
    current_location: 'Character Creation', time: 'Day 1 — Morning', seal_integrity: 100, seal_status: 'N/A', map_id: null },
  party: [{
    id: 'player', name: 'New Character', class: 'Unset', level: 1, hp: 10, status: 'active',
    spell_slots: { cantrip:{max:0,used:0}, level_1:{max:0,used:0}, level_2:{max:0,used:0}, level_3:{max:0,used:0}, level_4:{max:0,used:0}, level_5:{max:0,used:0} },
    channel_divinity: { max: 0, used: 0 }, inventory: []
  }],
  npcs: [], quests: [], encounters: [],
  history_log: [{ timestamp: new Date().toISOString(), event: 'New campaign started. Begin character creation.' }]
};

// ─── STATE / HISTORY HELPERS ──────────────────────────────────────────────────
// Simple write mutex — prevents concurrent tool calls from racing on campaign_state.json.
// Node.js is single-threaded so this only guards against async interleaving, not true threads.
let _stateLock = false;
let _stateLockQueue = [];
function acquireStateLock() {
  return new Promise(resolve => {
    if (!_stateLock) { _stateLock = true; resolve(); }
    else _stateLockQueue.push(resolve);
  });
}
function releaseStateLock() {
  if (_stateLockQueue.length) { const next = _stateLockQueue.shift(); next(); }
  else _stateLock = false;
}

// In-memory state cache — avoids hitting disk on every tool call in an agentic loop
let _stateCache = null;
let _stateCacheDirty = false;

function loadState() {
  if (_stateCache) return JSON.parse(JSON.stringify(_stateCache)); // cheap clone from cache
  try {
    _stateCache = JSON.parse(fs.readFileSync(CAMPAIGN_STATE_PATH,'utf8'));
    return JSON.parse(JSON.stringify(_stateCache));
  } catch { return JSON.parse(JSON.stringify(BLANK_STATE)); }
}
function saveState(s) {
  _stateCache = JSON.parse(JSON.stringify(s)); // update cache
  fs.writeFileSync(CAMPAIGN_STATE_PATH, JSON.stringify(s,null,2),'utf8');
}
function invalidateStateCache() { _stateCache = null; }

function loadHistory() { try { return JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH,'utf8')); } catch { return {messages:[],created_at:new Date().toISOString(),token_count:0,model:MODEL}; } }
function saveHistory(h){ fs.writeFileSync(CHAT_HISTORY_PATH, JSON.stringify(h,null,2),'utf8'); }
function estimateTokens(t){ return Math.ceil((t||'').length/4); }

// Cache the serialized TOOLS string — it never changes at runtime.
// Avoids JSON.stringify(TOOLS) on every loop iteration (14 tools, ~8KB of JSON).
let _toolsJson = null;
let _toolsTokenCount = 0;
function getToolsJson() {
  // Uses TOOLS_CACHED (defined after TOOLS) — same token count, cached variant sent to API
  if (!_toolsJson) { _toolsJson = JSON.stringify(TOOLS); _toolsTokenCount = estimateTokens(_toolsJson); }
  return { json: _toolsJson, tokens: _toolsTokenCount };
}

// ─── STATE VALIDATION ─────────────────────────────────────────────────────────
// Validate an incoming state object before writing to disk (used by POST /api/state).
// Returns null if valid, or an error string if invalid.
function validateState(s) {
  if (!s || typeof s !== 'object')          return 'State must be an object';
  if (!s.party || !Array.isArray(s.party))  return 'State must have a party array';
  if (!s.party[0])                          return 'Party must have at least one member';
  const p = s.party[0];
  if (p.hp != null && typeof p.hp !== 'number')     return 'party[0].hp must be a number';
  if (p.hp_max != null && p.hp < 0)                 return 'HP cannot be negative';
  if (p.hp_max != null && p.hp > p.hp_max + 50)     return `HP ${p.hp} exceeds hp_max ${p.hp_max} by too much`;
  if (p.spell_slots && typeof p.spell_slots === 'object') {
    for (const [k, v] of Object.entries(p.spell_slots)) {
      if (v.used != null && v.max != null && v.used > v.max + 1) // +1 tolerance for edge cases
        return `spell_slots.${k}.used (${v.used}) exceeds max (${v.max})`;
    }
  }
  return null; // valid
}

// ─── SAVES PRUNING ────────────────────────────────────────────────────────────
const MAX_SAVES = 30;
function pruneSaves() {
  try {
    ensureSavesDir();
    const files = fs.readdirSync(SAVES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, mtime: fs.statSync(path.join(SAVES_DIR,f)).mtimeMs }))
      .sort((a,b) => b.mtime - a.mtime);
    const toDelete = files.slice(MAX_SAVES);
    for (const { f } of toDelete) {
      try { fs.unlinkSync(path.join(SAVES_DIR,f)); console.log(`  ✓ Pruned old save: ${f}`); } catch {}
    }
  } catch {}
}

// ─── DICE ─────────────────────────────────────────────────────────────────────
// expr supports: "d20", "2d6+3", "d20 advantage", "d20 disadvantage"
function rollDice(expr) {
  const lower = (expr||'').toLowerCase();
  const hasAdv = lower.includes('advantage') && !lower.includes('disadvantage');
  const hasDis = lower.includes('disadvantage');
  const clean  = expr.replace(/advantage|disadvantage/gi,'').trim();
  const m = clean.match(/(\d+)?d(\d+)([+-]\d+)?/i);
  if (!m) return { total:0, breakdown:`Invalid: ${expr}` };
  const num=parseInt(m[1]||'1'), sides=parseInt(m[2]), mod=parseInt(m[3]||'0');

  let rolls, usedRolls, kept;
  if ((hasAdv || hasDis) && num === 1 && sides === 20) {
    // Roll 2d20, keep highest (adv) or lowest (dis)
    const r1 = Math.floor(Math.random()*20)+1;
    const r2 = Math.floor(Math.random()*20)+1;
    kept = hasAdv ? Math.max(r1,r2) : Math.min(r1,r2);
    rolls = [kept]; usedRolls = [r1, r2];
    const advLabel = hasAdv ? 'advantage' : 'disadvantage';
    const total = kept + mod;
    const bd = `[${r1}, ${r2}] → keep ${kept} (${advLabel})${mod!==0?(mod>=0?` + ${mod}`:` ${mod}`):''}  = **${total}**`;
    return {total, rolls:[kept], modifier:mod, breakdown:bd, advDis: advLabel};
  }
  rolls = Array.from({length:num}, ()=>Math.floor(Math.random()*sides)+1);
  const total = rolls.reduce((a,b)=>a+b,0) + mod;
  const bd = mod!==0 ? `[${rolls.join(', ')}]${mod>=0?` + ${mod}`:` ${mod}`} = **${total}**` : `[${rolls.join(', ')}] = **${total}**`;
  return {total, rolls, modifier:mod, breakdown:bd};
}

// ─── PROFICIENCY BONUS ────────────────────────────────────────────────────────
// Correct D&D 5e table: +2 at 1-4, +3 at 5-8, +4 at 9-12, +5 at 13-16, +6 at 17-20
function profBonus(level) {
  return Math.floor((level - 1) / 4) + 2;
}

// ─── TOOLS ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {name:'roll_dice',description:'Roll dice for any D&D check. ALWAYS use this for every dice roll. Append "advantage" or "disadvantage" to a d20 expression (e.g. "d20 advantage") to roll 2d20 and keep highest/lowest.',
   input_schema:{type:'object',properties:{expression:{type:'string',description:'e.g. "d20", "2d6+3", "d20 advantage", "d20 disadvantage"'},purpose:{type:'string'}},required:['expression','purpose']}},
  {name:'update_hp',description:"Update the character's current HP after damage or healing.",
   input_schema:{type:'object',properties:{hp:{type:'number'},reason:{type:'string'}},required:['hp','reason']}},
  {name:'use_spell_slot',description:'Spend a spell slot when a leveled spell is cast.',
   input_schema:{type:'object',properties:{level:{type:'number'},spell_name:{type:'string'}},required:['level','spell_name']}},
  {name:'use_channel_divinity',description:'Spend Channel Divinity.',
   input_schema:{type:'object',properties:{ability:{type:'string'}},required:['ability']}},
  {name:'restore_resources',description:'Restore resources after a long or short rest. For short rest you can optionally spend hit dice for healing.',
   input_schema:{type:'object',properties:{rest_type:{type:'string',enum:['long_rest','short_rest']},hit_dice_spent:{type:'number',description:'Number of hit dice spent during short rest (optional)'}},required:['rest_type']}},
  {name:'add_inventory_item',description:"Add an item to the character's inventory.",
   input_schema:{type:'object',properties:{name:{type:'string'},quantity:{type:'number'},rarity:{type:'string',enum:['common','uncommon','rare','very rare','legendary']}},required:['name','quantity','rarity']}},
  {name:'remove_inventory_item',description:'Remove or consume an inventory item.',
   input_schema:{type:'object',properties:{name:{type:'string'},quantity:{type:'number'}},required:['name','quantity']}},
  {name:'complete_quest_step',description:'Mark a quest step as completed. Use the quest title (or partial) and step description (or partial) — exact IDs not needed.',
   input_schema:{type:'object',properties:{quest_title:{type:'string',description:'Quest title (partial match ok)'},step_description:{type:'string',description:'Step description (partial match ok)'}},required:['quest_title','step_description']}},
  {name:'add_condition',description:'Apply a condition to the character (e.g. Poisoned, Frightened, Prone, Blinded, Restrained, Incapacitated, Concentrating on <spell>).',
   input_schema:{type:'object',properties:{condition:{type:'string'}},required:['condition']}},
  {name:'remove_condition',description:'Remove a condition from the character.',
   input_schema:{type:'object',properties:{condition:{type:'string',description:'Condition name (partial match ok)'}},required:['condition']}},
  {name:'append_history_log',description:'Record a significant narrative event.',
   input_schema:{type:'object',properties:{event:{type:'string'}},required:['event']}},
  {name:'end_session',description:'End the session, write a narrative journal entry, sync context file, commit and push to GitHub.',
   input_schema:{type:'object',properties:{summary:{type:'string',description:'One-line session summary for the git commit message.'},recap:{type:'string',description:'2-3 paragraph narrative journal entry written in vivid prose from the DM perspective, describing what happened this session — key events, decisions, dramatic moments, and how it ends. Written like a campaign diary, not a bullet list.'}},required:['summary','recap']}},
  {name:'set_music_scene',description:"Change the dashboard's background music to match the current narrative mood. Call this whenever the tone shifts: entering combat, arriving at a tavern, taking a rest, dramatic silence, etc.",
   input_schema:{type:'object',properties:{scene:{type:'string',enum:['exploration','combat','rest','tavern','silence'],description:'exploration=travel/adventure, combat=battle/tension, rest=safe downtime/camp, tavern=social/inn, silence=dramatic pause'}},required:['scene']}},
  {name:'start_combat',description:'Initiate combat encounter. Opens combat tracker on dashboard with enemy list.',
   input_schema:{type:'object',properties:{enemies:{type:'array',items:{type:'object',properties:{name:{type:'string'},hp:{type:'number'},initiative:{type:'number'}},required:['name','hp','initiative']},description:'List of enemies in combat. Each enemy has name, hp (max), and initiative.'}},required:['enemies']}},
  {name:'add_npc',description:'Add a new NPC to the world tracker. Call whenever the player meets someone significant.',
   input_schema:{type:'object',properties:{
     name:{type:'string'},role:{type:'string'},
     disposition:{type:'string',enum:['friendly','neutral','hostile','contained','recovering']},
     notes:{type:'string',description:'Key details, personality, what they know'},
     location:{type:'string'}
   },required:['name','role','disposition','notes']}},
  {name:'update_npc',description:'Update an existing NPC — change disposition, notes, or location after events shift your relationship.',
   input_schema:{type:'object',properties:{
     name:{type:'string',description:'NPC name (partial match ok)'},
     disposition:{type:'string',enum:['friendly','neutral','hostile','contained','recovering']},
     notes:{type:'string'},location:{type:'string'}
   },required:['name']}},
  {name:'add_quest',description:'Add a new quest or objective to the quest tracker.',
   input_schema:{type:'object',properties:{
     title:{type:'string'},description:{type:'string'},giver:{type:'string'},
     steps:{type:'array',items:{type:'string'},description:'List of objective descriptions'}
   },required:['title','description','steps']}},
  {name:'update_location',description:'Move the character to a new location and/or advance time. Call whenever travel or a scene transition occurs.',
   input_schema:{type:'object',properties:{
     location:{type:'string',description:'New current location'},
     time:{type:'string',description:'New time, e.g. "Day 3 — Evening"'},
     lore:{type:'string',description:'Optional update to world lore summary'},
     map_id:{type:'string',description:'Optional dashboard map key to switch the map view (e.g. "campaign")'}
   },required:['location']}},
  {name:'death_save',description:'Record a death saving throw result when the character is at 0 HP. The character needs 3 successes to stabilize or 3 failures to die. Roll 1d20 first (10+ = success).',
   input_schema:{type:'object',properties:{
     result:{type:'string',enum:['success','failure','nat20','nat1'],description:'success=rolled 10+, failure=rolled 9 or less, nat20=rolled 20 (regain 1HP), nat1=rolled 1 (counts as 2 failures)'}
   },required:['result']}},
  {name:'skill_check',description:'Resolve a skill or ability check against a DC. Roll dice first, then call this to record the outcome and narrate accordingly.',
   input_schema:{type:'object',properties:{
     skill:{type:'string',description:'Skill or ability checked, e.g. "Perception", "Stealth", "Strength"'},
     dc:{type:'number',description:'Difficulty Class (e.g. 10=Easy, 15=Medium, 20=Hard, 25=Very Hard)'},
     roll_total:{type:'number',description:'The final roll result (die + modifiers)'},
     outcome:{type:'string',enum:['success','failure','critical_success','critical_failure']}
   },required:['skill','dc','roll_total','outcome']}},
  {name:'set_concentration',description:'Set or clear a concentration spell. Casting a new concentration spell automatically drops the previous one.',
   input_schema:{type:'object',properties:{
     spell:{type:'string',description:'Spell name being concentrated on, or null/empty to clear concentration'},
   },required:[]}},
  {name:'award_xp',description:'Award XP to the character and automatically level up if the XP threshold is reached. Call after combat victories, quest completions, or significant milestones.',
   input_schema:{type:'object',properties:{
     amount:{type:'number',description:'XP to award'},
     reason:{type:'string',description:'Why the XP was earned'}
   },required:['amount','reason']}},
  {name:'set_weather',description:'Set the current weather for the campaign world. Call when weather changes or is relevant to the scene. Displayed on the dashboard map overlay.',
   input_schema:{type:'object',properties:{
     condition:{type:'string',enum:['clear','cloudy','overcast','light_rain','heavy_rain','thunderstorm','fog','snow','blizzard','heatwave','magical'],description:'Weather condition'},
     description:{type:'string',description:'Optional flavour text, e.g. "A cold drizzle patters on the cobblestones"'}
   },required:['condition']}},
  {name:'roll_encounter',description:'Roll a random encounter appropriate for the current terrain and party level. Call when players are traveling or when you want to add tension.',
   input_schema:{type:'object',properties:{
     terrain:{type:'string',enum:['road','forest','dungeon','mountain','coastal','urban','plains','swamp','underdark'],description:'Current terrain type'},
     difficulty:{type:'string',enum:['easy','medium','hard','deadly'],description:'Encounter difficulty, default medium'}
   },required:['terrain']}},
  {name:'create_character',description:'Call this once character creation is COMPLETE. Populates the full character sheet and starts the campaign. Spell slots are auto-computed from class and level.',
   input_schema:{type:'object',
     properties:{
       name:{type:'string',description:'Character name'},
       race:{type:'string'},
       class:{type:'string',description:'Full class name, e.g. "Wizard (Divination)" or "Fighter (Battle Master)"'},
       level:{type:'number',description:'Starting level (usually 1)'},
       hp:{type:'number',description:'Starting max HP'},
       background:{type:'string'},
       alignment:{type:'string'},
       stats:{type:'object',description:'Ability scores',
         properties:{str:{type:'number'},dex:{type:'number'},con:{type:'number'},int:{type:'number'},wis:{type:'number'},cha:{type:'number'}},
         required:['str','dex','con','int','wis','cha']},
       ac:{type:'number',description:'Armor class'},
       ac_notes:{type:'string',description:'e.g. "Chain mail + shield"'},
       speed:{type:'number',description:'Movement speed in feet, default 30'},
       saving_throw_profs:{type:'array',items:{type:'string'},description:'Stat keys with saving throw proficiency, e.g. ["str","con"]'},
       skill_profs:{type:'array',items:{type:'string'},description:'Skill names with proficiency, e.g. ["Athletics","Perception"]'},
       traits:{type:'array',items:{type:'string'},description:'Class features, racial traits, and background features'},
       spells:{type:'object',description:'Spells known by category',
         properties:{
           cantrips:{type:'array',items:{type:'string'}},
           level_1:{type:'array',items:{type:'string'}},
           level_2:{type:'array',items:{type:'string'}},
           level_3:{type:'array',items:{type:'string'}}
         }},
       description:{type:'string',description:'Physical appearance and personality in 1-3 sentences'},
       inventory:{type:'array',items:{type:'object',properties:{name:{type:'string'},quantity:{type:'number'},rarity:{type:'string'}}}},
       campaign_setting:{type:'string',description:'World/setting name, e.g. "Forgotten Realms"'},
       campaign_lore:{type:'string',description:'1-2 sentence campaign premise for the DM to remember'},
       starting_location:{type:'string',description:'Where the adventure begins'}
     },
     required:['name','class','level','hp','stats']}}
];

// Mistral/OpenAI function-calling format wraps each tool in {type:'function', function:{...}}
// and uses 'parameters' instead of 'input_schema'.
const MISTRAL_TOOLS = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema }
}));

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────
function executeTool(name, input) {
  const state = loadState();
  switch (name) {
    case 'roll_dice': { const r=rollDice(input.expression); return {rolled:input.expression,purpose:input.purpose,result:r.breakdown,total:r.total,dice_rolled:true}; }
    case 'update_hp': { const hpMax=state.party[0].hp_max||state.party[0].hp||27; const hp=Math.max(0,Math.min(hpMax,Math.round(input.hp))); state.party[0].hp=hp; state.history_log.push({timestamp:new Date().toISOString(),event:input.reason}); saveState(state); return {success:true,hp,state_updated:true}; }
    case 'use_spell_slot': { const slots=state.party[0].spell_slots; const key=`level_${input.level}`; if(!slots[key]||slots[key].used>=slots[key].max) return {error:`No level ${input.level} slots remaining`}; slots[key].used++; state.history_log.push({timestamp:new Date().toISOString(),event:`Cast ${input.spell_name} (Lv${input.level}). ${slots[key].max-slots[key].used}/${slots[key].max} remaining.`}); saveState(state); return {success:true,remaining:slots[key].max-slots[key].used,state_updated:true}; }
    case 'use_channel_divinity': { const cd=state.party[0].channel_divinity; if(cd.used>=cd.max) return {error:'No Channel Divinity remaining'}; cd.used++; state.history_log.push({timestamp:new Date().toISOString(),event:`Used Channel Divinity: ${input.ability}`}); saveState(state); return {success:true,remaining:cd.max-cd.used,state_updated:true}; }
    case 'restore_resources': {
      const r=state.party[0];
      const isWarlock=/warlock/i.test(r.class||'');
      if(input.rest_type==='long_rest'){
        // Long rest: full restore for all classes
        for(const k of Object.keys(r.spell_slots||{})) r.spell_slots[k].used=0;
        if(r.channel_divinity) r.channel_divinity.used=0;
        // Restore hit dice (regain up to half max on long rest, min 1)
        if(r.hit_dice_total!=null){
          const regain=Math.max(1,Math.floor(r.hit_dice_total/2));
          r.hit_dice_used=Math.max(0,(r.hit_dice_used||0)-regain);
        }
        r.hp=r.hp_max||r.hp;
        if(r.conditions) r.conditions=r.conditions.filter(c=>!/prone|frightened|invisible/i.test(c)); // clear short-duration conditions
        state.history_log.push({timestamp:new Date().toISOString(),event:'Long rest — all resources restored, HP full.'});
      } else {
        // Short rest: Warlocks recover ALL pact slots; others just CD
        if(isWarlock) for(const k of Object.keys(r.spell_slots||{})) r.spell_slots[k].used=0;
        if(r.channel_divinity) r.channel_divinity.used=0;
        // Spend hit dice for healing if provided
        if(input.hit_dice_spent){
          const hd=parseInt(input.hit_dice_spent)||0;
          const used=(r.hit_dice_used||0)+hd;
          const max=r.hit_dice_total||r.level||1;
          r.hit_dice_used=Math.min(used,max);
        }
        state.history_log.push({timestamp:new Date().toISOString(),event:`Short rest — ${isWarlock?'Warlock pact slots recovered. ':''}Channel Divinity restored.`});
      }
      saveState(state); return {success:true,state_updated:true};
    }
    case 'add_inventory_item': { const inv=state.party[0].inventory; const ex=inv.find(i=>i.name.toLowerCase()===input.name.toLowerCase()); if(ex)ex.quantity+=input.quantity;else inv.push({name:input.name,quantity:input.quantity,rarity:input.rarity}); state.history_log.push({timestamp:new Date().toISOString(),event:`Acquired: ${input.name} ×${input.quantity}`}); saveState(state); return {success:true,state_updated:true}; }
    case 'remove_inventory_item': { const inv=state.party[0].inventory; const idx=inv.findIndex(i=>i.name.toLowerCase()===input.name.toLowerCase()); if(idx===-1)return {error:`"${input.name}" not in inventory`}; inv[idx].quantity-=input.quantity; if(inv[idx].quantity<=0)inv.splice(idx,1); state.history_log.push({timestamp:new Date().toISOString(),event:`Used/removed: ${input.name} ×${input.quantity}`}); saveState(state); return {success:true,state_updated:true}; }
    case 'complete_quest_step': {
      // Fuzzy match on quest title then step description
      const qtNeedle=(input.quest_title||input.quest_id||'').toLowerCase();
      const stNeedle=(input.step_description||input.step_id||'').toLowerCase();
      const quest=state.quests.find(q=>q.title.toLowerCase().includes(qtNeedle)||q.id.includes(qtNeedle));
      if(!quest)return {error:`Quest matching "${input.quest_title||input.quest_id}" not found. Active quests: ${state.quests.filter(q=>q.status==='active').map(q=>q.title).join(', ')}`};
      const step=quest.steps.find(s=>s.description.toLowerCase().includes(stNeedle)||(s.step_id||'').includes(stNeedle));
      if(!step)return {error:`Step matching "${stNeedle}" not found in "${quest.title}". Steps: ${quest.steps.map(s=>s.description).join(' | ')}`};
      step.completed=true;
      if(quest.steps.every(s=>s.completed)){quest.status='completed';state.history_log.push({timestamp:new Date().toISOString(),event:`Quest COMPLETED: "${quest.title}"`});}
      else{state.history_log.push({timestamp:new Date().toISOString(),event:`Quest step completed: "${step.description}" (${quest.title})`});}
      saveState(state); return {success:true,quest_completed:quest.steps.every(s=>s.completed),state_updated:true};
    }
    case 'add_condition': {
      const char=state.party[0];
      if(!char.conditions)char.conditions=[];
      if(!char.conditions.find(c=>c.toLowerCase()===input.condition.toLowerCase()))
        char.conditions.push(input.condition);
      state.history_log.push({timestamp:new Date().toISOString(),event:`Condition applied: ${input.condition}`});
      saveState(state); return {success:true,conditions:char.conditions,state_updated:true};
    }
    case 'remove_condition': {
      const char=state.party[0];
      if(!char.conditions)char.conditions=[];
      const needle=input.condition.toLowerCase();
      const before=char.conditions.length;
      char.conditions=char.conditions.filter(c=>!c.toLowerCase().includes(needle));
      if(char.conditions.length===before)return {error:`Condition matching "${input.condition}" not found. Active: ${char.conditions.join(', ')||'none'}`};
      state.history_log.push({timestamp:new Date().toISOString(),event:`Condition removed: ${input.condition}`});
      saveState(state); return {success:true,conditions:char.conditions,state_updated:true};
    }
    case 'add_npc': {
      const npcId=(input.name||'npc').toLowerCase().replace(/[^a-z0-9]+/g,'-');
      // Check for duplicate — update instead of creating a second copy
      const existing=state.npcs.find(n=>n.name.toLowerCase()===input.name.toLowerCase()||n.id===npcId);
      if(existing){
        if(input.disposition)existing.disposition=input.disposition;
        if(input.notes)existing.notes=(existing.notes?existing.notes+' | ':'')+input.notes;
        if(input.location)existing.location=input.location;
        state.history_log.push({timestamp:new Date().toISOString(),event:`Updated existing NPC: ${input.name}.`});
        saveState(state); return {success:true,updated:true,state_updated:true};
      }
      const npc = { id:npcId, name:input.name, role:input.role, disposition:input.disposition, notes:input.notes, location:input.location||state.world.current_location };
      state.npcs.push(npc);
      state.history_log.push({timestamp:new Date().toISOString(),event:`Met ${input.name} (${input.role}) — ${input.disposition}.`});
      saveState(state); return {success:true,state_updated:true};
    }
    case 'update_npc': {
      const needle=(input.name||'').toLowerCase();
      const npc=state.npcs.find(n=>n.name.toLowerCase().includes(needle)||(n.id||'').includes(needle));
      if(!npc)return {error:`NPC "${input.name}" not found. Known NPCs: ${state.npcs.map(n=>n.name).join(', ')||'none'}`};
      const old=npc.disposition;
      if(input.disposition)npc.disposition=input.disposition;
      // Append notes — don't overwrite; use " | " as separator
      if(input.notes)npc.notes=(npc.notes?npc.notes+' | ':'')+input.notes;
      if(input.location)npc.location=input.location;
      const changes=[];
      if(input.disposition&&input.disposition!==old)changes.push(`disposition ${old}→${input.disposition}`);
      if(input.notes)changes.push(`notes: ${input.notes.slice(0,60)}`);
      if(input.location)changes.push(`location→${input.location}`);
      state.history_log.push({timestamp:new Date().toISOString(),event:`${npc.name}: ${changes.join('; ')}.`});
      saveState(state); return {success:true,state_updated:true};
    }
    case 'add_quest': {
      const qid=(input.title||'quest').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,30);
      const steps=(input.steps||[]).map((s,i)=>({step_id:`${qid}-${i+1}`,description:s,completed:false}));
      const quest={id:qid,title:input.title,description:input.description,giver:input.giver||'Unknown',status:'active',steps};
      state.quests.push(quest);
      state.history_log.push({timestamp:new Date().toISOString(),event:`Quest added: "${input.title}" (${steps.length} steps).`});
      saveState(state); return {success:true,quest_id:qid,state_updated:true};
    }
    case 'update_location': {
      state.world.current_location=input.location;
      if(input.time)state.world.time=input.time;
      if(input.lore)state.world.lore_summary=input.lore;
      if(input.map_id!==undefined)state.world.map_id=input.map_id;
      state.history_log.push({timestamp:new Date().toISOString(),event:`Moved to ${input.location}${input.time?' — '+input.time:''}.`});
      saveState(state); return {success:true,state_updated:true};
    }
    case 'death_save': {
      const p=state.party[0];
      if(!p.death_saves) p.death_saves={successes:0,failures:0,stable:false};
      const ds=p.death_saves; let msg='';
      if(input.result==='nat20'){ p.hp=1; ds.successes=0; ds.failures=0; ds.stable=true; p.conditions=(p.conditions||[]).filter(c=>!/unconscious|dying/i.test(c)); msg='Natural 20! Character regains 1 HP and stands up.'; }
      else if(input.result==='nat1'){ ds.failures=Math.min(3,ds.failures+2); msg=`Natural 1! Two failures (${ds.failures}/3).`; }
      else if(input.result==='success'){ ds.successes=Math.min(3,ds.successes+1); if(ds.successes>=3){ds.stable=true;if(!p.conditions)p.conditions=[];p.conditions=p.conditions.filter(c=>!/dying/i.test(c));p.conditions.push('Stable');} msg=`Death save success ${ds.successes}/3.${ds.successes>=3?' Character stabilizes!':''}`; }
      else { ds.failures=Math.min(3,ds.failures+1); msg=`Death save failure ${ds.failures}/3.${ds.failures>=3?' CHARACTER DIES.':''}`; }
      if(ds.failures>=3&&!ds.stable){ p.status='dead'; p.conditions=['Dead']; msg+=' The character has died.'; }
      state.history_log.push({timestamp:new Date().toISOString(),event:msg});
      saveState(state); return {success:true,death_saves:ds,status:p.status,message:msg,state_updated:true};
    }
    case 'skill_check': {
      const succeeded=input.outcome==='success'||input.outcome==='critical_success';
      state.history_log.push({timestamp:new Date().toISOString(),event:`${input.skill} check DC${input.dc}: rolled ${input.roll_total} — ${succeeded?'SUCCESS':'FAILURE'}.`});
      saveState(state); return {success:true,passed:succeeded};
    }
    case 'set_concentration': {
      const p=state.party[0]; if(!p.conditions)p.conditions=[];
      // Drop previous concentration
      p.conditions=p.conditions.filter(c=>!/^concentrating on/i.test(c));
      if(input.spell){ p.conditions.push(`Concentrating on ${input.spell}`); state.history_log.push({timestamp:new Date().toISOString(),event:`Concentrating on ${input.spell}.`}); }
      else { state.history_log.push({timestamp:new Date().toISOString(),event:'Concentration dropped.'}); }
      saveState(state); return {success:true,conditions:p.conditions,state_updated:true};
    }
    case 'award_xp': {
      const p=state.party[0];
      // Standard 5e XP thresholds per level (level 1-20)
      const XP_THRESHOLDS=[0,300,900,2700,6500,14000,23000,34000,48000,64000,85000,100000,120000,140000,165000,195000,225000,265000,305000,355000];
      if(!p.xp) p.xp=0;
      p.xp+=input.amount;
      state.history_log.push({timestamp:new Date().toISOString(),event:`Awarded ${input.amount} XP — ${input.reason}. Total: ${p.xp} XP.`});
      // Check level-up
      const nextLvl=Math.min(20,(p.level||1)+1);
      let leveled=false;
      if(nextLvl<=20 && p.xp>=XP_THRESHOLDS[nextLvl-1]){
        p.level=nextLvl; p.proficiency_bonus=profBonus(nextLvl);
        // Recalculate hit dice
        if(p.hit_dice_total!=null) p.hit_dice_total=nextLvl;
        state.history_log.push({timestamp:new Date().toISOString(),event:`LEVEL UP! Now Level ${nextLvl}. Proficiency bonus +${profBonus(nextLvl)}.`});
        leveled=true;
      }
      saveState(state); return {success:true,xp:p.xp,level:p.level,leveled,state_updated:true};
    }
    case 'append_history_log': { state.history_log.push({timestamp:new Date().toISOString(),event:input.event}); saveState(state); return {success:true}; }
    case 'set_music_scene': { return {success:true, scene:input.scene, music_scene:true}; }
    case 'set_weather': {
      if (!state.world) state.world = {};
      state.world.weather = { condition: input.condition, description: input.description || '' };
      state.history_log.push({timestamp:new Date().toISOString(),event:`Weather changed to ${input.condition}${input.description?' — '+input.description:''}`});
      saveState(state);
      return {success:true, weather:state.world.weather, state_updated:true};
    }
    case 'roll_encounter': {
      const ENCOUNTERS = {
        road:    ['Traveling merchants (3 guards)', 'Bandits demanding toll (roll Persuasion DC 14 or fight)', 'Injured traveler needing aid', 'Wandering beast: wolf pack (4)', 'Royal messenger on urgent errand', 'Broken-down cart blocking road'],
        forest:  ['Giant spiders dropping from canopy (2)', 'Druid tending wounded animal — potential ally', 'Owlbear territory marker — fresh kills nearby', 'Pixie mischief — small items go missing', 'Ancient shrine, crumbling, faint magical aura', 'Goblin hunting party (5, including shaman)'],
        dungeon: ['Gelatinous cube — silent and nearly invisible', 'Skeleton patrol (4)', 'Trapped chest with poison needle', 'Rival adventuring party — hostile or cooperative', 'Giant rats nesting in collapsed chamber (6)', 'Cultist ritual in progress'],
        mountain:['Stone giant scouting territory', 'Harpy nest above a narrow pass', 'Avalanche risk — Dexterity DC 15 or 4d6 damage', 'Griffon hunting party', 'Mountain hermit with cryptic knowledge', 'Hidden dwarven outpost, abandoned'],
        coastal: ['Sahuagin raid on fishing village', 'Merfolk warning of sea hag territory', 'Shipwreck with survivors — and a monster', 'Pirates seeking crew (or victims)', 'Giant crab emerging from surf (2)', 'Storm rolls in — find shelter or take damage'],
        urban:   ['Pickpocket (Dexterity contest)', 'City watch patrol — papers check', 'Flash mob / riot breaking out', 'Assassination attempt on nearby noble', 'Black market dealer with rare item', 'Fire in a crowded district'],
        plains:  ['Gnoll war band on the move (6)', 'Wild horse herd — potential mounts', 'Wyvern circling overhead', 'Merchant caravan willing to share camp', 'Ancient battlefield — restless spirits at night', 'Scarecrow that isn\'t quite right'],
        swamp:   ['Will-o-wisp leading astray — Wisdom DC 13', 'Lizardfolk patrol (4) defending territory', 'Quicksand — Strength DC 12 to escape', 'Hag\'s cottage — smoke rising, door ajar', 'Zombie ambush from murky water (6)', 'Giant crocodile sunning on bank'],
        underdark:['Drow patrol (4, hostile)', 'Myconid colony — peaceful but alien', 'Purple worm burrow crossing nearby — tremors', 'Aboleth psychic lure — Wisdom save DC 15', 'Duergar slavers with captured surface dwellers', 'Bioluminescent cave with hidden shrine']
      };
      const terrain = input.terrain || 'road';
      const table = ENCOUNTERS[terrain] || ENCOUNTERS.road;
      const roll = Math.floor(Math.random() * table.length);
      const encounter = table[roll];
      const diff = input.difficulty || 'medium';
      state.history_log.push({timestamp:new Date().toISOString(),event:`Random encounter (${terrain}, ${diff}): ${encounter}`});
      saveState(state);
      return {success:true, terrain, difficulty:diff, encounter, roll: roll+1, table_size: table.length};
    }
    case 'start_combat': {
      const enemies = input.enemies || [];
      state.history_log.push({timestamp:new Date().toISOString(),event:`Combat started with ${enemies.map(e=>e.name).join(', ')}`});
      saveState(state);
      return {success:true,combat_started:true,enemies:enemies};
    }
    case 'end_session': {
      const messages = [];
      // 1. Write journal entry
      try {
        if (input.recap) {
          const st=loadState(); const world=st.world; const char=st.party&&st.party[0];
          const charName=char?char.name:'Adventurer';
          const date=new Date().toISOString().slice(0,10);
          const header=`\n---\n\n## ${world.time} | ${date}\n*${world.current_location}*\n\n`;
          const entry=header+input.recap.trim()+'\n';
          if (!fs.existsSync(JOURNAL_PATH)) fs.writeFileSync(JOURNAL_PATH,`# ${charName} — Campaign Journal\n`,'utf8');
          fs.appendFileSync(JOURNAL_PATH,entry,'utf8');
          messages.push('Journal written.');
        }
      } catch(e) { messages.push(`Journal error: ${e.message}`); }
      // 2. Sync context file
      try { updateContextFile(loadState()); messages.push('Context synced.'); } catch(e) { messages.push(`Context error: ${e.message}`); }
      // 3. Git commit (separate from push — commit works offline)
      try {
        execSync('git add -A', {cwd:APP_DIR,stdio:'pipe'});
        const msg=(input.summary||'Session end').replace(/"/g,"'").replace(/\n/g,' ').slice(0,120);
        execSync(`git commit -m "Session end: ${msg}"`, {cwd:APP_DIR,stdio:'pipe'});
        messages.push('Committed.');
      } catch(e) {
        const out=(e.stdout||e.stderr||'').toString();
        if(out.includes('nothing to commit')) messages.push('Nothing new to commit.');
        else messages.push(`Commit error: ${out.slice(0,120)}`);
      }
      // 4. Git push (optional — skip if no remote)
      try {
        const remotes=execSync('git remote',{cwd:APP_DIR,stdio:'pipe'}).toString().trim();
        if(remotes) {
          execSync('git push', {cwd:APP_DIR,stdio:'pipe'});
          messages.push('Pushed to GitHub.');
        } else { messages.push('No remote configured — skipped push.'); }
      } catch(e) { messages.push(`Push error: ${(e.stdout||e.stderr||'').toString().slice(0,100)}`); }
      return {success:true, message:messages.join(' ')};
    }
    case 'create_character': {
      // ── Spell slot table by class + level ──────────────────────
      const FULL_CASTER = /wizard|sorcerer|bard|druid|cleric/i;
      const HALF_CASTER = /paladin|ranger/i;
      const WARLOCK     = /warlock/i;
      const cls = input.class || '';
      const lvl = input.level || 1;
      let slotTable = {};
      if (WARLOCK.test(cls)) {
        const pact = Math.min(lvl, 4);
        const wSlots = [[],[2],[2],[2],[2],[3],[3],[3],[3],[3],[4]];
        const wLevel = lvl<=4?1:lvl<=6?2:lvl<=8?3:lvl<=9?4:5;
        slotTable = { [`level_${wLevel}`]: { max: wSlots[lvl]||2, used: 0 } };
      } else if (FULL_CASTER.test(cls)) {
        const table = [
          {},
          {1:{max:2}},{1:{max:3}},{1:{max:4},2:{max:2}},{1:{max:4},2:{max:3}},
          {1:{max:4},2:{max:3},3:{max:2}},{1:{max:4},2:{max:3},3:{max:3}},
          {1:{max:4},2:{max:3},3:{max:3},4:{max:1}},{1:{max:4},2:{max:3},3:{max:3},4:{max:2}},
          {1:{max:4},2:{max:3},3:{max:3},4:{max:3},5:{max:1}},{1:{max:4},2:{max:3},3:{max:3},4:{max:3},5:{max:2}}
        ];
        slotTable = table[Math.min(lvl,10)] || {};
        for (const k of Object.keys(slotTable)) slotTable[k].used = 0;
      } else if (HALF_CASTER.test(cls)) {
        const table = [
          {},{},{1:{max:2}},{1:{max:3}},{1:{max:3}},{1:{max:4},2:{max:2}},
          {1:{max:4},2:{max:2}},{1:{max:4},2:{max:3}},{1:{max:4},2:{max:3}},
          {1:{max:4},2:{max:3},3:{max:2}},{1:{max:4},2:{max:3},3:{max:2}}
        ];
        slotTable = table[Math.min(lvl,10)] || {};
        for (const k of Object.keys(slotTable)) slotTable[k].used = 0;
      }
      // Merge with cantrip count
      const cantripCount = /wizard|sorcerer/i.test(cls)?3:/bard|cleric|druid|warlock/i.test(cls)?2:0;
      if (cantripCount) slotTable.cantrip = { max: cantripCount, used: 0 };

      // ── Build full spell_slots object ───────────────────────────
      const fullSlots = { cantrip:{max:0,used:0},level_1:{max:0,used:0},level_2:{max:0,used:0},level_3:{max:0,used:0},level_4:{max:0,used:0},level_5:{max:0,used:0} };
      for (const [k,v] of Object.entries(slotTable)) {
        if (fullSlots[k]) fullSlots[k] = v;
        else fullSlots[k] = v;
      }

      // ── Proficiency bonus (correct 5e table) ───────────────────
      const prof = profBonus(lvl);

      // ── Build campaign_id from character name ───────────────────
      const slug = (input.name||'character').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      const campaignId = `${slug}-campaign`;

      // ── Build the new state ─────────────────────────────────────
      const newState = {
        campaign_id: campaignId,
        world: {
          name: input.campaign_setting || 'Forgotten Realms',
          lore_summary: input.campaign_lore || 'A new adventure begins.',
          current_location: input.starting_location || 'Starting Town',
          time: 'Day 1 — Morning',
          seal_integrity: 100,
          seal_status: 'N/A',
          map_id: null
        },
        party: [{
          id: slug,
          name: input.name,
          race: input.race || 'Human',
          class: input.class,
          level: lvl,
          hp: input.hp,
          hp_max: input.hp,
          hit_dice_total: lvl,   // one hit die per level
          hit_dice_used: 0,
          xp: 0,
          death_saves: { successes: 0, failures: 0, stable: false },
          status: 'active',
          background: input.background || '',
          alignment: input.alignment || '',
          stats: { str:10,dex:10,con:10,int:10,wis:10,cha:10, ...input.stats },
          ac: input.ac || 10,
          ac_notes: input.ac_notes || '',
          speed: input.speed || 30,
          proficiency_bonus: prof,
          initiative_bonus: Math.floor(((input.stats||{}).dex||10) - 10) / 2,
          passive_perception: 10 + Math.floor(((input.stats||{}).wis||10) - 10) / 2 + ((input.skill_profs||[]).map(s=>s.toLowerCase()).includes('perception') ? prof : 0),
          saving_throw_profs: input.saving_throw_profs || [],
          skill_profs: input.skill_profs || [],
          traits: input.traits || [],
          conditions: [],
          description: input.description || '',
          spells: {
            cantrips: (input.spells||{}).cantrips || [],
            level_1: (input.spells||{}).level_1 || [],
            level_2: (input.spells||{}).level_2 || [],
            level_3: (input.spells||{}).level_3 || []
          },
          spell_slots: fullSlots,
          channel_divinity: /cleric|paladin/i.test(cls) ? {max:1,used:0} : {max:0,used:0},
          inventory: input.inventory || []
        }],
        npcs: [], quests: [], encounters: [],
        history_log: [{ timestamp: new Date().toISOString(), event: `${input.name} created. ${input.class} Level ${lvl}. Adventure begins.` }]
      };

      saveState(newState);

      // ── Auto-save to saves/ immediately ────────────────────────
      try {
        if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
        const saveName = `${slug}_${ts}.json`;
        const bundle = { meta: { campaign_id: campaignId, character: input.name, class: input.class, level: lvl, location: newState.world.current_location, saved_at: new Date().toISOString() }, state: newState, history: [] };
        fs.writeFileSync(path.join(SAVES_DIR, saveName), JSON.stringify(bundle, null, 2), 'utf8');
        console.log(`  ✓ Character created — saved as ${saveName}`);
      } catch(e) { console.warn('  ⚠️  Auto-save failed:', e.message); }

      return { success: true, campaign_id: campaignId, character: input.name, class: input.class, level: lvl, hp: input.hp, spell_slots: fullSlots, state_updated: true };
    }
    default: return {error:`Unknown tool: ${name}`};
  }
}

// ─── CONTEXT SYNC ─────────────────────────────────────────────────────────────
// Writes a generic session-state snapshot to a context markdown file.
// If the campaign has a hand-authored context file (CONTEXT_PATH), it patches
// the ## SESSION STATE block inside it.  Otherwise it writes a simple
// auto-generated context file next to campaign_state.json.
function updateContextFile(state) {
  if (!state) return;
  try {
    const char=state.party[0]; const world=state.world;
    if (!char || !world) return;
    const now=new Date().toISOString().slice(0,10);
    const hpMax=char.hp_max||char.hp||0;
    const hpPct=hpMax>0?Math.round(char.hp/hpMax*100):0;
    const hpTag=char.hp===hpMax?'full':hpPct>=75?'lightly wounded':hpPct>=40?'wounded':'critical';
    const slotNames={level_1:'1st',level_2:'2nd',level_3:'3rd',level_4:'4th',level_5:'5th',level_6:'6th',level_7:'7th',level_8:'8th',level_9:'9th'};
    const slots=char.spell_slots||{};
    const slotParts=Object.entries(slots).filter(([k,v])=>k!=='cantrip'&&v.max>0).map(([k,v])=>`${v.max-v.used}× ${slotNames[k]||k}`);
    const allFull=slotParts.length===0||Object.entries(slots).filter(([k,v])=>k!=='cantrip'&&v.max>0).every(([,v])=>v.used===0);
    const slotsDisplay=slotParts.join(', ')+(allFull&&slotParts.length?' (full)':'');
    const cd=char.channel_divinity||{max:0,used:0};
    const recent=state.history_log.slice(-8).map(e=>`- ${e.event}`).join('\n');
    const stateBlock=`## SESSION STATE — ${world.time}\n\n| Field | Value |\n|---|---|\n| Character | ${char.name} · ${char.class} · Level ${char.level} |\n| Location | ${world.current_location} |\n| HP | ${char.hp} / ${hpMax} (${hpTag}) |\n| Spell Slots | ${slotsDisplay||'none'} |${cd.max>0?`\n| Channel Divinity | ${cd.max-cd.used} / ${cd.max} available |`:''}\n\n*Last updated: ${now}*`;
    const notesBlock=recent?`\n\n## SESSION NOTES (auto-generated)\n\n${recent}`:'';

    if (fs.existsSync(CONTEXT_PATH)) {
      // Patch the existing context file's SESSION STATE block
      let content=fs.readFileSync(CONTEXT_PATH,'utf8');
      if (content.includes('## SESSION STATE')) {
        content=content.replace(/## SESSION STATE[\s\S]*?(?=\n---\n|\n## [A-Z]|$)/,stateBlock+'\n');
      } else {
        content=stateBlock+'\n\n---\n\n'+content;
      }
      content=content.replace(/\*Last updated: \d{4}-\d{2}-\d{2}\*/g,`*Last updated: ${now}*`);
      if(recent){if(content.includes('## SESSION NOTES')){content=content.replace(/## SESSION NOTES[\s\S]*?(?=\n## |$)/,`## SESSION NOTES (auto-generated)\n\n${recent}\n`);}else{content+=notesBlock;}}
      fs.writeFileSync(CONTEXT_PATH,content,'utf8');
      console.log('  ✓ Context file synced ('+path.basename(CONTEXT_PATH)+')');
    } else {
      // Write a generic auto-generated context file
      const autoPath=path.join(APP_DIR,`${state.campaign_id||'campaign'}-context.md`);
      const content=`# ${char.name} — Campaign Context\n\n${stateBlock}${notesBlock}\n`;
      fs.writeFileSync(autoPath,content,'utf8');
      console.log('  ✓ Auto context written to '+path.basename(autoPath));
    }
  } catch(e){console.warn('  ⚠️  Context sync failed:',e.message);}
}

// ─── AUTO-SAVE ─────────────────────────────────────────────────────────────────
function autoSave() {
  try {
    const status=execSync('git status --porcelain',{cwd:APP_DIR,stdio:'pipe'}).toString().trim();
    if(!status)return;
    execSync('git add campaign_state.json claude_chat_history.json',{cwd:APP_DIR,stdio:'pipe'});
    const ts=new Date().toISOString().slice(0,16).replace('T',' ');
    execSync(`git commit -m "Auto-save: ${ts}"`,{cwd:APP_DIR,stdio:'pipe'});
    console.log(`  ✓ Auto-saved at ${ts}`);
  } catch{}
  // Also write a save-file snapshot and prune old ones
  try { saveCurrentCampaign(); pruneSaves(); } catch {}
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(state) {
  if (!state) return 'You are a D&D 5e Dungeon Master. Use tools for all dice rolls and state changes.';
  const rurik=state.party[0]; const world=state.world;
  const slots=Object.entries(rurik.spell_slots).filter(([,v])=>v.max>0).map(([k,v])=>`Lv${k.replace('level_','')}: ${v.max-v.used}/${v.max}`).join(', ');
  const cd=rurik.channel_divinity;
  // OPTIMIZATION: List weapons, foci, armor, potions (first 5 items by priority)
  const KEY_CATEGORIES = /weapon|sword|axe|hammer|bow|staff|wand|dagger|rapier|mace|shield|armor|mail|focus|symbol|kit|potion/i;
  const keyItems=(rurik.inventory||[]).filter(i=>KEY_CATEGORIES.test(i.name)).slice(0,5).map(i=>i.name).join(', ');
  // OPTIMIZATION: Only include active quests with uncompleted steps (1-line summary)
  const questSummary=(state.quests||[]).filter(q=>q.status==='active'&&q.steps.some(s=>!s.completed)).map(q=>`${q.title}: ${q.steps.filter(s=>!s.completed).map(s=>s.description).join(', ')}`).join(' | ');

  // New campaign — full guided character creation mode
  if (state.campaign_id === 'new-campaign') {
    return `You are a D&D 5e Dungeon Master running solo campaigns. A new player is creating their character. Guide them through these steps IN ORDER — one step at a time, don't rush ahead:

STEP 1 — SETTING: Ask what kind of world/adventure they want. Give 3-4 vivid options (e.g. classic fantasy, dark gothic, seafaring, political intrigue) plus "something else." One sentence each.

STEP 2 — CLASS: After they pick a setting, offer 4-5 fitting classes with one-line descriptions of what they feel like to play (not just mechanics). Let them choose.

STEP 3 — RACE: Suggest 3-4 races that fit their class choice. One sentence each. Let them choose.

STEP 4 — BACKGROUND: Offer 2-3 backgrounds that fit. Briefly explain what each gives (skills + flavor). Let them choose.

STEP 5 — ABILITY SCORES: Tell them you'll roll 4d6 drop lowest for each stat. Use roll_dice("4d6", "STR roll") for each of the 6 stats in sequence. Show the results and suggest how to assign them based on their class. Let them adjust if they want.

STEP 6 — SPELLS (if applicable): For spellcasters list the cantrips and starting spells available. Let them pick. For martial classes skip this.

STEP 7 — EQUIPMENT: Starting gear from background + class. List it briefly.

STEP 8 — NAME & DESCRIPTION: Ask for a name. Ask 1 question about appearance or backstory. Write a 2-sentence character description combining what they said.

STEP 9 — FINALIZE: Call create_character with ALL collected data. Then immediately describe the opening scene of their adventure in vivid prose (2-3 paragraphs). Set the tone.

RULES:
- Use roll_dice for ALL stat rolls and checks.
- Keep each step to 3-5 lines max. Be enthusiastic but concise.
- Do NOT call create_character until you have: name, class, race, stats, and hp confirmed.
- HP = class hit die + CON modifier (e.g. Fighter d10+CON mod, Wizard d6+CON mod).`;
  }

  // Ongoing campaign — generic, reads from state
  const char = rurik;
  const hpMax = char.hp_max || char.hp;
  const pb = char.proficiency_bonus || profBonus(char.level||1);
  const spellDC = char.stats ? (8 + pb + Math.floor(((char.stats.int||char.stats.wis||char.stats.cha||10)-10)/2)) : '—';
  const conditions = (char.conditions||[]).join(', ') || 'none';
  const hitDice = char.hit_dice_total ? `${char.hit_dice_total-(char.hit_dice_used||0)}/${char.hit_dice_total} HD` : '';
  const xpStr = char.xp != null ? `XP: ${char.xp}` : '';
  const ds = char.death_saves;
  const dsStr = (char.hp===0&&ds) ? ` | Death Saves: ${ds.successes}✓ ${ds.failures}✗` : '';
  // Last 5 history events only (not the full log — saves ~500 tokens per call)
  const recentEvents = (state.history_log||[]).slice(-3).map(e=>`• ${e.event}`).join('\n'); // 3 events (was 5) — saves ~150 tokens/call
  return `You are the Dungeon Master for a solo D&D 5e campaign. Use tools for ALL mechanics.

RULES:
- Roll EVERY check with roll_dice (add "advantage"/"disadvantage" for d20s when applicable).
- Call use_spell_slot when leveled spells cast. Call update_hp after damage/healing.
- Call set_concentration when a concentration spell is cast (drops previous automatically).
- Call skill_check after rolling for any DC-based check (records outcome, don't narrate pass/fail yourself).
- Use add_condition/remove_condition to track Poisoned, Frightened, Prone, Blinded, Restrained, etc.
- Use add_npc/update_npc when meeting or changing relationship with characters.
- Use add_quest/complete_quest_step to track objectives.
- Use update_location when travel or scene change occurs.
- When HP reaches 0: call add_condition("Unconscious"), then use death_save for each d20 roll. 3 successes = stable, 3 failures = dead. Natural 20 = regain 1 HP.
- Call award_xp after combat encounters, quest completions, and significant milestones.
- Call end_session when player says "end session" or "quit."
- ALWAYS narrate alongside tool calls. No tool-only responses.

═══════════════════════
CAMPAIGN: ${world.name||'Unknown World'}
Location: ${world.current_location} | Time: ${world.time}

CHARACTER: ${char.name} | ${char.class} L${char.level} | HP: ${char.hp}/${hpMax}${dsStr} | AC: ${char.ac||'—'} | Prof +${pb}${xpStr?' | '+xpStr:''}
Spells: ${slots||'none'} | CD: ${cd.max-cd.used}/${cd.max} | Spell DC: ${spellDC}${hitDice?' | '+hitDice:''}
Conditions: ${conditions}
Gear: ${keyItems||'standard equipment'}

ACTIVE QUESTS: ${questSummary||'None'}
WORLD: ${world.lore_summary||''}${world.weather?`\nWEATHER: ${world.weather.condition}${world.weather.description?' — '+world.weather.description:''}`:''}
RECENT EVENTS:
${recentEvents||'— Campaign beginning —'}`;

}

// ─── AGENTIC DM LOOP (Mistral AI) ─────────────────────────────────────────────
function makeAPICall(bodyStr) {
  return new Promise((resolve, reject) => {
    // Enforce minimum delay between requests
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < REQUEST_DELAY_MS) {
      setTimeout(() => makeAPICall(bodyStr).then(resolve).catch(reject),
        REQUEST_DELAY_MS - timeSinceLastRequest);
      return;
    }
    lastRequestTime = Date.now();

    const buf = Buffer.from(bodyStr);
    const req = https.request({
      hostname: 'api.mistral.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'Authorization': `Bearer ${API_KEY}`
      }
    }, (res) => {
      // Non-200 = error body (not SSE). Parse and reject so the caller can log it properly.
      if (res.statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          let errMsg = `HTTP ${res.statusCode}`;
          try {
            const j = JSON.parse(body);
            if (j.message) errMsg = `HTTP ${res.statusCode} — ${j.message}`;
            else if (j.error?.message) errMsg = `HTTP ${res.statusCode} — ${j.error.message}`;
          } catch {}
          if (errMsg === `HTTP ${res.statusCode}`) errMsg += `: ${body.slice(0, 300)}`;
          const err = new Error(errMsg);
          err.statusCode = res.statusCode;
          reject(err);
        });
        res.on('error', reject);
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('Mistral API request timed out after 90s')));
    req.write(buf); req.end();
  });
}

async function streamAgenticLoop(messages, systemPrompt, res) {
  let totalTokens = 0;
  let apiError = null;

  // Mistral uses OpenAI-compatible chat format: system goes as the first message.
  // We maintain mistralMsgs separately so the caller's `messages` array stays simple
  // (plain {role, content:string} pairs) for history tracking.
  const mistralMsgs = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }))
  ];

  console.log(`  ▶ Agentic loop start — ${messages.length} messages in context`);

  for (let loop = 0; loop < 6; loop++) {
    // Token estimation for rate guard
    const msgsTokens = mistralMsgs.reduce((s, m) =>
      s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
    const { tokens: toolsTokens } = getToolsJson();
    const estInput = msgsTokens + toolsTokens;
    await waitForTokenCapacity(estInput);

    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      messages: mistralMsgs,
      tools: MISTRAL_TOOLS,
      stream: true
    });

    let apiRes;
    try {
      apiRes = await makeAPICall(body);
      recordTokenUsage(estInput);
    } catch (err) {
      apiError = err.message || String(err);
      console.error(`  ✗ Loop ${loop} API call failed: ${apiError}`);
      res.write(`data: ${JSON.stringify({ type: 'error', error: apiError })}\n\n`);
      break;
    }

    // ── Parse Mistral's OpenAI-compatible SSE stream ───────────────────────────
    // Text arrives in: choices[0].delta.content
    // Tool calls arrive in: choices[0].delta.tool_calls[{index,id,function:{name,arguments}}]
    // Stop signals: choices[0].finish_reason = 'stop' | 'tool_calls'
    // Stream ends with: data: [DONE]
    let textTurn = '';
    let toolCalls = [];        // [{id, name, argsStr}]
    let stopReason = 'stop';
    let stateUpdated = false;
    let streamErr = null;

    await new Promise(resolve => {
      let buf = '';
      apiRes.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') { resolve(); return; }
          try {
            const d = JSON.parse(data);
            if (d.error) {
              streamErr = d.error.message || 'Mistral streaming error';
              console.error('  ✗ Stream error:', streamErr);
              res.write(`data: ${JSON.stringify({ type: 'error', error: streamErr })}\n\n`);
            }
            const delta = d.choices?.[0]?.delta;
            if (!delta) { if (d.choices?.[0]?.finish_reason) stopReason = d.choices[0].finish_reason; continue; }

            // Text content
            if (delta.content) {
              textTurn += delta.content;
              res.write(`data: ${JSON.stringify({ type: 'text', content: delta.content })}\n\n`);
            }

            // Tool call streaming — Mistral sends incremental argument JSON chunks
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                // tc.index identifies which parallel tool call this chunk belongs to
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', argsStr: '' };
                if (tc.id)               toolCalls[idx].id      = tc.id;
                if (tc.function?.name)   toolCalls[idx].name    = tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].argsStr += tc.function.arguments;
              }
            }

            const finish = d.choices?.[0]?.finish_reason;
            if (finish) stopReason = finish;
            if (d.usage) totalTokens += d.usage.completion_tokens || 0;
          } catch {}
        }
      });
      apiRes.on('end', resolve);
      apiRes.on('error', e => { streamErr = e.message; resolve(); });
    });

    // Filter out any sparse slots left by non-contiguous indices
    toolCalls = toolCalls.filter(Boolean);

    console.log(`  ⟳ Loop ${loop}: text=${textTurn.length}c, tools=${toolCalls.length}${toolCalls.length ? ` [${toolCalls.map(t => t.name).join(',')}]` : ''}, stop=${stopReason}${streamErr ? `, streamErr=${streamErr}` : ''}`);
    if (streamErr) { apiError = streamErr; break; }

    // ── Add assistant turn to Mistral context ──────────────────────────────────
    if (toolCalls.length > 0) {
      mistralMsgs.push({
        role: 'assistant',
        content: textTurn || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argsStr }
        }))
      });
    } else {
      mistralMsgs.push({ role: 'assistant', content: textTurn });
    }

    // Keep caller's messages array up-to-date (used by collectFinalText)
    if (textTurn) messages.push({ role: 'assistant', content: textTurn });

    if (stopReason !== 'tool_calls' || toolCalls.length === 0) break;

    // ── Execute tools, push results back as 'tool' messages ───────────────────
    // Mistral expects one {role:'tool'} message per tool call (not batched like Anthropic).
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.argsStr); } catch {}
      console.log(`    🔧 ${tc.name}`, JSON.stringify(input).slice(0, 80));
      let result;
      try { result = executeTool(tc.name, input); } catch (e) { result = { error: e.message }; }
      console.log(`    ✓`, JSON.stringify(result).slice(0, 120));

      // Emit SSE events for real-time dashboard updates
      if (result.state_updated) stateUpdated = true;
      if (result.dice_rolled)   res.write(`data: ${JSON.stringify({ type: 'dice_roll',     expression: result.rolled, purpose: result.purpose, breakdown: result.result, total: result.total })}\n\n`);
      if (result.music_scene)   res.write(`data: ${JSON.stringify({ type: 'music_scene',   scene: result.scene })}\n\n`);
      if (result.combat_started)res.write(`data: ${JSON.stringify({ type: 'combat_started',enemies: result.enemies })}\n\n`);
      if (result.leveled)       res.write(`data: ${JSON.stringify({ type: 'level_up',      level: result.level })}\n\n`);
      if (result.weather)       res.write(`data: ${JSON.stringify({ type: 'weather_update',weather: result.weather })}\n\n`);

      // One tool message per call (Mistral/OpenAI format)
      mistralMsgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }

    if (stateUpdated) {
      const ns = loadState();
      if (ns) res.write(`data: ${JSON.stringify({ type: 'state_update', state: ns })}\n\n`);
    }

    // Narration nudge: ask the model to write DM prose now that tools are done
    mistralMsgs.push({ role: 'user', content: 'Tools executed. Write your DM narration now — describe what happens in the scene. No more tool calls unless strictly necessary.' });
    toolCalls = [];
  }

  console.log(`  ▶ Agentic loop end — totalTokens=${totalTokens}${apiError ? `, apiError=${apiError}` : ''}`);
  return { totalTokens, apiError };
}

// ─── HTTP SERVERS ─────────────────────────────────────────────────────────────
const campaignApiServer = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}
  if(req.method==='GET'&&req.url==='/api/state'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(loadState()));return;}
  if(req.method==='POST'&&req.url==='/api/state'){
    let body='';req.on('data',c=>body+=c);
    req.on('end',async()=>{
      try{
        const s=JSON.parse(body);
        const err=validateState(s);
        if(err){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,error:err}));return;}
        await acquireStateLock();
        try{ saveState(s); }finally{ releaseStateLock(); }
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,state:s}));
      }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,error:e.message}));}
    });
    return;
  }
  if(req.method==='GET'&&req.url==='/api/journal'){
    try{const j=fs.existsSync(JOURNAL_PATH)?fs.readFileSync(JOURNAL_PATH,'utf8'):'';
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({content:j}));}
    catch(e){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({content:''}));}
    return;
  }
  // ── DM Notes (scratchpad, persisted to notes.md) ──────────────────────────
  const NOTES_PATH = path.join(__dirname, 'notes.md');
  if(req.method==='GET'&&req.url==='/api/notes'){
    try{const n=fs.existsSync(NOTES_PATH)?fs.readFileSync(NOTES_PATH,'utf8'):'';
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({content:n}));}
    catch(e){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({content:''}));}
    return;
  }
  if(req.method==='POST'&&req.url==='/api/notes'){
    let body='';req.on('data',c=>body+=c);
    req.on('end',()=>{
      try{const {content}=JSON.parse(body);fs.writeFileSync(NOTES_PATH,content||'','utf8');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true}));}
      catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,error:e.message}));}
    });
    return;
  }
  res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
});

const relayServer = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}
  if(req.method==='GET'&&req.url==='/api/chat/history'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(loadHistory()));return;}
  if(req.method==='GET'&&req.url==='/api/chat/clear'){saveHistory({messages:[],created_at:new Date().toISOString(),token_count:0,model:MODEL});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true}));return;}
  if(req.method==='POST'&&req.url==='/api/chat'){
    let body='';req.on('data',c=>body+=c);
    req.on('end',async()=>{
      try{
        const {prompt}=JSON.parse(body);
        if(!prompt){res.writeHead(400);res.end(JSON.stringify({error:'prompt required'}));return;}
        const history=loadHistory();
        history.messages.push({role:'user',content:prompt});
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
        // Token-budget windowing: keep most recent messages within a strict token budget.
        // Rate limit is 10K tokens/minute, so we cap conversational history well below that
        // to leave room for system prompt, tool calls, and the model's output.
        const HISTORY_TOKEN_BUDGET = 2500; // reduced from 4500 — saves ~2K tokens/call
        const HARD_MAX_MESSAGES    = 30;
        const allMapped = history.messages.map(m => ({ role: m.role, content: m.content }));
        const tokCount = m => estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        let runningTokens = 0;
        let cutoff = allMapped.length;
        for (let i = allMapped.length - 1; i >= 0 && (allMapped.length - i) <= HARD_MAX_MESSAGES; i--) {
          const t = tokCount(allMapped[i]);
          if (runningTokens + t > HISTORY_TOKEN_BUDGET && (allMapped.length - i) > 2) break;
          runningTokens += t;
          cutoff = i;
        }
        let messagesForAPI = allMapped.slice(cutoff);
        // Anthropic requires the first message to be 'user' — drop a leading assistant if windowing landed on one
        if (messagesForAPI[0]?.role === 'assistant') messagesForAPI = messagesForAPI.slice(1);
        const systemPrompt = buildSystemPrompt(loadState());
        console.log(`\n  ━━━ Chat request — history=${history.messages.length} msgs (sending last ${messagesForAPI.length}, ~${runningTokens} tokens) ━━━`);
        const msgStartIdx=messagesForAPI.length;
        const r1=await streamAgenticLoop(messagesForAPI,systemPrompt,res);
        let outTokens=r1.totalTokens, apiError=r1.apiError;
        const collectFinalText=()=>{let t='';for(let i=msgStartIdx;i<messagesForAPI.length;i++){const m=messagesForAPI[i];if(m.role==='assistant'){if(Array.isArray(m.content))t+=m.content.filter(b=>b.type==='text').map(b=>b.text).join('');else if(typeof m.content==='string')t+=m.content;}}return t;};
        let finalText=collectFinalText();
        // Emergency fallback: tools ran successfully but no narration produced (and no API error).
        // Skip fallback on API errors — retrying will just hit the same error.
        if(!apiError&&!finalText.trim()&&messagesForAPI.length>msgStartIdx+1){
          console.warn('  ⚠️  No narration after tools — forcing follow-up narration call');
          messagesForAPI.push({role:'user',content:'You called tools but wrote no narration. Write your DM response now — describe what happens in the scene.'});
          const r2=await streamAgenticLoop(messagesForAPI,systemPrompt,res);
          outTokens+=r2.totalTokens;
          if(r2.apiError)apiError=r2.apiError;
          finalText=collectFinalText();
        }
        if(finalText.trim()){
          // Success — persist the exchange normally
          history.messages.push({role:'assistant',content:finalText});
          history.token_count+=estimateTokens(prompt)+(outTokens||estimateTokens(finalText));
          history.model=MODEL;
          saveHistory(history);
          console.log(`  ✓ Turn saved — ${finalText.length} chars of narration`);
        } else {
          // Failure — instead of silent rollback, surface a visible error message to the user.
          // This keeps history valid (alternating user/assistant) AND lets the user see what went wrong.
          let errMsg;
          if(apiError){
            errMsg=`⚠️ **DM connection issue**\n\n\`${apiError}\`\n\n*Your message was kept. Try sending it again — if this is a rate limit or "overloaded" error, wait 10–20 seconds first.*`;
          } else {
            errMsg=`⚠️ **No DM narration this turn**\n\nThe DM called tools but didn't write a response. Try rephrasing, or send "continue" to prompt narration.`;
          }
          history.messages.push({role:'assistant',content:errMsg});
          history.token_count+=estimateTokens(prompt);
          history.model=MODEL;
          saveHistory(history);
          // Stream the error as text so the dashboard shows it in the chat bubble
          res.write(`data: ${JSON.stringify({type:'text',content:errMsg})}\n\n`);
          console.error(`  ✗ Empty turn surfaced to user: ${apiError||'(no narration)'}`);
        }
        res.write(`data: ${JSON.stringify({type:'done',token_count:history.token_count,model:MODEL})}\n\n`);
        res.end();
      }catch(err){res.write(`data: ${JSON.stringify({type:'error',error:err.message})}\n\n`);res.end();}
    });
    return;
  }
  res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
});

const dashboardServer = http.createServer((req,res)=>{
  let pathname=urlMod.parse(req.url,true).pathname;
  try{pathname=decodeURIComponent(pathname);}catch{}
  if(pathname.startsWith('/'))pathname=pathname.slice(1);
  if(!pathname)pathname='Campaign Dashboard HTML.html';
  const filePath=path.join(APP_DIR,pathname);
  if(!filePath.startsWith(APP_DIR)){res.writeHead(403);res.end('Forbidden');return;}
  fs.readFile(filePath,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found: '+pathname);return;}
    let ct='text/plain';
    if(pathname.endsWith('.html'))ct='text/html; charset=utf-8';
    else if(pathname.endsWith('.js'))ct='application/javascript';
    else if(pathname.endsWith('.json'))ct='application/json';
    else if(pathname.endsWith('.css'))ct='text/css';
    else if(pathname.endsWith('.png'))ct='image/png';
    else if(pathname.endsWith('.jpg')||pathname.endsWith('.jpeg'))ct='image/jpeg';
    res.writeHead(200,{'Content-Type':ct});
    res.end(data);
  });
});

// ─── START SERVERS ────────────────────────────────────────────────────────────
function startServers(onReady) {
  let started = 0;
  const check = () => { if (++started === 3 && onReady) onReady(); };

  campaignApiServer.listen(3140, () => check());
  relayServer.listen(3141,       () => check());
  dashboardServer.listen(8080,   () => check());

  // Any listen error at this point is unexpected (ports were freed before calling this)
  campaignApiServer.on('error', e => { console.error('  ✗ API server error:', e.message); });
  relayServer.on('error',       e => { console.error('  ✗ Relay error:', e.message); });
  dashboardServer.on('error',   e => { console.error('  ✗ Dashboard error:', e.message); });
}

function openBrowser() {
  const dashUrl = 'http://localhost:8080';
  if (process.platform === 'win32') exec(`cmd /c start ${dashUrl}`);
  else if (process.platform === 'darwin') exec(`open ${dashUrl}`);
  else exec(`xdg-open ${dashUrl}`);
}

// ─── SAVE SYSTEM ──────────────────────────────────────────────────────────────

function ensureSavesDir() {
  if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });
}

// Build a slug from character name + date for the filename
function makeSaveFilename(state) {
  const char = (state.party?.[0]?.name || 'unknown').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const date = new Date().toISOString().slice(0, 10);
  const time = state.world?.time?.replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'day1';
  return `${char}_${time}_${date}.json`;
}

// Write current campaign state + chat history into saves/
function saveCurrentCampaign() {
  try {
    if (!fs.existsSync(CAMPAIGN_STATE_PATH)) return null;
    const state = JSON.parse(fs.readFileSync(CAMPAIGN_STATE_PATH, 'utf8'));
    if (state.campaign_id === 'new-campaign') return null; // nothing worth saving

    const history = fs.existsSync(CHAT_HISTORY_PATH)
      ? JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH, 'utf8'))
      : { messages: [] };

    const r = state.party?.[0] || {};
    const meta = {
      character:   r.name        || 'Unknown',
      class:       r.class       || '—',
      level:       r.level       || 1,
      hp:          r.hp          || 0,
      location:    state.world?.current_location || '—',
      time:        state.world?.time             || '—',
      campaign_id: state.campaign_id             || '—',
      saved_at:    new Date().toISOString(),
      messages:    (history.messages || []).length,
    };

    ensureSavesDir();
    const filename = makeSaveFilename(state);
    const savePath = path.join(SAVES_DIR, filename);
    fs.writeFileSync(savePath, JSON.stringify({ meta, state, history }, null, 2), 'utf8');
    return filename;
  } catch (e) {
    console.error('  ⚠️  Save failed:', e.message);
    return null;
  }
}

// List all saves, most recent first
function listSaves() {
  ensureSavesDir();
  try {
    return fs.readdirSync(SAVES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(SAVES_DIR, f), 'utf8'));
          return { filename: f, meta: raw.meta };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.meta.saved_at) - new Date(a.meta.saved_at));
  } catch { return []; }
}

// Restore a save into the active campaign files
function loadSave(filename) {
  const savePath = path.join(SAVES_DIR, filename);
  const raw = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  invalidateStateCache(); // force fresh read from the newly-written file
  saveState(raw.state);
  saveHistory(raw.history || { messages: [], token_count: 0, model: MODEL });
  console.log('');
  console.log(`  ✓ Loaded: ${raw.meta.character} — ${raw.meta.time}`);
  console.log(`  ✓ Location: ${raw.meta.location}`);
  console.log('');
}

// Run build-campaign.js on a user-supplied .md file, then return to menu
function importFromMd(callback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('');
  console.log('  ┌─ Import Campaign from Markdown ─────────────────────────┐');
  console.log('  │  Enter the path to your .md file.                       │');
  console.log('  │  Relative paths are resolved from:                      │');
  console.log(`  │  ${APP_DIR.padEnd(56)}│`);
  console.log('  │  Example:  my-campaign.md                               │');
  console.log('  │            C:\\Users\\you\\Documents\\campaign.md           │');
  console.log('  │  (Leave blank to cancel)                                │');
  console.log('  └─────────────────────────────────────────────────────────┘');
  console.log('');
  rl.question('  > ', answer => {
    rl.close();
    const raw = answer.trim().replace(/^["']|["']$/g, '');
    if (!raw) { console.log('  Cancelled.\n'); callback(); return; }

    const builderPath = path.join(APP_DIR, 'scripts', 'build-campaign.js');
    if (!fs.existsSync(builderPath)) {
      console.error('  ✗ scripts/build-campaign.js not found.');
      callback(); return;
    }

    // Resolve the md path
    let mdPath = raw;
    if (!path.isAbsolute(mdPath)) {
      mdPath = path.resolve(APP_DIR, mdPath);
    }

    const { execFileSync } = require('child_process');
    try {
      const output = execFileSync(process.execPath, [builderPath, mdPath], {
        encoding: 'utf8',
        cwd: APP_DIR,
      });
      console.log(output);
      console.log('  ✓ Import complete. Choose [Load Campaign] to play it.\n');
    } catch (e) {
      console.error('  ✗ Import failed:', (e.stderr || e.message || '').split('\n')[0]);
    }
    callback();
  });
}

// ─── MAIN MENU ────────────────────────────────────────────────────────────────
function showMenu(hasSave, callback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const saves = listSaves();
  const hasSavedCampaigns = saves.length > 0;

  console.log('  ┌─────────────────────────────────┐');
  if (hasSave) {
    console.log('  │   [1]  Continue Campaign        │');
  } else {
    console.log('  │   [1]  Start Campaign           │');
  }
  console.log('  │   [2]  New Campaign             │');
  if (hasSavedCampaigns) {
  console.log('  │   [3]  Load Campaign            │');
  console.log('  │   [4]  Import from .md file     │');
  console.log('  │   [5]  Quit                     │');
  } else {
  console.log('  │   [3]  Import from .md file     │');
  console.log('  │   [4]  Quit                     │');
  }
  console.log('  └─────────────────────────────────┘');
  console.log('');

  function ask() {
    rl.question('  > ', answer => {
      const choice = answer.trim();
      if (choice === '1') { rl.close(); callback('continue'); }
      else if (choice === '2') { rl.close(); callback('new'); }
      else if (choice === '3' && hasSavedCampaigns)  { rl.close(); callback('load'); }
      else if (choice === '3' && !hasSavedCampaigns) { rl.close(); callback('import'); }
      else if (choice === '4' && hasSavedCampaigns)  { rl.close(); callback('import'); }
      else if ((choice === '4' && !hasSavedCampaigns) || choice === '5') { rl.close(); callback('quit'); }
      else { console.log(`  Please enter a valid option.`); ask(); }
    });
  }
  ask();
}

function showLoadMenu(callback) {
  const saves = listSaves();
  if (!saves.length) { console.log('  No saved campaigns found.\n'); callback(null); return; }

  console.log('');
  console.log('  ┌─ Saved Campaigns ─────────────────────────────────────────┐');
  saves.forEach((s, i) => {
    const m = s.meta;
    const date = m.saved_at ? m.saved_at.slice(0, 10) : '—';
    const line = `[${i + 1}]  ${m.character} · ${m.class} Lv${m.level} · ${m.time}`;
    const sub  = `     ${m.location} · Saved ${date}`;
    console.log(`  │  ${line.padEnd(58)}│`);
    console.log(`  │  ${sub.padEnd(58)}│`);
    if (i < saves.length - 1) console.log('  │                                                            │');
  });
  console.log('  │                                                            │');
  console.log('  │  [0]  Back                                                 │');
  console.log('  └────────────────────────────────────────────────────────────┘');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  function ask() {
    rl.question('  > ', answer => {
      const n = parseInt(answer.trim());
      if (answer.trim() === '0') { rl.close(); callback(null); return; }
      if (n >= 1 && n <= saves.length) { rl.close(); callback(saves[n - 1].filename); return; }
      console.log(`  Enter a number between 0 and ${saves.length}.`); ask();
    });
  }
  ask();
}

function confirmNewCampaign(callback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('');
  console.log('  Starting a new campaign will save the current one');
  console.log('  to the saves/ folder, then wipe the active slot.');
  console.log('  Type YES to confirm:');
  console.log('');
  rl.question('  > ', answer => {
    rl.close();
    callback(answer.trim().toUpperCase() === 'YES');
  });
}

function resetToBrandNew() {
  // Auto-save current campaign before wiping (if it's a real campaign)
  const saved = saveCurrentCampaign();
  if (saved) {
    console.log('');
    console.log(`  ✓ Current campaign saved → saves/${saved}`);
  }

  // Add journal divider so entries don't blur between campaigns
  try {
    if (fs.existsSync(JOURNAL_PATH)) {
      const divider = `\n\n${'═'.repeat(60)}\n  END OF CAMPAIGN — ${new Date().toISOString().slice(0, 10)}\n${'═'.repeat(60)}\n\n`;
      fs.appendFileSync(JOURNAL_PATH, divider, 'utf8');
    }
  } catch {}

  // Wipe active state and history
  invalidateStateCache();
  saveState(JSON.parse(JSON.stringify(BLANK_STATE)));
  saveHistory({ messages: [], created_at: new Date().toISOString(), token_count: 0, model: MODEL });

  // Clear SESSION NOTES from context file
  try {
    if (fs.existsSync(CONTEXT_PATH)) {
      let ctx = fs.readFileSync(CONTEXT_PATH, 'utf8');
      ctx = ctx.replace(/## SESSION NOTES[\s\S]*?(?=\n## |$)/,'');
      fs.writeFileSync(CONTEXT_PATH, ctx, 'utf8');
    }
  } catch {}

  console.log('  ✓ Campaign data cleared. Starting fresh...');
  console.log('  ✓ Claude will guide you through character creation.');
  console.log('');
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
async function main() {
  showBanner();

  // Check for API key
  if (!API_KEY) {
    console.log('  ❌  Missing API key!');
    console.log('');
    console.log(`  Create a file called  .env  in:`);
    console.log(`  ${APP_DIR}`);
    console.log('');
    console.log('  Containing exactly this line:');
    console.log('  MISTRAL_API_KEY=your-mistral-key-here');
    console.log('');
    console.log('  Press Enter to exit.');
    await new Promise(r => process.stdin.once('data', r));
    process.exit(1);
  }

  const hasSave = fs.existsSync(CAMPAIGN_STATE_PATH);
  if (hasSave) showStateSummary();

  showMenu(hasSave, choice => {
    if (choice === 'quit') {
      console.log('\n  Farewell, adventurer.\n');
      process.exit(0);
    }

    if (choice === 'new') {
      confirmNewCampaign(confirmed => {
        if (!confirmed) {
          console.log('  Cancelled. Returning to menu...\n');
          setTimeout(() => main(), 500);
          return;
        }
        resetToBrandNew();
        launchGame();
      });
      return;
    }

    if (choice === 'load') {
      showLoadMenu(filename => {
        if (!filename) {
          // Back — re-show main menu
          setTimeout(() => main(), 200);
          return;
        }
        try {
          loadSave(filename);
          launchGame();
        } catch (e) {
          console.error('  ✗ Failed to load save:', e.message);
          setTimeout(() => main(), 800);
        }
      });
      return;
    }

    if (choice === 'import') {
      importFromMd(() => setTimeout(() => main(), 400));
      return;
    }

    // choice === 'continue'
    launchGame();
  });
}

function launchGame() {
  cls();
  showBanner();
  console.log('  Starting servers...\n');

  // Free ports first, silently
  freeAllPorts();

  startServers(() => {
    console.log('  ✓ Campaign API   → localhost:3140');
    console.log('  ✓ Mistral DM     → localhost:3141');
    console.log('  ✓ Dashboard      → localhost:8080');
    console.log('');
    console.log('  Opening dashboard in browser...');
    openBrowser();
    console.log('');
    console.log('  Auto-save: every 5 minutes');
    console.log('  To end session: type "end session" in the Claude tab');
    console.log('  Press Ctrl+C to stop servers');
    console.log('');

    setInterval(autoSave, AUTO_SAVE_INTERVAL_MS);
  });
}

// ─── GRACEFUL SHUTDOWN & CRASH SAVE ──────────────────────────────────────────
function emergencySave(reason) {
  try {
    const saved = saveCurrentCampaign();
    if (saved) console.log(`\n  ✓ Emergency save written → saves/${saved}`);
  } catch {}
}

process.on('SIGINT', () => {
  console.log('\n  Shutting down servers...');
  emergencySave('SIGINT');
  campaignApiServer.close();
  relayServer.close();
  dashboardServer.close();
  process.exit(0);
});

process.on('SIGTERM', () => { emergencySave('SIGTERM'); process.exit(0); });

process.on('uncaughtException', (err) => {
  console.error('\n  ✗ Uncaught exception:', err.message);
  emergencySave('uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('\n  ✗ Unhandled rejection:', reason);
  // Don't exit — may be recoverable
});

// ─── HISTORY DISK PRUNING ────────────────────────────────────────────────────
// Keep on-disk history from growing unbounded — cap at 500 messages on disk.
// The in-memory windowing already limits what we send to Claude on each call.
const MAX_HISTORY_MESSAGES_ON_DISK = 500;
function pruneHistoryOnDisk() {
  try {
    const h = loadHistory();
    if (h.messages.length > MAX_HISTORY_MESSAGES_ON_DISK) {
      h.messages = h.messages.slice(-MAX_HISTORY_MESSAGES_ON_DISK);
      saveHistory(h);
      console.log(`  ✓ History pruned to last ${MAX_HISTORY_MESSAGES_ON_DISK} messages`);
    }
  } catch {}
}
// Prune once at startup and once an hour during long sessions
setInterval(pruneHistoryOnDisk, 60 * 60 * 1000);

main();
