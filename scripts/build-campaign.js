#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// build-campaign.js
// Parses a Markdown campaign file and writes a ready-to-load save bundle
// into the saves/ folder.
//
// Usage:
//   node scripts/build-campaign.js "path/to/my-campaign.md"
//   node scripts/build-campaign.js          (prompts for path)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const APP_DIR   = path.join(__dirname, '..');
const SAVES_DIR = path.join(APP_DIR, 'saves');

// ─── SPELL SLOT TABLES (D&D 5e PHB) ──────────────────────────────────────────

// Full casters: Wizard, Sorcerer, Cleric, Druid, Bard, Artificer
const FULL_CASTER_SLOTS = [
  //  L1  L2  L3  L4  L5  L6  L7  L8  L9
  [0,  2,  0,  0,  0,  0,  0,  0,  0,  0],  // level 1
  [0,  3,  0,  0,  0,  0,  0,  0,  0,  0],  // level 2
  [0,  4,  2,  0,  0,  0,  0,  0,  0,  0],  // level 3
  [0,  4,  3,  0,  0,  0,  0,  0,  0,  0],  // level 4
  [0,  4,  3,  2,  0,  0,  0,  0,  0,  0],  // level 5
  [0,  4,  3,  3,  0,  0,  0,  0,  0,  0],  // level 6
  [0,  4,  3,  3,  1,  0,  0,  0,  0,  0],  // level 7
  [0,  4,  3,  3,  2,  0,  0,  0,  0,  0],  // level 8
  [0,  4,  3,  3,  3,  1,  0,  0,  0,  0],  // level 9
  [0,  4,  3,  3,  3,  2,  0,  0,  0,  0],  // level 10
  [0,  4,  3,  3,  3,  2,  1,  0,  0,  0],  // level 11
  [0,  4,  3,  3,  3,  2,  1,  0,  0,  0],  // level 12
  [0,  4,  3,  3,  3,  2,  1,  1,  0,  0],  // level 13
  [0,  4,  3,  3,  3,  2,  1,  1,  0,  0],  // level 14
  [0,  4,  3,  3,  3,  2,  1,  1,  1,  0],  // level 15
  [0,  4,  3,  3,  3,  2,  1,  1,  1,  0],  // level 16
  [0,  4,  3,  3,  3,  2,  1,  1,  1,  1],  // level 17
  [0,  4,  3,  3,  3,  3,  1,  1,  1,  1],  // level 18
  [0,  4,  3,  3,  3,  3,  2,  1,  1,  1],  // level 19
  [0,  4,  3,  3,  3,  3,  2,  2,  1,  1],  // level 20
];

// Half casters: Paladin, Ranger (spells start at level 2)
const HALF_CASTER_SLOTS = [
  [0,  0,  0,  0,  0,  0],  // level 1
  [0,  2,  0,  0,  0,  0],  // level 2
  [0,  3,  0,  0,  0,  0],  // level 3
  [0,  3,  0,  0,  0,  0],  // level 4
  [0,  4,  2,  0,  0,  0],  // level 5
  [0,  4,  2,  0,  0,  0],  // level 6
  [0,  4,  3,  0,  0,  0],  // level 7
  [0,  4,  3,  0,  0,  0],  // level 8
  [0,  4,  3,  2,  0,  0],  // level 9
  [0,  4,  3,  2,  0,  0],  // level 10
  [0,  4,  3,  3,  0,  0],  // level 11
  [0,  4,  3,  3,  0,  0],  // level 12
  [0,  4,  3,  3,  1,  0],  // level 13
  [0,  4,  3,  3,  1,  0],  // level 14
  [0,  4,  3,  3,  2,  0],  // level 15
  [0,  4,  3,  3,  2,  0],  // level 16
  [0,  4,  3,  3,  3,  1],  // level 17
  [0,  4,  3,  3,  3,  1],  // level 18
  [0,  4,  3,  3,  3,  2],  // level 19
  [0,  4,  3,  3,  3,  2],  // level 20
];

