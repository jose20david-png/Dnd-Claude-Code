#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════
//  CAMPAIGN LAUNCHER — D&D 5e Rurik Stormhammer / Lost Mine Arc
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

const MODEL                = 'claude-haiku-4-5';
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;
const PORTS                = [3140, 3141, 8080];

// ─── REQUEST THROTTLING (rate limit protection) ───────────────────────────
let lastRequestTime = 0;
const REQUEST_DELAY_MS = 1500; // 1.5 second minimum between API calls to spread token usage

// ─── API KEY ──────────────────────────────────────────────────────────────────
let API_KEY = '';
try {
  const env = fs.readFileSync(ENV_PATH, 'utf8');
  const m = env.match(/ANTHROPIC_API_KEY=(.+)/);
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
  let line1 = 'Lost Mine of Phandelver · The Witness Arc';
  let line2 = '';
  let line3 = '';
  try {
    if (fs.existsSync(CAMPAIGN_STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(CAMPAIGN_STATE_PATH, 'utf8'));
      if (s.campaign_id !== 'new-campaign' && s.party && s.party[0]) {
        const r = s.party[0];
        const w = s.world;
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
    console.log(`  │  HP        : ${String(r.hp||0).padStart(2)} / 27${' '.repeat(33)}│`);
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
    current_location: 'Character Creation', time: 'Day 1 — Morning', seal_integrity: 100, seal_status: 'N/A' },
  party: [{
    id: 'player', name: 'New Character', class: 'Unset', level: 1, hp: 10, status: 'active',
    spell_slots: { cantrip:{max:0,used:0}, level_1:{max:0,used:0}, level_2:{max:0,used:0}, level_3:{max:0,used:0}, level_4:{max:0,used:0}, level_5:{max:0,used:0} },
    channel_divinity: { max: 0, used: 0 }, inventory: []
  }],
  npcs: [], quests: [], encounters: [],
  history_log: [{ timestamp: new Date().toISOString(), event: 'New campaign started. Begin character creation.' }]
};

const RURIK_STATE = {
  campaign_id: 'lost-mine-phandelver-witness-arc',
  world: { name: 'Forgotten Realms — Phandelver Region',
    lore_summary: 'The Witness is sealed beneath Wave Echo Cave. Breeding chamber destroyed Day 6. Mind Flayer at large. Phandalin occupied by Redbrands under Silga.',
    current_location: "Old Marta's Cabin, Phandalin outskirts", time: 'Day 7 — Morning', seal_integrity: 100, seal_status: 'Stable — years' },
  party: [{
    id: 'rurik', name: 'Rurik Stormhammer', class: 'Cleric (Storm Domain)', level: 3, hp: 27, status: 'active',
    spell_slots: { cantrip:{max:0,used:0}, level_1:{max:4,used:0}, level_2:{max:2,used:0}, level_3:{max:0,used:0}, level_4:{max:0,used:0}, level_5:{max:0,used:0} },
    channel_divinity: { max:1, used:0 },
    inventory: [
      {name:'Warhammer +1',quantity:1,rarity:'uncommon'}, {name:'Holy Symbol of Talos (amulet)',quantity:1,rarity:'common'},
      {name:'Chain Mail',quantity:1,rarity:'common'}, {name:'Shield',quantity:1,rarity:'common'},
      {name:'Backpack',quantity:1,rarity:'common'}, {name:'Bedroll',quantity:1,rarity:'common'},
      {name:'Rope (50 ft)',quantity:1,rarity:'common'}, {name:'Torch',quantity:3,rarity:'common'},
      {name:'Healing Kit',quantity:1,rarity:'common'}, {name:'Waterskin',quantity:1,rarity:'common'}
    ]
  }],
  npcs: [
    {id:'npc_garaele',name:'Sister Garaele',role:'ally',location:"Old Marta's Cabin",personality:'Devout, warm, staff recharging',knowledge:['Harper network','binding ritual complete']},
    {id:'npc_sildar',name:'Sildar Hallwinter',role:'ally',location:"Old Marta's Cabin",personality:'Military, tactical, wants Silga intel',knowledge:['Lords Alliance','patrol count ~8-12']},
    {id:'npc_gundren',name:'Gundren Rockseeker',role:'ally',location:"Old Marta's Cabin",personality:'Shaken but steady',knowledge:['Wave Echo Cave','Phandelver Compact']},
    {id:'npc_iarno',name:'Iarno Albrek',role:'redeemed-enemy',location:"Old Marta's Cabin",personality:'Recovering, motivated to repair damage',knowledge:['Silga patrol rotations','3-5am south road gap']},
    {id:'npc_toblen',name:'Toblen Stonehill',role:'civilian-ally',location:"Old Marta's Cabin",personality:'Stubborn, wants to fight for Phandalin',knowledge:['town layout']},
    {id:'npc_qelline',name:'Qelline Alderleaf',role:'ally',location:"Old Marta's Cabin",personality:'Practical, methodical, prepared intel notes',knowledge:['south road gap 3-5am','Harpers ETA Day 9']},
    {id:'npc_silga',name:'Silga',role:'antagonist',location:'Phandalin',personality:'Tactical, brutal field commander',knowledge:['Redbrand operations','outrider positions']},
    {id:'npc_mindflayer',name:'The Mind Flayer',role:'antagonist',location:'unknown',personality:'Ancient, calculating, severed from the Witness',knowledge:['Wave Echo Cave layout','Witness history']}
  ],
  quests: [
    {id:'quest_escape',title:'Escape Phandalin — Choose a Route',status:'active',steps:[
      {step_id:'q1s1',description:'Consult Iarno for Silga patrol intel',completed:false},
      {step_id:'q1s2',description:'Choose route: South Road / Forest Path NE / Hold for Harpers',completed:false},
      {step_id:'q1s3',description:'Execute chosen escape plan',completed:false}]},
    {id:'quest_mindflayer',title:'Hunt the Mind Flayer',status:'active',steps:[
      {step_id:'q2s1',description:'Locate where the Mind Flayer retreated',completed:false},
      {step_id:'q2s2',description:'Confront and neutralize the Mind Flayer',completed:false}]},
    {id:'quest_liberate',title:'Liberate Phandalin',status:'active',steps:[
      {step_id:'q3s1',description:'Remove Silga from command',completed:false},
      {step_id:'q3s2',description:'Scatter or defeat 8-12 active Redbrands',completed:false},
      {step_id:'q3s3',description:'Restore safety to Phandalin townspeople',completed:false}]},
    {id:'quest_witness',title:'Contain the Witness',status:'completed',steps:[
      {step_id:'q4s1',description:'Reinforce the binding seal beneath Wave Echo Cave',completed:true},
      {step_id:'q4s2',description:"Destroy the Mind Flayer's ceremorphosis breeding pods",completed:true}]}
  ],
  encounters: [],
  history_log: [
    {timestamp:'2026-05-16T00:00:00Z',event:'State engine initialized. Day 7 Morning. Long rest complete at Marta\'s Cabin.'},
    {timestamp:'2026-05-16T00:01:00Z',event:'Player confirmed state initialization. Narrative unlocked. Engine active.'}
  ]
};

// ─── STATE / HISTORY HELPERS ──────────────────────────────────────────────────
function loadState()   { try { return JSON.parse(fs.readFileSync(CAMPAIGN_STATE_PATH,'utf8')); } catch { return JSON.parse(JSON.stringify(RURIK_STATE)); } }
function saveState(s)  { fs.writeFileSync(CAMPAIGN_STATE_PATH, JSON.stringify(s,null,2),'utf8'); }
function loadHistory() { try { return JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH,'utf8')); } catch { return {messages:[],created_at:new Date().toISOString(),token_count:0,model:MODEL}; } }
function saveHistory(h){ fs.writeFileSync(CHAT_HISTORY_PATH, JSON.stringify(h,null,2),'utf8'); }
function estimateTokens(t){ return Math.ceil(t.length/4); }

