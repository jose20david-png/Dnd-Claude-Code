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

const MODEL                = 'claude-haiku-4-5';
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;
const PORTS                = [3140, 3141, 8080];

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
  console.log('  ║   RURIK STORMHAMMER — BEARER OF THE SEAL            ║');
  console.log('  ║   Lost Mine of Phandelver · The Witness Arc          ║');
  console.log('  ║                                                      ║');
  console.log('  ║   Cleric (Storm Domain) · Level 3 · Day 7           ║');
  console.log('  ║   Old Marta\'s Cabin · Escape route undecided        ║');
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
   input_schema:{type:'object',properties:{scene:{type:'string',enum:['exploration','combat','rest','tavern','silence'],description:'exploration=travel/adventure, combat=battle/tension, rest=safe downtime/camp, tavern=social/inn, silence=dramatic pause'}},required:['scene']}}
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
  const inv=rurik.inventory.map(i=>`${i.name}${i.quantity>1?` ×${i.quantity}`:''}`).join(', ');
  const activeQuests=(state.quests||[]).filter(q=>q.status==='active').map(q=>`${q.title}\n${q.steps.map(s=>`  ${s.completed?'[x]':'[ ]'} ${s.description}`).join('\n')}`).join('\n\n');
  const allies=(state.npcs||[]).filter(n=>['ally','redeemed-enemy','civilian-ally'].includes(n.role)).map(n=>`• ${n.name} (${n.location}) — ${n.personality}`).join('\n');

  // New campaign — character creation mode
  if (state.campaign_id === 'new-campaign') {
    return `You are a D&D 5e Dungeon Master. A new campaign is starting — the player has not yet created their character. Guide them through D&D 5e character creation step by step: race, class, background, ability scores, starting equipment, and backstory. Be enthusiastic and helpful. Once the character is complete, use the tools to set their name, class, level, and starting stats in the campaign state, then begin the adventure.`;
  }

  return `You are the Dungeon Master running a solo D&D 5e campaign. Use tools for ALL mechanical actions — never narrate a dice roll without calling roll_dice, never describe HP/slot changes without the corresponding tool.

RULES:
- Call roll_dice for EVERY dice roll (attacks, saves, damage, checks, initiative) — EXCEPTION: if the player sends "[Player rolled X: total N ...]", that roll is already done; DO NOT re-roll it, just narrate the outcome
- Call use_spell_slot immediately when a leveled spell is cast
- Call update_hp after any damage or healing resolves
- YOU MUST ALWAYS write narrative text. Every single response must contain prose narration — never reply with tool calls alone. Even if you call five tools, you MUST also write at least one sentence of DM narration in the same response turn.
- Call end_session when the player says they are done for the day; the recap field must be 2-3 paragraphs of vivid narrative prose describing the session's key events, decisions, and dramatic moments — written like a campaign diary entry, not a list

═══════════════════════
CAMPAIGN: Lost Mine of Phandelver — The Witness Arc
Location: ${world.current_location}
Time: ${world.time}
Seal: ${world.seal_integrity}% (${world.seal_status})
Situation: ${world.lore_summary}

CHARACTER — ${rurik.name} | ${rurik.class} Lv${rurik.level}
HP: ${rurik.hp}/27 | AC: 18 | Prof: +2
Slots: ${slots||'none'} | CD: ${cd.max-cd.used}/${cd.max}
Spell DC 13 | Spell Attack +5
Inventory: ${inv}

ACTIVE QUESTS
${activeQuests||'None active'}

ALLIES AT ${world.current_location.toUpperCase()}
${allies||'None'}

ANTAGONISTS
• Silga — Redbrand field commander, Phandalin, 8-12 soldiers
• The Mind Flayer — location unknown

KEY INTEL: Iarno knows patrol schedules & 3-5am south road gap. Qelline scouted all three escape routes. Harpers arrive Day 9.
PENDING: South Road (3-5am gap) / Forest Path NE / Wait for Harpers`;
}

// ─── AGENTIC DM LOOP ──────────────────────────────────────────────────────────
function makeAPICall(bodyStr) {
  return new Promise((resolve,reject)=>{
    const buf=Buffer.from(bodyStr);
    const req=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','Content-Length':buf.length,'x-api-key':API_KEY,'anthropic-version':'2023-06-01'}},resolve);
    req.on('error',reject);
    req.write(buf); req.end();
  });
}