// Warlock pact magic: [slots, slot_level]
const WARLOCK_SLOTS = [
  [1, 1], [2, 1], [2, 2], [2, 2],  // 1-4
  [2, 3], [2, 3], [2, 4], [2, 4],  // 5-8
  [2, 5], [2, 5],                  // 9-10
  [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], // 11-16
  [4, 5], [4, 5], [4, 5], [4, 5], // 17-20
];

// Cantrips known by class at level bands
const CANTRIPS_BY_CLASS = {
  wizard:     [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  sorcerer:   [0, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
  cleric:     [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  druid:      [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  bard:       [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  warlock:    [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  artificer:  [0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
};

function classCategory(cls) {
  const c = cls.toLowerCase().replace(/\s+.*/,''); // take first word
  const full = ['wizard','sorcerer','cleric','druid','bard','artificer'];
  const half = ['paladin','ranger'];
  const warlock = ['warlock'];
  if (full.includes(c)) return 'full';
  if (half.includes(c)) return 'half';
  if (warlock.includes(c)) return 'warlock';
  return 'none';
}

function getSpellSlots(cls, level) {
  const cat = classCategory(cls);
  const lvl = Math.min(Math.max(level, 1), 20);
  const slots = { cantrip: { max: 0, used: 0 } };
  for (let i = 1; i <= 9; i++) slots[`level_${i}`] = { max: 0, used: 0 };

  const clsKey = cls.toLowerCase().replace(/\s+.*/,'');
  slots.cantrip.max = (CANTRIPS_BY_CLASS[clsKey] || [])[lvl] || 0;

  if (cat === 'full') {
    const row = FULL_CASTER_SLOTS[lvl - 1];
    for (let i = 1; i <= 9; i++) slots[`level_${i}`].max = row[i] || 0;
  } else if (cat === 'half') {
    const row = HALF_CASTER_SLOTS[lvl - 1];
    for (let i = 1; i <= 5; i++) slots[`level_${i}`].max = row[i] || 0;
  } else if (cat === 'warlock') {
    const [count, slotLvl] = WARLOCK_SLOTS[lvl - 1];
    slots[`level_${slotLvl}`].max = count;
  }
  return slots;
}

function getChannelDivinity(cls, level) {
  const c = cls.toLowerCase();
  if (c.includes('cleric') || c.includes('paladin')) {
    const uses = level >= 6 ? 3 : level >= 2 ? 2 : 0;
    return { max: uses, used: 0 };
  }
  return { max: 0, used: 0 };
}

// ─── MARKDOWN PARSER ─────────────────────────────────────────────────────────

function parseMd(text) {
  const lines = text.split('\n');
  const result = {
    title: '',
    campaignId: '',
    setting: 'Forgotten Realms',
    lore: '',
    character: {},
    world: {},
    inventory: [],
    spellSlots: null,  // null = auto-detect
    quests: [],
    npcs: [],
    notes: '',
  };

  let section = null;
  let subBlock = null;  // current quest / NPC being built

  function clean(str) {
    return str
      .replace(/<!--.*?-->/g, '')  // strip HTML comments
      .replace(/\*{1,3}/g, '')     // strip bold/italic markers
      .trim();
  }
  function field(line) {
    const l = clean(line).replace(/^[-*]\s*/, ''); // strip list marker
    const idx = l.indexOf(':');
    if (idx === -1) return null;
    const key = l.slice(0, idx).trim().toLowerCase();
    const value = l.slice(idx + 1).trim();
    return key && value ? [key, value] : null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // H1 = campaign title
    if (/^# /.test(line)) {
      result.title = line.replace(/^# /, '').trim();
      section = null;
      continue;
    }

    // H2 = section headers
    if (/^## /.test(line)) {
      const s = line.replace(/^## /, '').toLowerCase().trim();
      if      (/^campaign/.test(s))  section = 'campaign';
      else if (/^character/.test(s)) section = 'character';
      else if (/^world/.test(s))     section = 'world';
      else if (/^inventor/.test(s))  section = 'inventory';
      else if (/^quest/.test(s))     section = 'quests';
      else if (/^npc/.test(s))       section = 'npcs';
      else if (/^spell/.test(s))     section = 'spellslots';
      else if (/^note/.test(s))      section = 'notes';
      else                           section = null;
      subBlock = null;
      continue;
    }

    // H3 = quest or NPC name
    if (/^### /.test(line)) {
      const name = line.replace(/^### /, '').trim();
      if (section === 'quests') {
        subBlock = { title: name, status: 'active', description: '', steps: [] };
        result.quests.push(subBlock);
      } else if (section === 'npcs') {
        subBlock = { name, role: '', disposition: 'neutral', notes: '' };
        result.npcs.push(subBlock);
      }
      continue;
    }

    if (!line) continue;

    // ── CAMPAIGN section ──
    if (section === 'campaign') {
      const kv = field(line);
      if (!kv) continue;
      const [k, v] = kv;
      if (k === 'id' || k === 'campaign id') result.campaignId = v;
      else if (k === 'setting' || k === 'world') result.setting = v;
      else if (k === 'lore' || k === 'description' || k === 'premise') result.lore = v;
      continue;
    }

    // ── CHARACTER section ──
    if (section === 'character') {
      const kv = field(line);
      if (!kv) continue;
      const [k, v] = kv;
      if      (k === 'name')                        result.character.name = v;
      else if (k === 'race')                        result.character.race = v;
      else if (k === 'class')                       result.character.class = v;
      else if (k === 'subclass' || k === 'archetype') result.character.subclass = v;
      else if (k === 'level')                       result.character.level = parseInt(v) || 1;
      else if (k === 'hp' || k === 'hit points' || k === 'max hp') {
        const hp = parseInt(v.split('/')[0]) || 10;
        result.character.hp = hp;
        result.character.hpMax = hp;
      }
      else if (k === 'background')                  result.character.background = v;
      else if (k === 'alignment')                   result.character.alignment = v;
      else if (k === 'id')                          result.character.id = v;
      continue;
    }

    // ── WORLD section ──
    if (section === 'world') {
      const kv = field(line);
      if (!kv) continue;
      const [k, v] = kv;
      if      (k === 'location' || k === 'starting location') result.world.location = v;
      else if (k === 'time' || k === 'starting time')         result.world.time = v;
      else if (k === 'lore' || k === 'description')           result.lore = result.lore || v;
      continue;
    }

    // ── INVENTORY section ──
    // Supports: "- Item Name (qty, rarity)" or "- Item Name"
    if (section === 'inventory' && /^[-*]/.test(line)) {
      const stripped = clean(line).replace(/^[-*]\s*/, '');
      const m = stripped.match(/^(.+?)\s*\((\d+),\s*([^)]+)\)\s*$/);
      if (m) {
        result.inventory.push({ name: m[1].trim(), quantity: parseInt(m[2]), rarity: m[3].trim().toLowerCase() });
      } else {
        // Just a name, or "Name x2"
        const m2 = stripped.match(/^(.+?)\s*[x×](\d+)\s*$/i);
        if (m2) {
          result.inventory.push({ name: m2[1].trim(), quantity: parseInt(m2[2]), rarity: 'common' });
        } else if (stripped) {
          result.inventory.push({ name: stripped.trim(), quantity: 1, rarity: 'common' });
        }
      }
      continue;
    }

    // ── SPELL SLOTS section ──
    if (section === 'spellslots') {
      if (result.spellSlots === null) result.spellSlots = {};
      const lower = line.toLowerCase();
      if (/cantrip/.test(lower)) {
        const n = parseInt(line.match(/\d+/)?.[0]) || 0;
        result.spellSlots.cantrip = { max: n, used: 0 };
      } else {
        const m = line.match(/level\s*(\d+)[^/\d]*(\d+)\s*(?:\/\s*(\d+))?/i);
        if (m) {
          const lvl = parseInt(m[1]);
          const used = parseInt(m[2]);
          const max  = m[3] ? parseInt(m[3]) : used;
          // If written as "Level 1: 4/4" => max=4,used=0 (full)
          // If written as "Level 1: 2/4" => max=4,used=2 (partially spent)
          const actualUsed = m[3] ? (max - used) : 0; // "available/max" vs just "max"
          result.spellSlots[`level_${lvl}`] = { max: max, used: actualUsed };
        }
      }
      continue;
    }

    // ── QUESTS section ──
    if (section === 'quests' && subBlock) {
      const kv = field(line);
      if (kv) {
        const [k, v] = kv;
        if      (k === 'status')      subBlock.status = v.toLowerCase();
        else if (k === 'description') subBlock.description = v;
        else if (k === 'giver' || k === 'quest giver') subBlock.giver = v;
        continue;
      }
      // Quest step: "- [ ] step" or "- [x] step" or "- step"
      if (/^[-*]/.test(line)) {
        const completed = /\[x\]/i.test(line);
        const desc = line.replace(/^[-*]\s*/, '').replace(/\[[x ]\]\s*/i, '').trim();
        if (desc) subBlock.steps.push({ description: desc, completed });
      }
      continue;
    }

    // ── NPCS section ──
    if (section === 'npcs' && subBlock) {
      const kv = field(line);
      if (kv) {
        const [k, v] = kv;
        if      (k === 'role' || k === 'occupation') subBlock.role = v;
        else if (k === 'disposition' || k === 'attitude') subBlock.disposition = v.toLowerCase();
        else if (k === 'notes' || k === 'description') subBlock.notes = v;
        else if (k === 'location') subBlock.location = v;
      }
      continue;
    }

    // ── NOTES section ──
    if (section === 'notes') {
      result.notes += (result.notes ? '\n' : '') + line;
      continue;
    }
  }

  return result;
}

// ─── STATE BUILDER ────────────────────────────────────────────────────────────

function buildState(parsed) {
  const char  = parsed.character;
  const level = char.level || 1;
  const cls   = char.class || 'Fighter';
  const clsDisplay = char.subclass ? `${cls} (${char.subclass})` : cls;

  // Auto-detect spell slots unless explicitly given
  const spellSlots = parsed.spellSlots
    ? { ...{ cantrip:{max:0,used:0}, level_1:{max:0,used:0}, level_2:{max:0,used:0},
             level_3:{max:0,used:0}, level_4:{max:0,used:0}, level_5:{max:0,used:0},
             level_6:{max:0,used:0}, level_7:{max:0,used:0}, level_8:{max:0,used:0},
             level_9:{max:0,used:0} }, ...parsed.spellSlots }
    : getSpellSlots(cls, level);

  const channelDivinity = getChannelDivinity(cls, level);

  // Slug for campaign_id
  const titleSlug = parsed.title
    ? parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g,'')
    : 'custom-campaign';
  const campaignId = parsed.campaignId || titleSlug;

  const charId = char.id || (char.name || 'player').toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  const hp     = char.hp || 10;
  const hpText = `${hp} / ${hp} (full)`;

  const state = {
    campaign_id: campaignId,
    campaign_title: parsed.title || 'Unnamed Campaign',
    world: {
      name: parsed.setting || 'Forgotten Realms',
      lore_summary: parsed.lore || parsed.notes || `Campaign: ${parsed.title}`,
      current_location: parsed.world.location || 'Starting Location',
      time: parsed.world.time || 'Day 1 — Morning',
      seal_integrity: 100,
      seal_status: 'N/A',
    },
    party: [
      {
        id: charId,
        name: char.name || 'Unknown',
        race: char.race || '',
        class: clsDisplay,
        level: level,
        hp: hp,
        background: char.background || '',
        alignment: char.alignment || '',
        status: 'active',
        spell_slots: spellSlots,
        channel_divinity: channelDivinity,
        inventory: parsed.inventory,
      }
    ],
    npcs: parsed.npcs.map(n => ({
      id: n.name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,''),
      name: n.name,
      role: n.role,
      disposition: n.disposition,
      notes: n.notes,
      location: n.location || parsed.world.location || '',
    })),
    quests: parsed.quests.map((q, idx) => ({
      id: `quest-${idx+1}`,
      title: q.title,
      status: q.status,
      description: q.description,
      giver: q.giver || '',
      steps: q.steps,
    })),
    encounters: [],
    history_log: [
      {
        timestamp: new Date().toISOString(),
        event: `Campaign imported from Markdown. Title: "${parsed.title}". Character: ${char.name || '?'}, ${clsDisplay} Level ${level}.`
      }
    ],
  };

  return state;
}

// ─── SAVE WRITER ─────────────────────────────────────────────────────────────

function writeSave(state, sourcePath) {
  if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });

  const p = state.party[0];
  const meta = {
    character:   p.name,
    race:        p.race || '',
    class:       p.class,
    level:       p.level,
    hp:          p.hp,
    location:    state.world.current_location,
    time:        state.world.time,
    campaign_id: state.campaign_id,
    campaign_title: state.campaign_title,
    saved_at:    new Date().toISOString(),
    messages:    0,
    source:      sourcePath ? path.basename(sourcePath) : 'manual',
  };

  const charSlug = p.name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  const timeTag  = new Date().toISOString().replace(/[:T]/g,'-').slice(0, 16);
  const filename = `${charSlug}_${timeTag}.json`;
  const savePath = path.join(SAVES_DIR, filename);

  const bundle = {
    meta,
    state,
    history: { messages: [], token_count: 0, model: 'claude-haiku-4-5' },
  };

  fs.writeFileSync(savePath, JSON.stringify(bundle, null, 2), 'utf8');
  return filename;
}

// ─── PRETTY PRINTER ──────────────────────────────────────────────────────────

function printSummary(state, filename) {
  const p  = state.party[0];
  const w  = state.world;
  const slots = p.spell_slots;
  const slotStr = Object.entries(slots)
    .filter(([k, v]) => v.max > 0)
    .map(([k, v]) => `${k.replace('level_','L').replace('cantrip','Cantrips')}: ${v.max}`)
    .join('  ');

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log(`  ║  Campaign imported successfully                       ║`);
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log(`  ║  ${(state.campaign_title).padEnd(52)}║`);
  console.log('  ║                                                      ║');
  console.log(`  ║  Character  ${p.name.padEnd(40)}║`);
  console.log(`  ║  Class      ${p.class.padEnd(40)}║`);
  console.log(`  ║  Level      ${String(p.level).padEnd(40)}║`);
  console.log(`  ║  HP         ${String(p.hp).padEnd(40)}║`);
  console.log(`  ║  Location   ${w.current_location.padEnd(40)}║`);
  if (slotStr) {
  console.log(`  ║  Slots      ${slotStr.padEnd(40)}║`);
  }
  if (state.quests.length) {
  console.log(`  ║  Quests     ${String(state.quests.length).padEnd(40)}║`);
  }
  if (state.npcs.length) {
  console.log(`  ║  NPCs       ${String(state.npcs.length).padEnd(40)}║`);
  }
  if (p.inventory.length) {
  console.log(`  ║  Inventory  ${String(p.inventory.length) + ' items'} ${' '.repeat(Math.max(0, 34 - String(p.inventory.length + ' items').length))}║`);
  }
  console.log('  ║                                                      ║');
  console.log(`  ║  Saved to:  saves/${filename.padEnd(32)}║`);
  console.log('  ║                                                      ║');
  console.log('  ║  Run the launcher and choose [Load Campaign] to play ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  let mdPath = process.argv[2];

  if (!mdPath) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    mdPath = await new Promise(resolve => {
      rl.question('  Path to campaign .md file: ', answer => {
        rl.close();
        resolve(answer.trim().replace(/^["']|["']$/g, ''));
      });
    });
  }

  if (!mdPath) {
    console.error('  No file provided. Exiting.');
    process.exit(1);
  }

  // Resolve relative to cwd or APP_DIR
  if (!path.isAbsolute(mdPath)) {
    mdPath = path.resolve(process.cwd(), mdPath);
    if (!fs.existsSync(mdPath)) {
      mdPath = path.resolve(APP_DIR, mdPath);
    }
  }

  if (!fs.existsSync(mdPath)) {
    console.error(`  File not found: ${mdPath}`);
    process.exit(1);
  }

  console.log(`\n  Reading: ${mdPath}\n`);

  const text   = fs.readFileSync(mdPath, 'utf8');
  const parsed = parseMd(text);

  if (!parsed.character.name) {
    console.error('  Could not find a Character section with a Name field.');
    console.error('  Make sure your file has a "## Character" section with "- **Name:** ..." line.');
    process.exit(1);
  }

  const state    = buildState(parsed);
  const filename = writeSave(state, mdPath);
  printSummary(state, filename);
}

main().catch(err => {
  console.error('  Error:', err.message);
  process.exit(1);
});