// ─── DICE ─────────────────────────────────────────────────────────────────────
function rollDice(expr) {
  const m = expr.match(/(\d+)d(\d+)([+-]\d+)?/i);
  if (!m) return { total:0, breakdown:`Invalid: ${expr}` };
  const num=parseInt(m[1]), sides=parseInt(m[2]), mod=parseInt(m[3]||'0');
  const rolls=Array.from({length:num},()=>Math.floor(Math.random()*sides)+1);
  const total=rolls.reduce((a,b)=>a+b,0)+mod;
  const bd=mod!==0?`[${rolls.join(', ')}]${mod>=0?'+':''}${mod} = **${total}**`:`[${rolls.join(', ')}] = **${total}**`;
  return {total,rolls,modifier:mod,breakdown:bd};
}

// ─── TOOLS ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {name:'roll_dice',description:'Roll dice for any D&D check. ALWAYS use this for every dice roll.',
   input_schema:{type:'object',properties:{expression:{type:'string'},purpose:{type:'string'}},required:['expression','purpose']}},
  {name:'update_hp',description:"Update Rurik's HP after damage or healing.",
   input_schema:{type:'object',properties:{hp:{type:'number'},reason:{type:'string'}},required:['hp','reason']}},
  {name:'use_spell_slot',description:'Spend a spell slot when a leveled spell is cast.',
   input_schema:{type:'object',properties:{level:{type:'number'},spell_name:{type:'string'}},required:['level','spell_name']}},
  {name:'use_channel_divinity',description:'Spend Channel Divinity.',
   input_schema:{type:'object',properties:{ability:{type:'string'}},required:['ability']}},
  {name:'restore_resources',description:'Restore resources after a rest.',
   input_schema:{type:'object',properties:{rest_type:{type:'string',enum:['long_rest','short_rest']}},required:['rest_type']}},
  {name:'add_inventory_item',description:"Add item to Rurik's inventory.",
   input_schema:{type:'object',properties:{name:{type:'string'},quantity:{type:'number'},rarity:{type:'string',enum:['common','uncommon','rare','very rare','legendary']}},required:['name','quantity','rarity']}},
  {name:'remove_inventory_item',description:'Remove or consume an inventory item.',
   input_schema:{type:'object',properties:{name:{type:'string'},quantity:{type:'number'}},required:['name','quantity']}},
  {name:'complete_quest_step',description:'Mark a quest step as completed.',
   input_schema:{type:'object',properties:{quest_id:{type:'string'},step_id:{type:'string'}},required:['quest_id','step_id']}},
  {name:'append_history_log',description:'Record a significant narrative event.',
   input_schema:{type:'object',properties:{event:{type:'string'}},required:['event']}},
  {name:'end_session',description:'End the session, write a narrative journal entry, sync context file, commit and push to GitHub.',
   input_schema:{type:'object',properties:{summary:{type:'string',description:'One-line session summary for the git commit message.'},recap:{type:'string',description:'2-3 paragraph narrative journal entry written in vivid prose from the DM perspective, describing what happened this session — key events, decisions, dramatic moments, and how it ends. Written like a campaign diary, not a bullet list.'}},required:['summary','recap']}},
  {name:'set_music_scene',description:"Change the dashboard's background music to match the current narrative mood. Call this whenever the tone shifts: entering combat, arriving at a tavern, taking a rest, dramatic silence, etc.",
   input_schema:{type:'object',properties:{scene:{type:'string',enum:['exploration','combat','rest','tavern','silence'],description:'exploration=travel/adventure, combat=battle/tension, rest=safe downtime/camp, tavern=social/inn, silence=dramatic pause'}},required:['scene']}},
  {name:'start_combat',description:'Initiate combat encounter. Opens combat tracker on dashboard with enemy list.',
   input_schema:{type:'object',properties:{enemies:{type:'array',items:{type:'object',properties:{name:{type:'string'},hp:{type:'number'},initiative:{type:'number'}},required:['name','hp','initiative']},description:'List of enemies in combat. Each enemy has name, hp (max), and initiative.'}},required:['enemies']}}
];

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────
function executeTool(name, input) {
  const state = loadState();
  switch (name) {
    case 'roll_dice': { const r=rollDice(input.expression); return {rolled:input.expression,purpose:input.purpose,result:r.breakdown,total:r.total}; }
    case 'update_hp': { const hp=Math.max(0,Math.min(27,Math.round(input.hp))); state.party[0].hp=hp; state.history_log.push({timestamp:new Date().toISOString(),event:input.reason}); saveState(state); return {success:true,hp,state_updated:true}; }
    case 'use_spell_slot': { const slots=state.party[0].spell_slots; const key=`level_${input.level}`; if(!slots[key]||slots[key].used>=slots[key].max) return {error:`No level ${input.level} slots remaining`}; slots[key].used++; state.history_log.push({timestamp:new Date().toISOString(),event:`Cast ${input.spell_name} (Lv${input.level}). ${slots[key].max-slots[key].used}/${slots[key].max} remaining.`}); saveState(state); return {success:true,remaining:slots[key].max-slots[key].used,state_updated:true}; }
    case 'use_channel_divinity': { const cd=state.party[0].channel_divinity; if(cd.used>=cd.max) return {error:'No Channel Divinity remaining'}; cd.used++; state.history_log.push({timestamp:new Date().toISOString(),event:`Used Channel Divinity: ${input.ability}`}); saveState(state); return {success:true,remaining:cd.max-cd.used,state_updated:true}; }
    case 'restore_resources': { const r=state.party[0]; if(input.rest_type==='long_rest'){for(const k of Object.keys(r.spell_slots))r.spell_slots[k].used=0;r.channel_divinity.used=0;r.hp=27;state.history_log.push({timestamp:new Date().toISOString(),event:'Long rest — all resources restored.'});}else{r.channel_divinity.used=0;state.history_log.push({timestamp:new Date().toISOString(),event:'Short rest — Channel Divinity restored.'});} saveState(state); return {success:true,state_updated:true}; }
    case 'add_inventory_item': { const inv=state.party[0].inventory; const ex=inv.find(i=>i.name.toLowerCase()===input.name.toLowerCase()); if(ex)ex.quantity+=input.quantity;else inv.push({name:input.name,quantity:input.quantity,rarity:input.rarity}); state.history_log.push({timestamp:new Date().toISOString(),event:`Acquired: ${input.name} ×${input.quantity}`}); saveState(state); return {success:true,state_updated:true}; }
    case 'remove_inventory_item': { const inv=state.party[0].inventory; const idx=inv.findIndex(i=>i.name.toLowerCase()===input.name.toLowerCase()); if(idx===-1)return {error:`"${input.name}" not in inventory`}; inv[idx].quantity-=input.quantity; if(inv[idx].quantity<=0)inv.splice(idx,1); state.history_log.push({timestamp:new Date().toISOString(),event:`Used/removed: ${input.name} ×${input.quantity}`}); saveState(state); return {success:true,state_updated:true}; }
    case 'complete_quest_step': { const quest=state.quests.find(q=>q.id===input.quest_id); if(!quest)return {error:`Quest ${input.quest_id} not found`}; const step=quest.steps.find(s=>s.step_id===input.step_id); if(!step)return {error:`Step ${input.step_id} not found`}; step.completed=true; if(quest.steps.every(s=>s.completed))quest.status='completed'; state.history_log.push({timestamp:new Date().toISOString(),event:`Quest step completed: "${step.description}"`}); saveState(state); return {success:true,state_updated:true}; }
    case 'append_history_log': { state.history_log.push({timestamp:new Date().toISOString(),event:input.event}); saveState(state); return {success:true}; }
    case 'set_music_scene': { return {success:true, scene:input.scene, music_scene:true}; }
    case 'start_combat': {
      const enemies = input.enemies || [];
      state.history_log.push({timestamp:new Date().toISOString(),event:`Combat started with ${enemies.map(e=>e.name).join(', ')}`});
      saveState(state);
      return {success:true,combat_started:true,enemies:enemies};
    }
    case 'end_session': {
      try {
        // Write journal entry
        if (input.recap) {
          const state=loadState(); const world=state.world;
          const date=new Date().toISOString().slice(0,10);
          const header=`\n---\n\n## ${world.time} | ${date}\n*${world.current_location}*\n\n`;
          const entry=header+input.recap.trim()+'\n';
          if (!fs.existsSync(JOURNAL_PATH)) {
            fs.writeFileSync(JOURNAL_PATH,'# Rurik Stormhammer — Campaign Journal\n','utf8');
          }
          fs.appendFileSync(JOURNAL_PATH,entry,'utf8');
          console.log('  ✓ Journal entry written to journal.md');
        }
        updateContextFile(loadState());
        execSync('git add -A', {cwd:APP_DIR,stdio:'pipe'});
        const msg=input.summary.replace(/"/g,"'").replace(/\n/g,' ').slice(0,120);
        execSync(`git commit -m "Session end: ${msg}"`, {cwd:APP_DIR,stdio:'pipe'});
        execSync('git push', {cwd:APP_DIR,stdio:'pipe'});
        return {success:true,message:'Journal written. Context synced. Committed and pushed to GitHub.'};
      } catch(e) {
        const msg=(e.stdout||'').toString();
        if(msg.includes('nothing to commit')) return {success:true,message:'Nothing new to commit.'};
        return {error:`Git error: ${msg.slice(0,200)}`};
      }
    }
    default: return {error:`Unknown tool: ${name}`};
  }
}

// ─── CONTEXT SYNC ─────────────────────────────────────────────────────────────
function updateContextFile(state) {
  if (!state||!fs.existsSync(CONTEXT_PATH)) return;
  try {
    let content=fs.readFileSync(CONTEXT_PATH,'utf8');
    const rurik=state.party[0]; const world=state.world;
    const now=new Date().toISOString().slice(0,10);
    const slotNames={level_1:'1st',level_2:'2nd',level_3:'3rd',level_4:'4th',level_5:'5th'};
    const slotParts=Object.entries(rurik.spell_slots).filter(([,v])=>v.max>0).map(([k,v])=>`${v.max-v.used}× ${slotNames[k]}`);
    const allFull=Object.entries(rurik.spell_slots).filter(([,v])=>v.max>0).every(([,v])=>v.used===0);
    const slotsDisplay=slotParts.join(', ')+(allFull?' (full)':'');
    const cd=rurik.channel_divinity;
    const hpTag=rurik.hp===27?'full — long rest complete':rurik.hp>=20?'lightly wounded':rurik.hp>=10?'wounded':'critical';
    const newBlock=`## SESSION STATE — ${world.time}\n\n| Field | Value |\n|---|---|\n| Location | ${world.current_location} |\n| HP | ${rurik.hp} / 27 (${hpTag}) |\n| Spell Slots | ${slotsDisplay||'none'} |\n| Channel Divinity | ${cd.max-cd.used} / ${cd.max} available |`;
    content=content.replace(/## SESSION STATE[\s\S]*?(?=\n---\n)/,newBlock);
    content=content.replace(/\*Last updated: \d{4}-\d{2}-\d{2}/,`*Last updated: ${now}`);
    const recent=state.history_log.slice(-8).map(e=>`- ${e.event}`).join('\n');
    if(recent){const nb=`\n## SESSION NOTES (auto-generated)\n\n${recent}\n`;if(content.includes('## SESSION NOTES')){content=content.replace(/## SESSION NOTES[\s\S]*?(?=\n## |$)/,nb.trim()+'\n');}else{content=content.replace('## CHARACTER QUICK REFERENCE',nb+'\n## CHARACTER QUICK REFERENCE');}}
    fs.writeFileSync(CONTEXT_PATH,content,'utf8');
    console.log('  ✓ Campaign Context full.md synced');
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
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(state) {
  if (!state) return 'You are a D&D 5e Dungeon Master. Use tools for all dice rolls and state changes.';
  const rurik=state.party[0]; const world=state.world;
  const slots=Object.entries(rurik.spell_slots).filter(([,v])=>v.max>0).map(([k,v])=>`Lv${k.replace('level_','')}: ${v.max-v.used}/${v.max}`).join(', ');
  const cd=rurik.channel_divinity;
  // OPTIMIZATION: Only list key items (weapons, spellcasting focus, healing supplies)
  const keyItems=rurik.inventory.filter(i=>['Warhammer','Holy Symbol','Healing Kit','Shield','Chain Mail'].includes(i.name)).map(i=>i.name).join(', ');
  // OPTIMIZATION: Only include active quests with uncompleted steps (1-line summary)
  const questSummary=(state.quests||[]).filter(q=>q.status==='active'&&q.steps.some(s=>!s.completed)).map(q=>`${q.title}: ${q.steps.filter(s=>!s.completed).map(s=>s.description).join(', ')}`).join(' | ');

  // New campaign — character creation mode
  if (state.campaign_id === 'new-campaign') {
    return `You are a D&D 5e Dungeon Master. Guide character creation step by step: race, class, background, ability scores, equipment, backstory. Be enthusiastic. Use tools to set name, class, level, and stats when complete.`;
  }

  return `You are the Dungeon Master for a solo D&D 5e campaign. Use tools for ALL mechanics (never narrate rolls/HP changes without calling the right tool).

RULES:
- Roll EVERY dice check with roll_dice. EXCEPTION: if player sends "[Player rolled X: total N...]" that's already done—just narrate outcome.
- Call use_spell_slot when spells cast, update_hp after damage/healing, end_session when player quits.
- ALWAYS include prose narration alongside tool calls. No tool-only responses.

═══════════════════════
CAMPAIGN: Lost Mine of Phandelver — Witness Arc
Location: ${world.current_location} | Time: ${world.time} | Seal: ${world.seal_integrity}%

CHARACTER: ${rurik.name} | ${rurik.class} L${rurik.level} | HP: ${rurik.hp}/27 | AC: 18
Spells: ${slots||'none'} | CD: ${cd.max-cd.used}/${cd.max} | DC 13 | Atk +5
Gear: ${keyItems||'standard equipment'}

ACTIVE: ${questSummary||'Awaiting orders'}

SITUATION: ${world.lore_summary}
ANTAGONISTS: Silga (Redbrand, Phandalin) | Mind Flayer (location unknown)
KEY: Iarno knows 3-5am road gap. Three escape routes exist. Harpers arrive Day 9.`;
}

// ─── AGENTIC DM LOOP ──────────────────────────────────────────────────────────
function makeAPICall(bodyStr) {
  return new Promise((resolve,reject)=>{
    // Rate limit throttling: enforce minimum delay between requests to spread token usage
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < REQUEST_DELAY_MS) {
      setTimeout(() => {
        makeAPICall(bodyStr).then(resolve).catch(reject);
      }, REQUEST_DELAY_MS - timeSinceLastRequest);
      return;
    }
    lastRequestTime = Date.now();

    const buf=Buffer.from(bodyStr);
    const req=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','Content-Length':buf.length,'x-api-key':API_KEY,'anthropic-version':'2023-06-01'}},(res)=>{
      // CRITICAL: detect non-200 responses BEFORE handing the stream to the streaming parser.
      // Anthropic returns errors (400, 401, 429, 500, 529) as a JSON body, not as SSE.
      // If we don't catch this here, the streaming parser sees no "data: " lines and the
      // turn looks empty — which is the root cause of "Empty assistant turn" failures.
      if(res.statusCode!==200){
        let body='';
        res.setEncoding('utf8');
        res.on('data',c=>body+=c);
        res.on('end',()=>{
          let errMsg=`HTTP ${res.statusCode}`;
          try{const j=JSON.parse(body); if(j.error?.message)errMsg=`HTTP ${res.statusCode} — ${j.error.type||'error'}: ${j.error.message}`;}catch{}
          if(errMsg===`HTTP ${res.statusCode}`)errMsg+=`: ${body.slice(0,300)}`;
          const err=new Error(errMsg);
          err.statusCode=res.statusCode;
          err.body=body;
          reject(err);
        });
        res.on('error',reject);
        return;
      }
      resolve(res);
    });
    req.on('error',reject);
    req.write(buf); req.end();
  });
}

async function streamAgenticLoop(messages, systemPrompt, res) {
  let totalTokens=0;
  let apiError=null;
  console.log(`  ▶ Agentic loop start — ${messages.length} messages in context`);
  for (let loop=0;loop<6;loop++){
    const body=JSON.stringify({model:MODEL,max_tokens:1200,system:systemPrompt,tools:TOOLS,messages,stream:true});
    let apiRes;
    try {
      apiRes=await makeAPICall(body);
    } catch(err) {
      apiError=err.message||String(err);
      console.error(`  ✗ Loop ${loop} API call failed: ${apiError}`);
      res.write(`data: ${JSON.stringify({type:'error',error:apiError})}\n\n`);
      break;
    }
    let textTurn='',toolUses=[],currentTU=null,currentJson='',stopReason='end_turn',stateUpdated=false,streamErr=null;
    await new Promise(resolve=>{
      apiRes.on('data',chunk=>{
        for(const line of chunk.toString().split('\n')){
          if(!line.startsWith('data: '))continue;
          try{
            const d=JSON.parse(line.slice(6));
            if(d.type==='error'){streamErr=d.error?.message||'Anthropic streaming error';console.error('  ✗ Stream error:',streamErr);res.write(`data: ${JSON.stringify({type:'error',error:streamErr})}\n\n`);}
            if(d.type==='content_block_start'&&d.content_block.type==='tool_use'){currentTU={id:d.content_block.id,name:d.content_block.name};currentJson='';}
            if(d.type==='content_block_delta'){if(d.delta.type==='text_delta'){textTurn+=d.delta.text;res.write(`data: ${JSON.stringify({type:'text',content:d.delta.text})}\n\n`);}if(d.delta.type==='input_json_delta')currentJson+=d.delta.partial_json;}
            if(d.type==='content_block_stop'&&currentTU){try{currentTU.input=JSON.parse(currentJson);}catch{currentTU.input={};}toolUses.push(currentTU);currentTU=null;currentJson='';}
            if(d.type==='message_delta'){stopReason=d.delta.stop_reason||'end_turn';if(d.usage)totalTokens+=d.usage.output_tokens||0;}
          }catch{}
        }
      });
      apiRes.on('end',resolve);
      apiRes.on('error',e=>{streamErr=e.message;resolve();});
    });
    console.log(`  ⟳ Loop ${loop}: text=${textTurn.length}c, tools=${toolUses.length}${toolUses.length?` [${toolUses.map(t=>t.name).join(',')}]`:''}, stop=${stopReason}${streamErr?`, streamErr=${streamErr}`:''}`);
    if(streamErr){apiError=streamErr;break;}
    const assistantContent=[];
    if(textTurn)assistantContent.push({type:'text',text:textTurn});
    for(const tu of toolUses)assistantContent.push({type:'tool_use',id:tu.id,name:tu.name,input:tu.input});
    if(assistantContent.length)messages.push({role:'assistant',content:assistantContent});
    if(stopReason!=='tool_use'||!toolUses.length)break;
    const toolResults=[];
    for(const tu of toolUses){
      const result=executeTool(tu.name,tu.input);
      if(result.state_updated){stateUpdated=true;}
      if(result.music_scene){res.write(`data: ${JSON.stringify({type:'music_scene',scene:result.scene})}\n\n`);}
      if(result.combat_started){res.write(`data: ${JSON.stringify({type:'combat_started',enemies:result.enemies})}\n\n`);}
      toolResults.push({type:'tool_result',tool_use_id:tu.id,content:JSON.stringify(result)});
    }
    if(stateUpdated){const ns=loadState();if(ns)res.write(`data: ${JSON.stringify({type:'state_update',state:ns})}\n\n`);}
    toolResults.push({type:'text',text:'Tools executed. You MUST now write DM narration — describe what happens next in the scene. Do not call any more tools in this response unless strictly required.'});
    messages.push({role:'user',content:toolResults});
  }
  console.log(`  ▶ Agentic loop end — totalTokens=${totalTokens}${apiError?`, apiError=${apiError}`:''}`);
  return {totalTokens, apiError};
}

// ─── HTTP SERVERS ─────────────────────────────────────────────────────────────
const campaignApiServer = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}
  if(req.method==='GET'&&req.url==='/api/state'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(loadState()));return;}
  if(req.method==='POST'&&req.url==='/api/state'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{try{const s=JSON.parse(body);saveState(s);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,state:s}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});return;}
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
        const MAX_HISTORY_MESSAGES=20;
        const allMapped=history.messages.map(m=>({role:m.role,content:m.content}));
        const messagesForAPI=allMapped.length>MAX_HISTORY_MESSAGES?allMapped.slice(-MAX_HISTORY_MESSAGES):allMapped;
        const systemPrompt=buildSystemPrompt(loadState());
        console.log(`\n  ━━━ Chat request — history=${history.messages.length} msgs (sending last ${messagesForAPI.length}), est tokens=${history.token_count} ━━━`);
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
    console.log('  ANTHROPIC_API_KEY=sk-ant-...');
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
    console.log('  ✓ Claude DM      → localhost:3141');
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

process.on('SIGINT', () => {
  console.log('\n  Shutting down servers...');
  campaignApiServer.close();
  relayServer.close();
  dashboardServer.close();
  process.exit(0);
});

main();