async function streamAgenticLoop(messages, systemPrompt, res) {
  let totalTokens=0;
  for (let loop=0;loop<6;loop++){
    const body=JSON.stringify({model:MODEL,max_tokens:2000,system:systemPrompt,tools:TOOLS,messages,stream:true});
    const apiRes=await makeAPICall(body);
    let textTurn='',toolUses=[],currentTU=null,currentJson='',stopReason='end_turn',stateUpdated=false;
    await new Promise(resolve=>{
      apiRes.on('data',chunk=>{
        for(const line of chunk.toString().split('\n')){
          if(!line.startsWith('data: '))continue;
          try{
            const d=JSON.parse(line.slice(6));
            if(d.type==='error'){const em=d.error?.message||'Anthropic API error';console.error('  ✗ API:',em);res.write(`data: ${JSON.stringify({type:'error',error:em})}\n\n`);}
            if(d.type==='content_block_start'&&d.content_block.type==='tool_use'){currentTU={id:d.content_block.id,name:d.content_block.name};currentJson='';}
            if(d.type==='content_block_delta'){if(d.delta.type==='text_delta'){textTurn+=d.delta.text;res.write(`data: ${JSON.stringify({type:'text',content:d.delta.text})}\n\n`);}if(d.delta.type==='input_json_delta')currentJson+=d.delta.partial_json;}
            if(d.type==='content_block_stop'&&currentTU){try{currentTU.input=JSON.parse(currentJson);}catch{currentTU.input={};}toolUses.push(currentTU);currentTU=null;currentJson='';}
            if(d.type==='message_delta'){stopReason=d.delta.stop_reason||'end_turn';if(d.usage)totalTokens+=d.usage.output_tokens||0;}
          }catch{}
        }
      });
      apiRes.on('end',resolve);
    });
    const assistantContent=[];
    if(textTurn)assistantContent.push({type:'text',text:textTurn});
    for(const tu of toolUses)assistantContent.push({type:'tool_use',id:tu.id,name:tu.name,input:tu.input});
    if(assistantContent.length)messages.push({role:'assistant',content:assistantContent});
    if(stopReason!=='tool_use'||!toolUses.length)break;
    const toolResults=[];
    for(const tu of toolUses){
      console.log(`  🔧 ${tu.name}`);
      const result=executeTool(tu.name,tu.input);
      if(result.state_updated){stateUpdated=true;}
      if(result.music_scene){res.write(`data: ${JSON.stringify({type:'music_scene',scene:result.scene})}\n\n`);}
      toolResults.push({type:'tool_result',tool_use_id:tu.id,content:JSON.stringify(result)});
    }
    if(stateUpdated){const ns=loadState();if(ns)res.write(`data: ${JSON.stringify({type:'state_update',state:ns})}\n\n`);}
    toolResults.push({type:'text',text:'Tools executed. You MUST now write DM narration — describe what happens next in the scene. Do not call any more tools in this response unless strictly required.'});
    messages.push({role:'user',content:toolResults});
  }
  return totalTokens;
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
        const messagesForAPI=history.messages.map(m=>({role:m.role,content:m.content}));
        const systemPrompt=buildSystemPrompt(loadState());
        const outTokens=await streamAgenticLoop(messagesForAPI,systemPrompt,res);
        let finalText='';
        for(let i=history.messages.length;i<messagesForAPI.length;i++){const m=messagesForAPI[i];if(m.role==='assistant'){if(Array.isArray(m.content))finalText+=m.content.filter(b=>b.type==='text').map(b=>b.text).join('');else if(typeof m.content==='string')finalText+=m.content;}}
        // Emergency fallback: tools ran but Claude produced no text — force one narration turn
        if(!finalText.trim()&&messagesForAPI.length>history.messages.length+1){
          console.warn('  ⚠️  No narration after tools — forcing follow-up narration call');
          messagesForAPI.push({role:'user',content:'You called tools but wrote no narration. Write your DM response now — describe what happens in the scene.'});
          await streamAgenticLoop(messagesForAPI,systemPrompt,res);
          for(let i=history.messages.length;i<messagesForAPI.length;i++){const m=messagesForAPI[i];if(m.role==='assistant'){if(Array.isArray(m.content))finalText+=m.content.filter(b=>b.type==='text').map(b=>b.text).join('');else if(typeof m.content==='string')finalText+=m.content;}}
        }
        if(finalText.trim()){
          // Only persist the exchange when the assistant actually produced text
          history.messages.push({role:'assistant',content:finalText});
          history.token_count+=estimateTokens(prompt)+(outTokens||estimateTokens(finalText));
          history.model=MODEL;
          saveHistory(history);
        } else {
          // No text produced (API error or tool-only turn with no follow-up narration)
          // Roll back the user message so history stays clean and the next request succeeds
          history.messages.pop();
          saveHistory(history);
          console.error('  ✗ Empty assistant turn — user message rolled back from history');
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

// ─── MAIN MENU ────────────────────────────────────────────────────────────────
function showMenu(hasSave, callback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('  ┌─────────────────────────────────┐');
  if (hasSave) {
    console.log('  │   [1]  Continue Campaign        │');
  } else {
    console.log('  │   [1]  Start Campaign           │');
  }
  console.log('  │   [2]  New Campaign             │');
  console.log('  │   [3]  Quit                     │');
  console.log('  └─────────────────────────────────┘');
  console.log('');

  function ask() {
    rl.question('  > ', answer => {
      const choice = answer.trim();
      if (choice === '1') { rl.close(); callback('continue'); }
      else if (choice === '2') { rl.close(); callback('new'); }
      else if (choice === '3') { rl.close(); callback('quit'); }
      else { console.log('  Please enter 1, 2, or 3.'); ask(); }
    });
  }
  ask();
}

function confirmNewCampaign(callback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('');
  console.log('  ⚠️  NEW CAMPAIGN will erase ALL current progress.');
  console.log('  This cannot be undone. Type YES to confirm:');
  console.log('');
  rl.question('  > ', answer => {
    rl.close();
    callback(answer.trim().toUpperCase() === 'YES');
  });
}

function resetToBrandNew() {
  // Wipe state and history
  saveState(JSON.parse(JSON.stringify(BLANK_STATE)));
  saveHistory({ messages: [], created_at: new Date().toISOString(), token_count: 0, model: MODEL });
  // Optionally clear context file notes section
  try {
    if (fs.existsSync(CONTEXT_PATH)) {
      let ctx = fs.readFileSync(CONTEXT_PATH, 'utf8');
      ctx = ctx.replace(/## SESSION NOTES[\s\S]*?(?=\n## |$)/,'');
      fs.writeFileSync(CONTEXT_PATH, ctx, 'utf8');
    }
  } catch {}
  console.log('');
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
          // Re-show menu
          setTimeout(() => main(), 500);
          return;
        }
        resetToBrandNew();
        launchGame();
      });
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
