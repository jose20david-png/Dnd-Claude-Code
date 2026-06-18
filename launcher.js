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

const MODEL                = 'gemini-3.1-flash-lite';
const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;
const PORTS                = [3140, 3141, 8080];

// ─── REQUEST THROTTLING & TOKEN RATE LIMITER ──────────────────────────────
let lastRequestTime = 0;
const REQUEST_DELAY_MS = 3000; // 3s between requests — paces calls within Gemini's 20 RPM free tier

const TOKEN_LIMIT_PER_MIN = 240000;     // Gemini free tier: 250,000 TPM (leave headroom)
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
  const m = env.match(/GEMINI_API_KEY=(.+)/);
  if (m) API_KEY = m[1].trim();
} catch {}

// ─── DAILY REQUEST COUNTER (Gemini free tier: ~100 RPD) ───────────────────────
let dailyRequestCount = 0;
const MAX_DAILY_REQUESTS = 900; // Gemini 3.1 Flash-Lite free tier is far higher than 3.5's 20 RPD.
                                // This is only a soft warning threshold — Google's 429 is the real cap.
                                // Adjust if you see 429s well before hitting this number.
function trackDailyRequest(res) {
  dailyRequestCount++;
  if (dailyRequestCount === MAX_DAILY_REQUESTS - 2) {
    console.warn(`  ⚠️  Daily request budget: ${dailyRequestCount}/${MAX_DAILY_REQUESTS} used — approaching limit`);
    res && res.write(`data: ${JSON.stringify({ type: 'text', content: '\n\n*— Heads up: approaching daily AI request limit. Save your progress soon. —*\n\n' })}\n\n`);
  }
  if (dailyRequestCount >= MAX_DAILY_REQUESTS) {
    console.warn(`  ❌  Daily request budget exhausted (${dailyRequestCount}/${MAX_DAILY_REQUESTS})`);
  }
}

// ─── 5E GAME DATA (classes, races from 5ETOOLS MCP) ──────────────────────────
// APP_DIR is defined later but we need DATA_DIR at load time — compute it the same way
const DATA_DIR = path.join(
  (typeof process !== 'undefined' && process.pkg) ? path.dirname(process.execPath) : path.resolve(__dirname),
  '5ETOOLS MCP', 'data'
);

function loadGameData() {
  const data = { classes: {}, races: {} };

  // Load all 12 PHB classes
  const classNames = ['barbarian','bard','cleric','druid','fighter','monk','paladin','ranger','rogue','sorcerer','warlock','wizard'];
  for (const c of classNames) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'classes', c+'.json'), 'utf8'));
      data.classes[c] = {
        name: d.name,
        hit_dice: d.hit_dice,
        spellcasting: d.spellcasting_ability || null,
        subtypes_name: d.subtypes_name || 'Subclasses',
        prof_skills: d.prof_skills || '',
        equipment: d.equipment || '',
        desc_short: (d.desc || '').replace(/#+\s*/g,'').replace(/\n+/g,' ').trim().slice(0, 200),
        archetypes: (d.archetypes || [])
          .filter(a => !a.document__slug || a.document__slug === 'wotc-srd')
          .map(a => ({
            name: a.name,
            desc_short: ((s) => s.split(/\.\s+/)[0] + '.')(((a.desc || '').replace(/#+\s*/g,'').replace(/\n+/g,' ').trim()))
          }))
      };
    } catch (e) { /* file missing — skip */ }
  }

  // Load core PHB races
  const coreRaces = ['human','elf','dwarf','halfling','half_elf','half_orc','gnome','tiefling','dragonborn'];
  for (const r of coreRaces) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'races', r+'.json'), 'utf8'));
      data.races[r] = {
        name: d.name || r,
        desc_short: (d.desc || '').replace(/#+\s*/g,'').replace(/\n+/g,' ').trim().slice(0, 180)
      };
    } catch (e) { /* file missing — skip */ }
  }

  return data;
}

const GAME_DATA = loadGameData();

// Pre-built class list string for the character creation prompt
function buildClassListStr() {
  const classFlavorMap = {
    barbarian: 'Rage-fueled warrior. Hits the hardest, tanks the most.',
    bard:      'Performer-mage. Spells, skills, and silver tongue.',
    cleric:    'Divine conduit. Healer or warrior depending on your god.',
    druid:     'Nature\'s voice. Shapeshifts, storms, and wild magic.',
    fighter:   'Martial master. Every weapon, any battlefield.',
    monk:      'Living weapon. Speed and precision, no armor needed.',
    paladin:   'Sacred oath warrior. Heavy armor, divine spells, aura of protection.',
    ranger:    'Wilderness hunter. Tracking, archery, beast companion.',
    rogue:     'Shadow striker. Sneak attacks, skills, and quick escapes.',
    sorcerer:  'Born with magic in the blood. Raw power, limited spells.',
    warlock:   'Pact-bound spellcaster. Few strong spells, recover on short rest.',
    wizard:    'Studied mage. Largest spell list, most versatile magic.'
  };

  return Object.entries(GAME_DATA.classes).map(([key, c], i) => {
    const spell = c.spellcasting ? ` [${c.spellcasting} spellcaster]` : '';
    return `${i+1}. **${c.name}** (${c.hit_dice}${spell}) — ${classFlavorMap[key] || c.desc_short}`;
  }).join('\n');
}

function buildRaceListStr() {
  const raceFlavorMap = {
    human:      '+1 all stats (or Variant: +1 two stats, bonus skill, feat).',
    elf:        '+2 DEX, darkvision, Fey Ancestry, Trance.',
    dwarf:      '+2 CON, darkvision, poison resistance, stonecunning.',
    halfling:   '+2 DEX, Halfling Luck (reroll nat 1s), Brave.',
    half_elf:   '+2 CHA, +1 to two stats, darkvision, two free skills.',
    half_orc:   '+2 STR, +1 CON, darkvision, Relentless Endurance, Savage Attacks.',
    gnome:      '+2 INT, darkvision, advantage on INT/WIS/CHA magic saves.',
    tiefling:   '+2 CHA, +1 INT, darkvision, fire resistance, innate spells.',
    dragonborn: '+2 STR, +1 CHA, breath weapon, damage resistance.'
  };

  return Object.entries(GAME_DATA.races).map(([key, r], i) => {
    return `${i+1}. **${r.name}** — ${raceFlavorMap[key] || r.desc_short}`;
  }).join('\n');
}

// ─── RAG: 5E KNOWLEDGE BASE ───────────────────────────────────────────────────
// Builds a name→filename index at startup (filenames only — no file reads).
// On each player message, scans for entity mentions and injects compact stat
// blocks into the system prompt so Mistral has accurate D&D data to work with.

const RAG_INDEX = { spells: {}, monsters: {}, items: {} };

function buildRagIndex() {
  const cats = [
    { key: 'spells',   dir: path.join(DATA_DIR, 'spells') },
    { key: 'monsters', dir: path.join(DATA_DIR, 'monsters') },
    { key: 'items',    dir: path.join(DATA_DIR, 'items') },
  ];
  for (const { key, dir } of cats) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        // Convert filename to searchable name: "magic_missile.json" → "magic missile"
        const name = f.replace(/\.json$/, '').replace(/_/g, ' ').toLowerCase();
        RAG_INDEX[key][name] = path.join(dir, f);
      }
    } catch {}
  }
  const total = Object.values(RAG_INDEX).reduce((s, v) => s + Object.keys(v).length, 0);
  console.log(`  ✓ RAG index built — ${total} entries (spells:${Object.keys(RAG_INDEX.spells).length} monsters:${Object.keys(RAG_INDEX.monsters).length} items:${Object.keys(RAG_INDEX.items).length})`);
}

// In-memory cache so we don't re-read the same file every message
const _ragCache = {};
function ragLoadFile(filepath) {
  if (_ragCache[filepath]) return _ragCache[filepath];
  try {
    const d = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    _ragCache[filepath] = d;
    return d;
  } catch { return null; }
}

// Format a spell entry into a compact DM reference block
function formatSpell(d) {
  if (!d) return null;
  const conc = d.requires_concentration ? ' [Concentration]' : '';
  const ritual = d.ritual === 'yes' ? ' [Ritual]' : '';
  const desc = (d.desc || '').replace(/\n+/g, ' ').trim().slice(0, 300);
  const higher = d.higher_level ? ` | Upcast: ${d.higher_level.trim().slice(0, 100)}` : '';
  return `SPELL: ${d.name} | Lv${d.level_int ?? d.spell_level ?? '?'} ${d.school || ''} | Cast: ${d.casting_time || '?'} | Range: ${d.range || '?'} | Duration: ${d.duration || '?'}${conc}${ritual} | Components: ${d.components || '?'}\n${desc}${higher}`;
}

// Format a monster entry into a compact DM reference block
function formatMonster(d) {
  if (!d) return null;
  const scores = d.ability_scores || {};
  const statsStr = ['str','dex','con','int','wis','cha'].map(s => `${s.toUpperCase()}:${scores[s]||'?'}`).join(' ');
  const actions = (d.actions || []).slice(0, 3).map(a => `  • ${a.name}: ${(a.desc||'').slice(0,100)}`).join('\n');
  const traits  = (d.traits  || []).slice(0, 2).map(t => `  • ${t.name}: ${(t.desc||'').slice(0,80)}`).join('\n');
  return `MONSTER: ${d.name} | CR ${d.challenge_rating} | HP ${d.hit_points} | AC ${d.armor_class} | Speed ${d.speed?.walk ?? '?'}ft | XP ${d.experience_points || '?'}\n${statsStr}\n${traits ? 'Traits:\n'+traits+'\n' : ''}Actions:\n${actions}`;
}

// Format an item entry
function formatItem(d) {
  if (!d) return null;
  const rarity = d.rarity || '';
  const type   = d.type || '';
  const desc   = (d.desc || '').replace(/\n+/g, ' ').trim().slice(0, 250);
  return `ITEM: ${d.name} | ${type}${rarity ? ' | '+rarity : ''}\n${desc}`;
}

// ── Keyword association map ───────────────────────────────────────────────────
// Maps natural language descriptions / partial terms to canonical entity names.
// Handles plurals, adjectives, descriptive phrases, and common DM shorthand.
const RAG_ALIASES = {
  // ── Fire / flame spells
  'fire spell': ['fireball','fire bolt','burning hands','scorching ray'],
  'firespell':  ['fireball','fire bolt'],
  'flame spell':['fireball','burning hands','fire bolt'],
  'fire magic': ['fireball','fire bolt','burning hands','scorching ray'],
  'fire attack':['fire bolt','scorching ray'],
  'fireball':   ['fireball'],
  'fire bolt':  ['fire bolt'],
  'burning hands':['burning hands'],
  // ── Ice / frost / cold
  'ice spell':  ['ray of frost','ice storm','cone of cold'],
  'frost spell':['ray of frost','ice storm'],
  'cold spell': ['ray of frost','cone of cold'],
  'ice magic':  ['ray of frost','ice storm','cone of cold'],
  // ── Lightning / thunder
  'lightning spell': ['lightning bolt','call lightning'],
  'thunder spell':   ['thunderwave','shatter'],
  'shock spell':     ['shocking grasp','lightning bolt'],
  // ── Healing
  'heal':         ['cure wounds','healing word'],
  'healing spell':['cure wounds','healing word','mass cure wounds'],
  'cure':         ['cure wounds'],
  // ── Sleep / charm / mind
  'sleep spell':  ['sleep'],
  'charm spell':  ['charm person','hold person'],
  'mind spell':   ['charm person','hold person','crown of madness'],
  // ── Summon / conjure
  'summon spell': ['conjure animals','find familiar','unseen servant'],
  'conjure':      ['conjure animals','conjure elemental'],
  // ── Shield / protection
  'shield spell': ['shield','mage armor','protection from evil and good'],
  'protect':      ['shield','mage armor'],
  // ── Darkness / shadow
  'darkness spell':['darkness','fog cloud'],
  'shadow spell':  ['darkness','shadow blade'],
  // ── Monsters — plurals + adjectives
  'goblins':    ['goblin'],
  'goblin group':['goblin'],
  'tough goblin':['goblin'],
  'orcs':       ['orc'],
  'trolls':     ['troll'],
  'skeletons':  ['skeleton'],
  'zombies':    ['zombie'],
  'bandits':    ['bandit'],
  'wolves':     ['wolf'],
  'spiders':    ['giant spider'],
  'rats':       ['giant rat'],
  'dragons':    ['dragon'],
  'ogres':      ['ogre'],
  'gnolls':     ['gnoll'],
  'kobolds':    ['kobold'],
  'hobgoblins': ['hobgoblin'],
  'bugbears':   ['bugbear'],
  'vampires':   ['vampire'],
  'ghosts':     ['ghost'],
  'wraiths':    ['wraith'],
  // ── Creature types / concepts
  'undead':     ['skeleton','zombie','ghoul','wight'],
  'demon':      ['quasit','imp','balor'],
  'devil':      ['imp','chain devil','pit fiend'],
  'elemental':  ['air elemental','earth elemental','fire elemental','water elemental'],
  'construct':  ['animated armor','shield guardian'],
  'beast':      ['wolf','giant spider','brown bear'],
  // ── Items — common descriptions
  'magic sword':  ['sword of life stealing','flame tongue'],
  'healing potion':['potion of healing'],
  'health potion': ['potion of healing'],
  'potion':        ['potion of healing'],
  'magic armor':   ['adamantine armor','mithral armor'],
};

// Expand text using alias map — returns extra search terms
function expandAliases(text) {
  const lower = text.toLowerCase();
  const extras = new Set();
  for (const [alias, targets] of Object.entries(RAG_ALIASES)) {
    if (lower.includes(alias)) {
      for (const t of targets) extras.add(t);
    }
  }
  return [...extras];
}

// Extract entity mentions from a text string, search index, return formatted blocks
// maxEntries caps total injected entries to avoid context bloat
function ragSearch(text, maxEntries = 5) {
  // Combine original text + alias expansions into one search corpus
  const aliasExpansions = expandAliases(text);
  const searchCorpus = (text + ' ' + aliasExpansions.join(' ')).toLowerCase();
  const results = [];
  const seen = new Set();

  // Search each category — longest match first to avoid "fire" before "fireball"
  for (const [cat, index] of Object.entries(RAG_INDEX)) {
    const names = Object.keys(index).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (results.length >= maxEntries) break;
      if (seen.has(name)) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(searchCorpus)) {
        seen.add(name);
        const d = ragLoadFile(index[name]);
        let formatted = null;
        if (cat === 'spells')   formatted = formatSpell(d);
        if (cat === 'monsters') formatted = formatMonster(d);
        if (cat === 'items')    formatted = formatItem(d);
        if (formatted) results.push(formatted);
      }
    }
    if (results.length >= maxEntries) break;
  }

  return results;
}

// Build compact spell list for the character's known/prepared spells
function buildCharSpellContext(state) {
  const party = state && state.party && state.party[0];
  if (!party || !party.spells) return '';
  const spells = party.spells;
  const allNames = [
    ...(spells.cantrips || []),
    ...(spells.level_1  || []),
    ...(spells.level_2  || []),
    ...(spells.level_3  || []),
  ];
  if (allNames.length === 0) return '';

  const blocks = [];
  for (const name of allNames) {
    const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
    const filepath = RAG_INDEX.spells[key];
    if (filepath) {
      const d = ragLoadFile(filepath);
      const f = formatSpell(d);
      if (f) blocks.push(f);
    }
  }
  if (blocks.length === 0) return '';
  return `\n\nCHARACTER SPELL REFERENCE (known/prepared spells — full stats):\n${blocks.join('\n\n')}`;
}

// Build the full RAG injection string to append to the system prompt
function buildRagContext(playerMessage, dmContext, state) {
  const searchText = playerMessage + ' ' + (dmContext || '');
  const hits = ragSearch(searchText, 5);

  // Always include the character's own spells (so DM always has accurate spell data)
  const spellCtx = buildCharSpellContext(state);

  // Deduplicate: remove any hits already covered in the character's spell list
  const spellLines = new Set(spellCtx.split('\n').filter(l => l.startsWith('SPELL:')));
  const filteredHits = hits.filter(h => !spellLines.has(h.split('\n')[0]));

  const ragSection = filteredHits.length > 0
    ? `\n\n📖 REFERENCE DATA (use this — do not guess or invent stats):\n${filteredHits.join('\n\n')}`
    : '';

  return spellCtx + ragSection;
}

function getClassEquipment(cls) {
  const eq = {
    barbarian: '- Greataxe\n- Two handaxes\n- Explorer\'s pack\n- Four javelins',
    bard:      '- Rapier\n- Diplomat\'s pack\n- Lute\n- Leather armor\n- Dagger',
    cleric:    '- Mace\n- Scale mail\n- Light crossbow + 20 bolts\n- Shield\n- Holy symbol\n- Priest\'s pack',
    druid:     '- Wooden shield\n- Scimitar\n- Leather armor\n- Explorer\'s pack\n- Druidic focus (wooden staff)\n- Herbalism kit',
    fighter:   '- Chain mail\n- Longsword and shield\n- Two handaxes\n- Dungeoneer\'s pack\n- 10 javelins',
    monk:      '- Shortsword\n- Dungeoneer\'s pack\n- 10 darts',
    paladin:   '- Chain mail\n- Holy symbol\n- Longsword and shield\n- Five javelins\n- Priest\'s pack',
    ranger:    '- Scale mail\n- Longbow + 20 arrows\n- Two shortswords\n- Dungeoneer\'s pack\n- Favored enemy lore notes',
    rogue:     '- Rapier\n- Shortbow + 20 arrows\n- Burglar\'s pack\n- Leather armor\n- Two daggers\n- Thieves\' tools',
    sorcerer:  '- Light crossbow + 20 bolts\n- Two daggers\n- Dungeoneer\'s pack\n- Arcane focus (crystal)',
    warlock:   '- Light crossbow + 20 bolts\n- Two daggers\n- Scholar\'s pack\n- Leather armor\n- Arcane focus',
    wizard:    '- Quarterstaff\n- Spellbook (6 chosen spells + Mage Armor + Magic Missile)\n- Scholar\'s pack\n- Arcane focus\n- Component pouch',
  };
  const key = (cls||'').toLowerCase().split(/[\s(]/)[0];
  return eq[key] || '- Standard adventurer\'s gear';
}

function getBackgroundEquipment(bg) {
  const eq = {
    acolyte:    '- Holy symbol\n- Prayer book\n- 5 sticks of incense\n- Vestments\n- Common clothes\n- Belt pouch (15 gp)',
    sage:       '- Ink bottle\n- Ink pen\n- Small knife\n- Letter from a dead colleague\n- Common clothes\n- Belt pouch (10 gp)',
    criminal:   '- Crowbar\n- Dark common clothes with hood\n- Belt pouch (15 gp)',
    'folk hero':'- Artisan\'s tools (one type)\n- Shovel\n- Iron pot\n- Common clothes\n- Belt pouch (10 gp)',
    soldier:    '- Rank insignia\n- A trophy from a fallen enemy\n- Bone dice or deck of cards\n- Common clothes\n- Belt pouch (10 gp)',
    outlander:  '- Staff\n- Hunting trap\n- Trophy from an animal kill\n- Traveler\'s clothes\n- Belt pouch (10 gp)',
    noble:      '- Fine clothes\n- Signet ring\n- Scroll of pedigree\n- Purse (25 gp)',
    entertainer:'- Musical instrument\n- Favor from an admirer\n- Costume\n- Belt pouch (15 gp)',
    hermit:     '- Scroll case with notes\n- Winter blanket\n- Common clothes\n- Herbalism kit\n- Belt pouch (5 gp)',
    sailor:     '- Belaying pin (club)\n- Silk rope (50 ft)\n- Lucky charm\n- Common clothes\n- Belt pouch (10 gp)',
    urchin:     '- Small knife\n- City map\n- Pet mouse\n- Token from parents\n- Common clothes\n- Belt pouch (10 gp)',
    charlatan:  '- Fine clothes\n- Disguise kit\n- Con tools\n- Belt pouch (15 gp)',
  };
  const key = (bg||'').toLowerCase().replace(/\s+/g,' ').trim();
  return eq[key] || '- Standard background gear';
}

// ─── STARTING SPELL LISTS ─────────────────────────────────────────────────────
function buildSpellListMessage(cls) {
  const c = (cls||'').toLowerCase().split(/[\s(]/)[0];
  const LISTS = {
    bard: {
      note: 'Bards know their spells permanently (no preparation needed).',
      cantrips_count: 2,
      cantrips: ['Vicious Mockery','Minor Illusion','Prestidigitation','Mage Hand','Message','Light','Friends','Mending','True Strike','Dancing Lights'],
      l1_count: 4,
      l1: ['Charm Person','Cure Wounds','Detect Magic','Disguise Self','Dissonant Whispers','Faerie Fire','Healing Word','Heroism','Longstrider','Silent Image','Sleep','Thunderwave','Tasha\'s Hideous Laughter','Unseen Servant','Command','Animal Friendship','Comprehend Languages'],
    },
    wizard: {
      note: 'Wizards learn spells in their spellbook. You start with 6 level-1 spells plus Mage Armor and Magic Missile (already in your book).',
      cantrips_count: 3,
      cantrips: ['Fire Bolt','Ray of Frost','Shocking Grasp','Chill Touch','Mage Hand','Minor Illusion','Prestidigitation','Poison Spray','True Strike','Light','Acid Splash','Message','Dancing Lights','Blade Ward'],
      l1_count: 6,
      l1: ['Sleep','Burning Hands','Charm Person','Color Spray','Comprehend Languages','Detect Magic','Disguise Self','Expeditious Retreat','False Life','Feather Fall','Find Familiar','Fog Cloud','Grease','Identify','Jump','Longstrider','Shield','Silent Image','Thunderwave','Witch Bolt'],
    },
    sorcerer: {
      note: 'Sorcerers know their spells permanently. Your magic is instinctive — once you know a spell, it\'s yours.',
      cantrips_count: 4,
      cantrips: ['Fire Bolt','Chill Touch','Ray of Frost','Shocking Grasp','Mage Hand','Minor Illusion','Prestidigitation','True Strike','Light','Acid Splash','Poison Spray','Dancing Lights','Blade Ward'],
      l1_count: 2,
      l1: ['Burning Hands','Charm Person','Chromatic Orb','Color Spray','Detect Magic','Disguise Self','Expeditious Retreat','False Life','Feather Fall','Fog Cloud','Jump','Mage Armor','Magic Missile','Ray of Sickness','Shield','Silent Image','Sleep','Thunderwave','Witch Bolt'],
    },
    warlock: {
      note: 'Warlocks know their spells permanently. All your spell slots refresh on a short rest.',
      cantrips_count: 2,
      cantrips: ['Eldritch Blast','Chill Touch','Minor Illusion','Prestidigitation','Mage Hand','True Strike','Poison Spray','Blade Ward'],
      l1_count: 2,
      l1: ['Armor of Agathys','Arms of Hadar','Charm Person','Comprehend Languages','Expeditious Retreat','Hellish Rebuke','Hex','Illusory Script','Protection from Evil and Good','Unseen Servant','Witch Bolt'],
    },
    cleric: {
      note: 'Clerics prepare spells from the full cleric list each long rest. At level 1 you can prepare WIS modifier + 1 spells (minimum 1). Choose your starting prep:',
      cantrips_count: 3,
      cantrips: ['Guidance','Light','Mending','Resistance','Sacred Flame','Spare the Dying','Thaumaturgy','Toll the Dead','Word of Radiance'],
      l1_count: 0, // prepared, so no fixed count — list suggestions
      l1: ['Bane','Bless','Command','Cure Wounds','Detect Magic','Guiding Bolt','Healing Word','Inflict Wounds','Protection from Evil and Good','Sanctuary','Shield of Faith','Detect Evil and Good'],
    },
    druid: {
      note: 'Druids prepare spells each long rest. At level 1 you can prepare WIS modifier + 1 spells. Choose your cantrips, then suggested prep:',
      cantrips_count: 2,
      cantrips: ['Druidcraft','Guidance','Mending','Poison Spray','Produce Flame','Resistance','Shillelagh','Thorn Whip'],
      l1_count: 0,
      l1: ['Animal Friendship','Charm Person','Cure Wounds','Detect Magic','Detect Poison and Disease','Entangle','Faerie Fire','Fog Cloud','Goodberry','Healing Word','Jump','Longstrider','Speak with Animals','Thunderwave'],
    },
    paladin: {
      note: 'Paladins don\'t get spells until level 2. When you level up, you\'ll prepare spells from the paladin list.',
      cantrips_count: 0, cantrips: [], l1_count: 0, l1: [], no_spells_yet: true,
    },
    ranger: {
      note: 'Rangers don\'t get spells until level 2. When you reach it, you\'ll choose from the ranger spell list.',
      cantrips_count: 0, cantrips: [], l1_count: 0, l1: [], no_spells_yet: true,
    },
  };
  const data = LISTS[c];
  if (!data) return null;
  if (data.no_spells_yet) return `**${cls} — Spellcasting:** ${data.note}\n\nSkip ahead to equipment!`;
  let msg = `**Starting Spells for ${cls}**\n${data.note}\n\n`;
  if (data.cantrips_count > 0) {
    msg += `**Cantrips — choose ${data.cantrips_count}:**\n`;
    msg += data.cantrips.map((s,i)=>`${i+1}. ${s}`).join('\n') + '\n\n';
  }
  if (data.l1_count > 0) {
    msg += `**Level 1 Spells — choose ${data.l1_count}:**\n`;
    msg += data.l1.map((s,i)=>`${i+1}. ${s}`).join('\n') + '\n\n';
  } else if (data.l1.length > 0) {
    msg += `**Level 1 Spell options:**\n`;
    msg += data.l1.map((s,i)=>`${i+1}. ${s}`).join('\n') + '\n\n';
  }
  msg += 'Tell me which you want — e.g. "Cantrips: Vicious Mockery, Minor Illusion / Spells: Cure Wounds, Healing Word, Sleep, Faerie Fire"';
  return msg;
}

buildRagIndex(); // Run at startup

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
  console.log('  ██████╗  ██╗    ██╗ ██████╗     ███████╗███████╗');
  console.log('  ██╔══██╗ ███╗   ██║ ██╔══██╗    ██╔════╝██╔════╝');
  console.log('  ██║  ██║ ██╔██╗ ██║ ██║  ██║    ███████╗█████╗  ');
  console.log('  ██║  ██║ ██║╚██╗██║ ██║  ██║    ╚════██║██╔══╝  ');
  console.log('  ██████╔╝ ██║ ╚████║ ██████╔╝    ███████║███████╗');
  console.log('  ╚═════╝  ╚═╝  ╚═══╝ ╚═════╝     ╚══════╝╚══════╝');
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
  creation_step: 1,   // tracks which character creation step we're on (1-9)
  creation_data: {},  // accumulates choices: { setting, class, subclass, race, background, stats, spells, name }
  world: { name: 'Forgotten Realms', lore_summary: 'New campaign — character creation in progress.',
    current_location: 'Character Creation', time: 'Day 1 — Morning', seal_integrity: 100, seal_status: 'N/A', map_id: null, story_notes: '' },
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

// Compute spell slot maximums from class + level. Returns {level_1:{max,used:0}, ...}.
// Used by create_character, award_xp (on level-up), and restore_resources (to fix stale maxes).
function computeSpellSlots(cls, level) {
  const lvl = Math.min(level || 1, 20);
  const FULL_CASTER = /wizard|sorcerer|bard|druid|cleric/i;
  const HALF_CASTER = /paladin|ranger/i;
  const WARLOCK = /warlock/i;
  let rawTable = {};

  if (WARLOCK.test(cls)) {
    const wSlots = [[],[2],[2],[2],[2],[3],[3],[3],[3],[3],[4]];
    const wLevel = lvl<=4?1:lvl<=6?2:lvl<=8?3:lvl<=9?4:5;
    rawTable = { [`level_${wLevel}`]: wSlots[Math.min(lvl,10)] || 2 };
  } else if (FULL_CASTER.test(cls)) {
    const t = [
      {},
      {1:2},{1:3},{1:4,2:2},{1:4,2:3},{1:4,2:3,3:2},{1:4,2:3,3:3},
      {1:4,2:3,3:3,4:1},{1:4,2:3,3:3,4:2},{1:4,2:3,3:3,4:3,5:1},{1:4,2:3,3:3,4:3,5:2}
    ];
    const row = t[Math.min(lvl,10)] || {};
    for (const [k,v] of Object.entries(row)) rawTable[`level_${k}`] = v;
  } else if (HALF_CASTER.test(cls)) {
    const t = [
      {},{},{1:2},{1:3},{1:3},{1:4,2:2},{1:4,2:2},{1:4,2:3},{1:4,2:3},{1:4,2:3,3:2},{1:4,2:3,3:2}
    ];
    const row = t[Math.min(lvl,10)] || {};
    for (const [k,v] of Object.entries(row)) rawTable[`level_${k}`] = v;
  }

  const slots = {
    cantrip:{max:0,used:0}, level_1:{max:0,used:0}, level_2:{max:0,used:0},
    level_3:{max:0,used:0}, level_4:{max:0,used:0}, level_5:{max:0,used:0}
  };
  for (const [k, maxVal] of Object.entries(rawTable)) {
    slots[k] = { max: maxVal, used: 0 };
  }
  return slots;
}

// ─── TOOLS ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {name:'roll_dice',description:'Roll dice. ALWAYS call for every roll. Advantage=2d20kh1+X (keep highest). Disadvantage=2d20kl1+X (keep lowest). NEVER use kh1 for disadvantage.',
   input_schema:{type:'object',properties:{expression:{type:'string',description:'e.g. "1d20+5", "2d6+3", "2d20kh1+4" (advantage), "2d20kl1+4" (disadvantage)'},purpose:{type:'string'}},required:['expression','purpose']}},
  {name:'update_hp',description:"Update the character's current HP after damage or healing. Pass hp_max to raise the maximum (e.g. after leveling up and rolling a hit die).",
   input_schema:{type:'object',properties:{hp:{type:'number',description:'New current HP'},hp_max:{type:'number',description:'New HP maximum — only set when raising the cap (level-up hit die roll)'},reason:{type:'string'}},required:['hp','reason']}},
  {name:'use_spell_slot',description:'Spend a spell slot when a leveled spell is cast.',
   input_schema:{type:'object',properties:{level:{type:'number'},spell_name:{type:'string'}},required:['level','spell_name']}},
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
  {name:'death_save',description:'Record a death save at 0 HP. 3 successes = stable, 3 failures = death.',
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
  {name:'lay_on_hands',description:"Use Paladin's Lay on Hands. This is NOT a spell slot — it draws from a separate HP pool (5 × paladin level). Use this instead of use_spell_slot for Lay on Hands.",
   input_schema:{type:'object',properties:{
     amount:{type:'number',description:'HP to restore (cannot exceed pool remaining)'},
     target:{type:'string',description:'Who is being healed (default: the character themselves)'}
   },required:['amount']}},
  {name:'update_ac',description:'Update the character AC when armor, shield, or fighting style changes. Call this whenever AC changes — do not rely on story_notes for AC.',
   input_schema:{type:'object',properties:{
     ac:{type:'number',description:'New total AC value'},
     notes:{type:'string',description:'Formula breakdown, e.g. "Chain Mail 16 + Defense +1 + Shield +2 = 19"'}
   },required:['ac']}},
  {name:'award_xp',description:'Award XP. Auto-levels if threshold reached. Call after combat, quest completions, milestones.',
   input_schema:{type:'object',properties:{
     amount:{type:'number',description:'XP to award'},
     reason:{type:'string',description:'Why the XP was earned'}
   },required:['amount','reason']}},
  {name:'update_spells',description:'Add or remove a spell from the character\'s known/prepared spell list. Call once per spell after level-up or whenever a spell is learned or swapped.',
   input_schema:{type:'object',properties:{
     action:{type:'string',enum:['add','remove'],description:'add to or remove from the list'},
     spell_name:{type:'string',description:'Spell name exactly as it appears in the rules, e.g. "Bless", "Shield of Faith"'},
     level:{type:'string',enum:['cantrip','level_1','level_2','level_3','level_4','level_5','level_6','level_7','level_8','level_9'],description:'Slot level of the spell, or "cantrip"'}
   },required:['action','spell_name','level']}},
  {name:'add_trait',description:'Add a class feature, racial trait, or other permanent ability to the character sheet. Call after level-up for each new feature gained.',
   input_schema:{type:'object',properties:{
     trait:{type:'string',description:'Full name and brief description of the feature, e.g. "Divine Health — immune to disease (Paladin 3)"'}
   },required:['trait']}},
  {name:'update_story_notes',description:'Persist important story facts (NPC secrets, player decisions, plot points) that must survive session resets.',
   input_schema:{type:'object',properties:{
     notes:{type:'string',description:'Narrative summary to persist. Append to existing notes — include who, what, where, and why. Max ~400 chars per call.'}
   },required:['notes']}},
  {name:'advance_creation_step',description:'Call this after each character creation step is complete to move to the next step. Save any data the player just chose.',
   input_schema:{type:'object',properties:{
     step_completed:{type:'number',description:'The step number just completed (1-10)'},
     data:{type:'object',description:'Data collected in this step. Keys: setting, class, subclass, race, background, skills (array of strings), variant_human (bool), variant_stat1 (str key), variant_stat2 (str key), variant_bonus_skill (string), variant_feat (string), stats (object with str/dex/con/int/wis/cha), spells (object with cantrips/level_1 arrays), name, description'}
   },required:['step_completed']}},
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

// Strip property-level descriptions from a JSON schema to reduce token overhead.
// Tool-level descriptions are kept; only parameter property descriptions are removed.
function minifySchema(s) {
  if (!s || typeof s !== 'object') return s;
  const { description: _d, ...rest } = s;
  const r = { ...rest };
  if (r.properties) r.properties = Object.fromEntries(Object.entries(r.properties).map(([k,v]) => [k, minifySchema(v)]));
  if (r.items) r.items = minifySchema(r.items);
  return r;
}

// Groq uses OpenAI function-calling format: wrap each tool in {type:'function', function:{...}}
// and rename input_schema → parameters.
// Two tool sets: creation (advance_creation_step only) and gameplay (all others).
const CREATION_TOOL_NAMES = new Set(['advance_creation_step', 'create_character']);
// create_character is handled server-side at step 11 — model never calls it.
const CREATION_TOOLS = TOOLS
  .filter(t => t.name === 'advance_creation_step')
  .map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: minifySchema(t.input_schema) } }));
const GAMEPLAY_TOOLS = TOOLS
  .filter(t => !CREATION_TOOL_NAMES.has(t.name))
  .map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: minifySchema(t.input_schema) } }));

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────
function executeTool(name, input) {
  const state = loadState();
  switch (name) {
    case 'roll_dice': { if (!input.expression) return {error:'Missing expression — e.g. "1d20"'}; const r=rollDice(input.expression); return {rolled:input.expression,purpose:input.purpose,result:r.breakdown,total:r.total,dice_rolled:true}; }
    case 'update_hp': { const ch=state.party[0]; if(input.hp_max!=null) ch.hp_max=Math.round(input.hp_max); const hpMax=ch.hp_max||ch.hp||27; const hp=Math.max(0,Math.min(hpMax,Math.round(input.hp))); ch.hp=hp; state.history_log.push({timestamp:new Date().toISOString(),event:input.reason}); saveState(state); return {success:true,hp,hp_max:hpMax,state_updated:true}; }
    case 'use_spell_slot': { const slots=state.party[0].spell_slots; const key=`level_${input.level}`; if(!slots[key]||slots[key].used>=slots[key].max) return {error:`No level ${input.level} slots remaining`}; slots[key].used++; state.history_log.push({timestamp:new Date().toISOString(),event:`Cast ${input.spell_name} (Lv${input.level}). ${slots[key].max-slots[key].used}/${slots[key].max} remaining.`}); saveState(state); return {success:true,remaining:slots[key].max-slots[key].used,state_updated:true}; }
    case 'restore_resources': {
      const r=state.party[0];
      const isWarlock=/warlock/i.test(r.class||'');
      if(input.rest_type==='long_rest'){
        // Long rest: full restore — recompute slot MAXES from class+level so stale zeroes are fixed
        const freshSlots = computeSpellSlots(r.class||'', r.level||1);
        const existingSlots = r.spell_slots || {};
        for (const k of Object.keys(freshSlots)) {
          if (freshSlots[k].max > 0) {
            existingSlots[k] = { max: freshSlots[k].max, used: 0 };
          } else if (existingSlots[k]) {
            existingSlots[k].used = 0; // reset used even if max stays
          }
        }
        r.spell_slots = existingSlots;
        if(r.channel_divinity) r.channel_divinity.used=0;
        // Restore hit dice (regain up to half max on long rest, min 1)
        if(r.hit_dice_total!=null){
          const regain=Math.max(1,Math.floor(r.hit_dice_total/2));
          r.hit_dice_used=Math.max(0,(r.hit_dice_used||0)-regain);
        }
        r.hp=r.hp_max||r.hp;
        r.lay_on_hands_used=0; // restore full Lay on Hands pool
        if(r.conditions) r.conditions=r.conditions.filter(c=>!/prone|frightened|invisible/i.test(c)); // clear short-duration conditions
        const slotsStr = Object.entries(r.spell_slots).filter(([,v])=>v.max>0).map(([k,v])=>`L${k.replace('level_','')}:${v.max}`).join(' ');
        state.history_log.push({timestamp:new Date().toISOString(),event:`Long rest — all resources restored, HP full. Slots: ${slotsStr||'none'}.`});
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
      if (!input.name) return { error: 'Missing required field: name' };
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
      let npc=state.npcs.find(n=>n.name.toLowerCase().includes(needle)||(n.id||'').includes(needle));
      if(!npc){
        // Auto-create (upsert) so update_npc never fails with "not found"
        const npcId=(input.name||'npc').toLowerCase().replace(/[^a-z0-9]+/g,'-');
        npc={id:npcId,name:input.name,role:input.role||'Unknown',disposition:input.disposition||'neutral',notes:input.notes||'',location:input.location||state.world.current_location};
        state.npcs.push(npc);
        state.history_log.push({timestamp:new Date().toISOString(),event:`Auto-created NPC: ${input.name} (via update_npc).`});
        saveState(state); return {success:true,created:true,state_updated:true};
      }
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
        if(p.hit_dice_total!=null) p.hit_dice_total=nextLvl;
        // Update spell slot MAXES for the new level, preserving used counts
        const newSlots = computeSpellSlots(p.class||'', nextLvl);
        for (const [k, v] of Object.entries(newSlots)) {
          if (v.max > 0) {
            const prev = (p.spell_slots||{})[k] || {used:0};
            p.spell_slots = p.spell_slots || {};
            p.spell_slots[k] = { max: v.max, used: Math.min(prev.used||0, v.max) };
          }
        }
        // Update CD max (paladins/clerics get more uses at higher levels)
        if(/paladin/i.test(p.class||'') && nextLvl>=6 && p.channel_divinity) p.channel_divinity.max=2;
        state.history_log.push({timestamp:new Date().toISOString(),event:`LEVEL UP! Now Level ${nextLvl}. Proficiency bonus +${profBonus(nextLvl)}. Spell slots updated.`});
        leveled=true;
      }
      const hitDie=(GAME_DATA.classes[(p.class||'').toLowerCase()]||{}).hit_dice||'d8';
      const levelUpInstructions = leveled
        ? `🎉 LEVEL UP! ${p.name||'The character'} is now Level ${p.level}! YOU MUST do ALL of the following: (1) Announce this loudly and dramatically in your narration — this is a big moment. (2) Tell the player their proficiency bonus is now +${profBonus(p.level)}. (3) Ask the player to roll a ${hitDie} and add their CON modifier — when they give you the number, add it to their current hp_max (${p.hp_max||p.hp}) and call update_hp with both the new current hp AND the new hp_max. (4) Tell the player every class feature/ability they gain at Level ${p.level}. (5) For each new feature, call add_trait with its name and a brief description. (6) If they can learn new spells, list their options and ask them to choose — then call update_spells once per chosen spell. Do not continue the story until all of these are resolved.`
        : undefined;
      saveState(state); return {success:true,xp:p.xp,level:p.level,leveled,level_up_instructions:levelUpInstructions,state_updated:true};
    }
    case 'update_spells': {
      const p=state.party[0];
      if(!p.spells) p.spells={};
      const key=input.level==='cantrip'?'cantrips':input.level;
      if(!p.spells[key]) p.spells[key]=[];
      if(input.action==='add'){
        if(!p.spells[key].some(s=>s.toLowerCase()===input.spell_name.toLowerCase()))
          p.spells[key].push(input.spell_name);
        state.history_log.push({timestamp:new Date().toISOString(),event:`Learned spell: ${input.spell_name} (${input.level})`});
      } else {
        p.spells[key]=p.spells[key].filter(s=>s.toLowerCase()!==input.spell_name.toLowerCase());
        state.history_log.push({timestamp:new Date().toISOString(),event:`Removed spell: ${input.spell_name} (${input.level})`});
      }
      saveState(state); return {success:true,spells:p.spells,state_updated:true};
    }
    case 'add_trait': {
      const p=state.party[0];
      if(!p.traits) p.traits=[];
      if(!p.traits.some(t=>t.toLowerCase()===input.trait.toLowerCase()))
        p.traits.push(input.trait);
      state.history_log.push({timestamp:new Date().toISOString(),event:`Trait added: ${input.trait.slice(0,60)}`});
      saveState(state); return {success:true,traits:p.traits,state_updated:true};
    }
    case 'lay_on_hands': {
      const p=state.party[0];
      const poolMax=(p.level||1)*5;
      const used=p.lay_on_hands_used||0;
      const available=poolMax-used;
      const amt=Math.min(input.amount||0, available);
      if(amt<=0) return {error:`Lay on Hands pool empty (0/${poolMax} HP remaining)`};
      p.lay_on_hands_used=(used+amt);
      p.hp=Math.min(p.hp_max||p.hp, p.hp+amt);
      state.history_log.push({timestamp:new Date().toISOString(),event:`Lay on Hands: restored ${amt} HP to ${input.target||'character'}. Pool: ${poolMax-(p.lay_on_hands_used)}/${poolMax} remaining.`});
      saveState(state); return {success:true,healed:amt,hp:p.hp,pool_remaining:poolMax-p.lay_on_hands_used,state_updated:true};
    }
    case 'update_ac': {
      state.party[0].ac=input.ac;
      if(input.notes) state.party[0].ac_notes=input.notes;
      state.history_log.push({timestamp:new Date().toISOString(),event:`AC updated to ${input.ac}${input.notes?' ('+input.notes+')':''}.`});
      saveState(state); return {success:true,ac:input.ac,state_updated:true};
    }
    case 'append_history_log': { state.history_log.push({timestamp:new Date().toISOString(),event:input.event}); saveState(state); return {success:true}; }
    case 'update_story_notes': {
      if (!state.world) state.world = {};
      const existing = state.world.story_notes || '';
      // Dedup: skip if a very similar note already exists (first 60 chars match anything in existing)
      const fingerprint = input.notes.trim().slice(0, 60).toLowerCase();
      const alreadySaved = existing.toLowerCase().includes(fingerprint);
      if (alreadySaved) return {success:true, skipped:'duplicate', story_notes:existing};
      const separator = existing ? '\n• ' : '• ';
      state.world.story_notes = (existing + separator + input.notes).slice(-3000);
      state.history_log.push({timestamp:new Date().toISOString(),event:`Story note saved: ${input.notes.slice(0,80)}`});
      saveState(state);
      return {success:true, story_notes:state.world.story_notes, state_updated:true};
    }
    case 'start_combat': {
      const enemies = input.enemies || [];
      state.history_log.push({timestamp:new Date().toISOString(),event:`Combat started with ${enemies.map(e=>e.name).join(', ')}`});
      saveState(state);
      return {success:true,combat_started:true,enemies:enemies};
    }
    case 'end_session': {
      const messages = [];
      // 1. Write journal entry + save session recap for next-session injection
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
          // Save recap to state so it's injected as "PREVIOUSLY IN YOUR ADVENTURE" next session
          st.world.session_recap = input.recap.trim().slice(0, 2500);
          saveState(st);
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
    case 'advance_creation_step': {
      // Skill pools: player picks `count` from `pool` (SRD class proficiency options)
      const CLASS_SKILL_POOLS = {
        barbarian:{ count:2, pool:['Animal Handling','Athletics','Intimidation','Nature','Perception','Survival'] },
        bard:     { count:3, pool:['Acrobatics','Animal Handling','Arcana','Athletics','Deception','History','Insight','Intimidation','Investigation','Medicine','Nature','Perception','Performance','Persuasion','Religion','Sleight of Hand','Stealth','Survival'] },
        cleric:   { count:2, pool:['History','Insight','Medicine','Persuasion','Religion'] },
        druid:    { count:2, pool:['Arcana','Animal Handling','Insight','Medicine','Nature','Perception','Religion','Survival'] },
        fighter:  { count:2, pool:['Acrobatics','Animal Handling','Athletics','History','Insight','Intimidation','Perception','Survival'] },
        monk:     { count:2, pool:['Acrobatics','Athletics','History','Insight','Religion','Stealth'] },
        paladin:  { count:2, pool:['Athletics','Insight','Intimidation','Medicine','Persuasion','Religion'] },
        ranger:   { count:3, pool:['Animal Handling','Athletics','Insight','Investigation','Nature','Perception','Stealth','Survival'] },
        rogue:    { count:4, pool:['Acrobatics','Athletics','Deception','Insight','Intimidation','Investigation','Perception','Performance','Persuasion','Sleight of Hand','Stealth'] },
        sorcerer: { count:2, pool:['Arcana','Deception','Insight','Intimidation','Persuasion','Religion'] },
        warlock:  { count:2, pool:['Arcana','Deception','History','Intimidation','Investigation','Nature','Religion'] },
        wizard:   { count:2, pool:['Arcana','History','Insight','Investigation','Medicine','Religion'] },
      };
      // Always-prepared spells auto-added at level 1 by subclass/domain/patron
      const ALWAYS_PREPARED = {
        'knowledge domain':{ level_1:['Command','Identify'] },      'knowledge':{ level_1:['Command','Identify'] },
        'life domain':{ level_1:['Bless','Cure Wounds'] },           'life':{ level_1:['Bless','Cure Wounds'] },
        'light domain':{ level_1:['Burning Hands','Faerie Fire'] },  'light':{ level_1:['Burning Hands','Faerie Fire'] },
        'nature domain':{ level_1:['Animal Friendship','Speak with Animals'] }, 'nature':{ level_1:['Animal Friendship','Speak with Animals'] },
        'tempest domain':{ level_1:['Fog Cloud','Thunderwave'] },     'tempest':{ level_1:['Fog Cloud','Thunderwave'] },
        'trickery domain':{ level_1:['Charm Person','Disguise Self'] },'trickery':{ level_1:['Charm Person','Disguise Self'] },
        'war domain':{ level_1:['Divine Favor','Shield of Faith'] },  'war':{ level_1:['Divine Favor','Shield of Faith'] },
        'oath of devotion':{ level_1:['Protection from Evil and Good','Sanctuary'] }, 'devotion':{ level_1:['Protection from Evil and Good','Sanctuary'] },
        'oath of the ancients':{ level_1:['Ensnaring Strike','Speak with Animals'] }, 'ancients':{ level_1:['Ensnaring Strike','Speak with Animals'] },
        'oath of vengeance':{ level_1:['Bane',"Hunter's Mark"] },   'vengeance':{ level_1:['Bane',"Hunter's Mark"] },
        'the archfey':{ level_1:['Faerie Fire','Sleep'] },            'archfey':{ level_1:['Faerie Fire','Sleep'] },
        'the fiend':{ level_1:['Burning Hands','Command'] },          'fiend':{ level_1:['Burning Hands','Command'] },
        'the great old one':{ level_1:['Dissonant Whispers',"Tasha's Hideous Laughter"] },
        'great old one':{ level_1:['Dissonant Whispers',"Tasha's Hideous Laughter"] },
        'great-old-one':{ level_1:['Dissonant Whispers',"Tasha's Hideous Laughter"] },
      };
      const state = loadState();
      const nextStep = (input.step_completed || 1) + 1;
      state.creation_step = nextStep;
      if (input.data) {
        state.creation_data = Object.assign(state.creation_data || {}, input.data);
      }
      state.history_log.push({ timestamp: new Date().toISOString(),
        event: `Character creation step ${input.step_completed} complete. Moving to step ${nextStep}.` });
      saveState(state);
      const cd = state.creation_data;

      // Build helper data
      const classList  = buildClassListStr();
      const raceList   = buildRaceListStr();
      const chosenClass = (cd.class || '').toLowerCase();
      const classKey    = chosenClass.split(/[\s(]/)[0];
      const classData   = GAME_DATA.classes[classKey] || {};
      const archetypes  = classData.archetypes || [];
      const subclassOptions = archetypes.map(a => `• **${a.name}** — ${a.desc_short}`).join('\n');
      const isNonCaster = /barbarian|fighter|monk|ranger|rogue/i.test(cd.class||'');

      // ── Subclass injection: after class chosen (step 2→3), insert subclass step ──
      // If class has archetypes and no subclass chosen yet, stay at step 3 and show subclass
      if (input.step_completed === 2 && archetypes.length > 0 && !cd.subclass) {
        state.creation_step = 3;  // advance to 3 so next call goes to race
        state.creation_data._subclass_pending = true;
        state.history_log.push({ timestamp: new Date().toISOString(), event: `Character creation step 2 complete. Showing subclass options for ${cd.class}.` });
        saveState(state);
        const l1Note = /cleric|sorcerer|warlock/i.test(cd.class||'')
          ? '*(This subclass takes effect immediately at level 1.)*'
          : '*(This archetype unlocks at level 3, but defines your character\'s path from the start.)*';
        return {
          success: true, state_updated: true,
          direct_message: `${cd.class} — now choose your archetype.\n${l1Note}\n\n${subclassOptions}\n\nWhich path calls to you?`
        };
      }

      // ── Race injection: step 3 completed but no race chosen yet ──────────────────
      // Happens when a class has subclasses: step 3 was consumed by subclass selection,
      // so race would be skipped entirely. Re-use step 3 for race before advancing to
      // step 4 (background). The race list has already been sent via direct_message here.
      if (input.step_completed === 3 && !cd.race) {
        state.creation_step = 3;  // stay at 3 — next advance call from model will pick up race
        saveState(state);
        return {
          success: true, state_updated: true,
          direct_message: `Now choose your race:\n\n${raceList}\n\nWhich race are you?`
        };
      }

      // ── Step 11: Handle server-side — call create_character directly ────────────
      if (nextStep >= 11) {
        const cls = cd.class || 'Fighter';
        const lvl = 1;
        const stats = { ...(cd.stats || { str:10, dex:10, con:10, int:10, wis:10, cha:10 }) };
        const conMod = Math.floor((stats.con - 10) / 2);
        const hitDie = /barbarian/i.test(cls)?12:/fighter|paladin|ranger/i.test(cls)?10:/bard|cleric|druid|monk|rogue|warlock/i.test(cls)?8:6;
        const hp = hitDie + conMod;

        // Apply racial stat bonuses
        const isHuman = /^human$/i.test(cd.race || '');
        if (isHuman && cd.variant_human) {
          // Variant Human: +1 to two player-chosen stats (stored as flat keys)
          for (const k of [cd.variant_stat1, cd.variant_stat2].filter(Boolean)) { if (stats[k] !== undefined) stats[k] += 1; }
        } else if (isHuman) {
          // Standard Human: +1 to all
          for (const k of Object.keys(stats)) stats[k] += 1;
        }

        // Build inventory
        const classEqStr = getClassEquipment(cls);
        const bgEqStr = getBackgroundEquipment(cd.background||'');
        const parseEq = str => str.split('\n').map(l => l.replace(/^-\s*/,'')).filter(Boolean).map(n => ({ name:n, quantity:1, rarity:'common' }));
        const inventory = [...parseEq(classEqStr), ...parseEq(bgEqStr)];

        // Skill proficiencies: player-chosen (step 5) + background bonus
        const bgSkillMap = {
          acolyte:['Insight','Religion'], sage:['Arcana','History'], criminal:['Deception','Stealth'],
          'folk hero':['Animal Handling','Survival'], soldier:['Athletics','Intimidation'],
          outlander:['Athletics','Survival'], noble:['History','Persuasion'], entertainer:['Acrobatics','Performance'],
          hermit:['Medicine','Religion'], sailor:['Athletics','Perception'], urchin:['Sleight of Hand','Stealth'],
          charlatan:['Deception','Sleight of Hand'],
        };
        const bgKey = (cd.background||'').toLowerCase().replace(/\s+/g,' ').trim();
        const bgSkillList = bgSkillMap[bgKey] || [];
        const chosenSkills = Array.isArray(cd.skills) ? cd.skills : [];
        // Fallback if player somehow skipped skill step: use first N from pool
        const fallbackPool = (CLASS_SKILL_POOLS[classKey] || { count:2, pool:[] });
        const fallbackSkills = chosenSkills.length ? chosenSkills : fallbackPool.pool.slice(0, fallbackPool.count);
        let skillProfs = [...new Set([...fallbackSkills, ...bgSkillList])];
        // Variant Human bonus skill
        if (cd.variant_human && cd.variant_bonus_skill) skillProfs.push(cd.variant_bonus_skill);
        skillProfs = [...new Set(skillProfs)];

        // Saving throw proficiencies
        const savingThrows = {
          barbarian:['str','con'], bard:['dex','cha'], cleric:['wis','cha'], druid:['int','wis'],
          fighter:['str','con'], monk:['str','dex'], paladin:['wis','cha'], ranger:['str','dex'],
          rogue:['dex','int'], sorcerer:['con','cha'], warlock:['wis','cha'], wizard:['int','wis'],
        };

        // Inject always-prepared spells from subclass/domain/patron
        const subclassKey = (cd.subclass || '').toLowerCase().trim();
        const alwaysPrepared = ALWAYS_PREPARED[subclassKey] || {};
        const spells = { cantrips:[], level_1:[], ...(cd.spells || {}) };
        if (alwaysPrepared.level_1) spells.level_1 = [...new Set([...spells.level_1, ...alwaysPrepared.level_1])];
        if (alwaysPrepared.cantrips) spells.cantrips = [...new Set([...spells.cantrips, ...alwaysPrepared.cantrips])];

        // Build traits list
        const traits = [classData.name ? `${classData.name} features` : cls + ' features'];
        if (cd.variant_human && cd.variant_feat) traits.push(`Feat: ${cd.variant_feat}`);

        const ccInput = {
          name: cd.name || 'Adventurer',
          class: cls, race: cd.race || 'Human', background: cd.background || '',
          level: lvl, hp, stats, spells,
          description: cd.description || '',
          alignment: 'Neutral Good',
          skill_profs: skillProfs,
          saving_throw_profs: savingThrows[classKey] || [],
          traits,
          campaign_setting: cd.setting || 'Forgotten Realms',
          starting_location: cd.setting === 'Seafaring' ? 'A bustling port town' : cd.setting === 'Dark Gothic' ? 'A fog-shrouded village' : cd.setting === 'Political Intrigue' ? 'The capital city' : 'A small frontier town',
          inventory
        };

        let ccResult;
        try { ccResult = executeTool('create_character', ccInput); }
        catch(e) { ccResult = { error: e.message }; }

        if (ccResult.error) {
          return { success: false, error: ccResult.error, direct_message: `⚠️ Character creation failed: ${ccResult.error}` };
        }

        const skillSummary = skillProfs.slice(0,4).join(', ') + (skillProfs.length > 4 ? ` +${skillProfs.length-4} more` : '');
        const featNote = (cd.variant_human && cd.variant_feat) ? ` | **Feat:** ${cd.variant_feat}` : '';
        const charSummary = `✅ **Character sheet complete!**\n\n**${ccInput.name}** — ${cls}, Level 1 ${ccInput.race}\n**HP:** ${hp} | **AC:** ${/wizard|sorcerer/i.test(cls)?'12 (with Mage Armor)':/barbarian/i.test(cls)?'13 + DEX mod + CON mod':'12–14 (varies by armor)'}\n**Skills:** ${skillSummary}${featNote}\n**Background:** ${cd.background}\n\n*Your adventure begins...*`;

        return {
          success: true, state_updated: true,
          direct_message: charSummary
        };
      }

      // ── Normal step advancement ──────────────────────────────────────────────────
      const bgSkillMapForPrompt = {
        acolyte:['Insight','Religion'], sage:['Arcana','History'], criminal:['Deception','Stealth'],
        'folk hero':['Animal Handling','Survival'], soldier:['Athletics','Intimidation'],
        outlander:['Athletics','Survival'], noble:['History','Persuasion'], entertainer:['Acrobatics','Performance'],
        hermit:['Medicine','Religion'], sailor:['Athletics','Perception'], urchin:['Sleight of Hand','Stealth'],
        charlatan:['Deception','Sleight of Hand'],
      };
      const bgKeyForPrompt = (cd.background||'').toLowerCase().replace(/\s+/g,' ').trim();
      const bgGrantedSkills = bgSkillMapForPrompt[bgKeyForPrompt] || [];

      function roll4d6dl() {
        const dice = Array.from({length:4}, () => Math.floor(Math.random()*6)+1);
        dice.sort((a,b)=>a-b);
        return { total: dice[1]+dice[2]+dice[3], breakdown: `[${dice.join(',')}] → drop ${dice[0]} = **${dice[1]+dice[2]+dice[3]}**` };
      }
      const statsRollMsg = (() => {
        const rolls = ['STR','DEX','CON','INT','WIS','CHA'].map(stat => ({ stat, ...roll4d6dl() }));
        const sorted = [...rolls].sort((a,b)=>b.total-a.total).map(r=>r.total);
        const cls2 = (cd.class||'').toLowerCase();
        const suggestions = {
          wizard:'INT → DEX → CON → WIS → CHA → STR', sorcerer:'CHA → CON → DEX → WIS → INT → STR',
          warlock:'CHA → CON → DEX → WIS → INT → STR', bard:'CHA → DEX → CON → WIS → INT → STR',
          cleric:'WIS → STR → CON → CHA → DEX → INT', druid:'WIS → CON → DEX → INT → CHA → STR',
          paladin:'STR → CHA → CON → WIS → DEX → INT', fighter:'STR → CON → DEX → WIS → CHA → INT',
          barbarian:'STR → CON → DEX → WIS → CHA → INT', ranger:'DEX → WIS → CON → STR → INT → CHA',
          rogue:'DEX → INT → CON → CHA → WIS → STR', monk:'DEX → WIS → CON → STR → INT → CHA',
        };
        const suggestion = Object.entries(suggestions).find(([k]) => cls2.startsWith(k));
        const suggStr = suggestion ? `\n\n**Suggested assignment for ${cd.class}:** ${suggestion[1]}` : '';
        const lines = rolls.map(r => `**${r.stat}:** ${r.breakdown}`).join('\n');
        return `Rolling your stats — 4d6, drop lowest, for each ability score.\n\n${lines}${suggStr}\n\nYou have: **${sorted.join(', ')}**. How would you like to assign these to STR / DEX / CON / INT / WIS / CHA?`;
      })();

      const nextPrompts = {
        2: `Now let's choose your class. Here are all 12 options:\n\n${classList}\n\nWhich class calls to you?`,
        3: cd._subclass_pending
          ? `You chose **${cd.class}**. Now pick your subclass archetype:\n\n${subclassOptions}\n\nWhich path calls to you?`
          : `Now choose your race:\n\n${raceList}\n\nWhich race are you?`,
        4: `Choose your background:\n\n1. **Acolyte** — Temple servant. +Insight, Religion.\n2. **Charlatan** — Con artist. +Deception, Sleight of Hand.\n3. **Criminal** — Outlaw. +Deception, Stealth.\n4. **Entertainer** — Performer. +Acrobatics, Performance.\n5. **Folk Hero** — Common champion. +Animal Handling, Survival.\n6. **Hermit** — Recluse. +Medicine, Religion.\n7. **Noble** — Privileged. +History, Persuasion.\n8. **Outlander** — Wilderness wanderer. +Athletics, Survival.\n9. **Sage** — Scholar. +Arcana, History.\n10. **Sailor** — Sea veteran. +Athletics, Perception.\n11. **Soldier** — Military. +Athletics, Intimidation.\n12. **Urchin** — Street kid. +Sleight of Hand, Stealth.\n\nWhich fits your past?`,

        5: (() => {
          const info = CLASS_SKILL_POOLS[classKey] || { count:2, pool:['Perception','Insight','Athletics','Stealth'] };
          const available = info.pool.filter(s => !bgGrantedSkills.includes(s));
          const poolLines = info.pool.map(s => bgGrantedSkills.includes(s) ? `• ~~${s}~~ *(background)*` : `• ${s}`).join('\n');
          const bgNote = bgGrantedSkills.length ? `\n\n*Your **${cd.background}** background already grants: ${bgGrantedSkills.join(', ')}.*` : '';
          return `Now choose your skill proficiencies.\n\nAs a **${cd.class}**, pick **${info.count}** from:\n\n${poolLines}${bgNote}\n\nWhich ${info.count} do you want?`;
        })(),

        6: (() => {
          const featList = [
            '**Alert** — +5 initiative; can\'t be surprised while conscious.',
            '**Durable** — +1 CON; recover more HP when spending hit dice.',
            '**Lucky** — 3 luck points/day to reroll any d20 (attack, save, or ability check).',
            '**Magic Initiate** — Learn 2 cantrips and 1 1st-level spell from any class.',
            '**Mobile** — +10 ft. speed; Dash ignores difficult terrain; no opportunity attacks after melee.',
            '**Resilient** — +1 to one ability score; gain proficiency in that saving throw.',
            '**Sentinel** — Opportunity attacks halt movement; protect allies; advantage when target attacks others.',
            '**Skilled** — Gain proficiency in any 3 skills or tools.',
            '**Tavern Brawler** — Unarmed d4 damage; +1 STR or CON; bonus grapple after unarmed hit.',
            '**Tough** — +2 max HP per level (and retroactively for past levels).',
            '**War Caster** — Advantage on concentration saves; cast somatic spells while holding weapons/shield; cast a spell as an opportunity attack.',
            '**Weapon Master** — +1 STR or DEX; proficiency with 4 weapons of your choice.',
          ].join('\n');
          return `As a **Human**, choose your variant:\n\n• **Standard Human** — +1 to all six ability scores.\n• **Variant Human** — +1 to two ability scores of your choice, one bonus skill, and one feat.\n\n**If you choose Variant Human**, tell me:\n1. Which two stats to +1 (e.g. INT and DEX)\n2. Which bonus skill (any skill you aren't already proficient in)\n3. Which feat:\n\n${featList}\n\nWhat's your choice?`;
        })(),

        7: statsRollMsg,

        8: (() => {
          if (isNonCaster) return `${cd.class} doesn't use spells — moving straight to equipment.\n\n*(Calling the next step...)*`;
          const spellMsg = buildSpellListMessage(cd.class);
          return spellMsg || `Choose your starting spells for ${cd.class}. What cantrips and level 1 spells would you like?`;
        })(),

        9: `Here is your starting equipment:\n\n**From your ${cd.class} class:**\n${getClassEquipment(cd.class)}\n\n**From your ${cd.background} background:**\n${getBackgroundEquipment(cd.background)}\n\nReady to name your character?`,

        10: `Almost done — let's bring your character to life.\n\n**1. What is your character's name?**\n\n**2. What does your ${cd.race || 'character'} ${(cd.class||'adventurer').split(/[\s(]/)[0]} look like?** A scar, a striking feature, something that sets you apart.\n\n**3. (Optional but encouraged)** Who are they? Where do they come from? What drives them — a loss, a debt, a promise?\n\n*Share whatever feels right. This becomes the DM's bible for your character.*`,
      };

      // Non-human races skip the feat step (step 6) — jump straight to stats (step 7)
      if (input.step_completed === 5) {
        const isHumanRace = /^human$/i.test((cd.race || '').trim());
        if (!isHumanRace) {
          state.creation_step = 7;
          saveState(state);
          return { success: true, state_updated: true, direct_message: nextPrompts[7] };
        }
      }

      const nextInstruction = nextPrompts[nextStep] || nextPrompts[10];

      return {
        success: true,
        step_completed: input.step_completed,
        next_step: nextStep,
        state_updated: true,
        direct_message: nextInstruction
      };
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
      // Use the shared helper so keys are always "level_1", "level_2", etc.
      // (The old inline merge stored numeric keys like "1","2" which broke use_spell_slot.)
      const fullSlots = computeSpellSlots(cls, lvl);

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
          map_id: null,
          story_notes: input.description ? `CHARACTER BACKSTORY — ${input.name}: ${input.description}` : ''
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
          initiative_bonus: Math.floor((((input.stats||{}).dex||10) - 10) / 2),
          passive_perception: 10 + Math.floor((((input.stats||{}).wis||10) - 10) / 2) + ((input.skill_profs||[]).map(s=>s.toLowerCase()).includes('perception') ? prof : 0),
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
          channel_divinity: (/cleric/i.test(cls) && lvl>=2) || (/paladin/i.test(cls) && lvl>=3) ? {max:1,used:0} : {max:0,used:0},
          lay_on_hands_used: 0,
          inventory: input.inventory || []
        }],
        npcs: [], quests: [], encounters: [],
        history_log: [{ timestamp: new Date().toISOString(), event: `${input.name} created. ${input.class} Level ${lvl}. Adventure begins.` }]
      };

      saveState(newState);

      // Clear chronicle so the new campaign starts fresh
      try { fs.writeFileSync(path.join(APP_DIR, 'chronicle.txt'), `# Chronicle — ${input.name} (${input.class})\nStarted: ${new Date().toLocaleString()}\n`, 'utf8'); } catch {}

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
  const char=state.party[0]; const world=state.world;
  const slots=Object.entries(char.spell_slots).filter(([,v])=>v.max>0).map(([k,v])=>`Lv${k.replace('level_','')}: ${v.max-v.used}/${v.max}`).join(', ');
  const cd=char.channel_divinity;
  // OPTIMIZATION: List weapons, foci, armor, potions (first 5 items by priority)
  const KEY_CATEGORIES = /weapon|sword|axe|hammer|bow|staff|wand|dagger|rapier|mace|shield|armor|mail|focus|symbol|kit|potion/i;
  const keyItems=(char.inventory||[]).filter(i=>KEY_CATEGORIES.test(i.name)).slice(0,5).map(i=>i.name).join(', ');
  // OPTIMIZATION: Only include active quests with uncompleted steps (1-line summary)
  const questSummary=(state.quests||[]).filter(q=>q.status==='active'&&q.steps.some(s=>!s.completed)).map(q=>`${q.title}: ${q.steps.filter(s=>!s.completed).map(s=>s.description).join(', ')}`).join(' | ');

  // New campaign — state-tracked character creation (one step at a time)
  if (state.campaign_id === 'new-campaign') {
    const step = state.creation_step || 1;
    const cd   = state.creation_data || {};
    const classList  = buildClassListStr();
    const raceList   = buildRaceListStr();
    const chosenClass = (cd.class || '').toLowerCase();
    const classKey2   = chosenClass.split(/[\s(]/)[0];
    const classData2  = GAME_DATA.classes[classKey2] || {};
    const subclassOpts2 = (classData2.archetypes||[]).map(a => `• ${a.name} — ${a.desc_short}`).join('\n');

    // Step 3 behaviour: if subclass pending, wait for subclass; otherwise wait for race
    // In both cases the server already sent the list via direct_message — do NOT re-present it.
    const step3Instruction = cd._subclass_pending
      ? `The player chose **${cd.class}**. The subclass options were already shown above.
Wait for their pick. When they choose: call advance_creation_step({step_completed: 3, data: {subclass: "<their choice>", _subclass_pending: false}})`
      : `Class chosen: ${cd.class}${cd.subclass ? ' ('+cd.subclass+')' : ''}.
The race list has already been shown to the player above — do NOT re-present it.
Wait for the player's race pick. When they choose: call advance_creation_step({step_completed: 3, data: {race: "<their choice>"}})`;

    const stepInstructions = {
      1: `The adventure-type options were already shown. The player is responding now.
Read their choice and call advance_creation_step({step_completed: 1, data: {setting: "<their choice>"}})`,

      2: `Setting: "${cd.setting || ''}". The class list was already shown to the player.
Read their class choice and call advance_creation_step({step_completed: 2, data: {class: "<their choice>"}})`,

      3: step3Instruction,

      4: cd.background
        ? `Background already chosen: ${cd.background}. Immediately call advance_creation_step({step_completed: 4, data: {background: "${cd.background}"}}).`
        : `Race: ${cd.race || '(unknown)'}. The background list was already shown to the player.
Read their pick and call advance_creation_step({step_completed: 4, data: {background: "<their choice>"}})`,

      5: `Background: "${cd.background || ''}". The skill list was already shown to the player.
Read their chosen skills and call advance_creation_step({step_completed: 5, data: {skills: ["Skill1", "Skill2", ...]}})
Include exactly the skills they named — do not add or remove any.`,

      6: /^human$/i.test(cd.race||'')
        ? `Race is Human. The Standard vs Variant Human options were shown.
Standard Human: call advance_creation_step({step_completed: 6, data: {variant_human: false}})
Variant Human: call advance_creation_step({step_completed: 6, data: {variant_human: true, variant_stat1: "str", variant_stat2: "dex", variant_bonus_skill: "Perception", variant_feat: "Lucky"}})
Replace the example values with the player's actual choices. Stat keys are lowercase: str dex con int wis cha.`
        : `Race is not Human — skip immediately. Call advance_creation_step({step_completed: 6, data: {}})`,

      7: `Ability scores have been rolled and shown. Do NOT call roll_dice.
Read the player's assignment (e.g. "INT 16, DEX 14..."). Confirm choices.
When confirmed: call advance_creation_step({step_completed: 7, data: {stats: {str:N, dex:N, con:N, int:N, wis:N, cha:N}}})`,

      8: /barbarian|fighter|monk|ranger|rogue/i.test(cd.class||'')
        ? `${cd.class} doesn't cast spells. Immediately call advance_creation_step({step_completed: 8, data: {}}).`
        : `The spell list has been shown above. The player MUST choose their spells now — you CANNOT skip this step.

YOUR STEPS:
1. WAIT for the player to explicitly name their chosen spells.
2. Do NOT advance until the player has actually chosen spells. Do NOT use empty arrays.
3. Parse their choices carefully. Include spell names EXACTLY as they said them.
4. When you have their spells, call: advance_creation_step({step_completed: 8, data: {spells: {cantrips: ["Spell Name", ...], level_1: ["Spell Name", ...]}}})
5. If confused, re-show the spell list and explain the options again.`,

      9: `Equipment list shown to the player. Wait for acknowledgment. When they say ready/yes: call advance_creation_step({step_completed: 9, data: {}})`,

      10: `The player will provide their character name, physical appearance, and optionally backstory/motivations in their NEXT message.

YOUR STEPS:
1. Read the player's message carefully. Extract: name, appearance, and any backstory/motivation details they share.
2. If the name isn't stated, ask for it first: "I see them clearly — but what is their name?"
3. If appearance is missing, ask: "And one physical detail that makes them recognizable?"
4. Once you have name + appearance (backstory is bonus), write a rich 4-6 sentence character portrait that weaves together appearance, personality, backstory, motivations, and any relationships or quests they mentioned. Make it vivid and specific — this will be the DM's reference for the entire campaign.
5. THEN call: advance_creation_step({step_completed: 10, data: {name: "<exact name they gave>", description: "<full 4-6 sentence portrait including everything they shared>"}})

IMPORTANT: Capture EVERYTHING the player tells you. A grudge, a dead sibling, a stolen heirloom, a promised return — include it all in the description. Do NOT discard backstory details.`,
    };

    const currentInstruction = stepInstructions[step] || stepInstructions[10];

    return `You are a Dungeon Master running character creation for a solo D&D 5e campaign.

CREATION PROGRESS: ${JSON.stringify(cd)}
Step: ${step}

YOUR ONLY JOB RIGHT NOW:
${currentInstruction}

HARD RULES:
- Do ONLY what the current step says. Nothing more.
- Do NOT describe any location, scene, or NPC.
- Do NOT skip ahead. Do NOT call create_character (server handles it at step 11).
- Do NOT call roll_dice for stats — server rolls them.
- Steps 1–9: OUTPUT NO TEXT. Your ONLY action is to call advance_creation_step.
- Step 10 only: You may write a rich character portrait (4-6 sentences), then call advance_creation_step.`;
  }

  // Ongoing campaign — generic, reads from state
  // char already defined above
  const hpMax = char.hp_max || char.hp;
  const pb = char.proficiency_bonus || profBonus(char.level||1);
  const strMod = Math.floor(((char.stats?.str||10)-10)/2);
  const dexMod = Math.floor(((char.stats?.dex||10)-10)/2);
  const wisMod = Math.floor(((char.stats?.wis||10)-10)/2);
  const chaMod = Math.floor(((char.stats?.cha||10)-10)/2);
  // Melee attack bonus = higher of STR/DEX + prof; spell attack = highest mental + prof
  const meleeAtk = Math.max(strMod, dexMod) + pb;
  const spellAtk = Math.max(wisMod, chaMod) + pb;
  const spellDC = 8 + spellAtk;
  const conditions = (char.conditions||[]).join(', ') || 'none';
  const hitDice = char.hit_dice_total ? `${char.hit_dice_total-(char.hit_dice_used||0)}/${char.hit_dice_total} HD` : '';
  const xpStr = char.xp != null ? `XP: ${char.xp}` : '';
  const ds = char.death_saves;
  const dsStr = (char.hp===0&&ds) ? ` | Death Saves: ${ds.successes}✓ ${ds.failures}✗` : '';
  // Lay on Hands pool (paladins only)
  const isPaladin = /paladin/i.test(char.class||'');
  const lohMax = isPaladin ? (char.level||1)*5 : 0;
  const lohRemain = lohMax - (char.lay_on_hands_used||0);
  const lohStr = lohMax ? ` | LoH: ${lohRemain}/${lohMax}HP` : '';
  // Active concentration spell effects
  const concSpell = (char.conditions||[]).find(c=>/^concentrating on/i.test(c));
  const protEvil = concSpell && /protection from evil/i.test(concSpell);
  const protEvilNote = protEvil ? '\n⚡ Protection from Evil & Good ACTIVE: undead/aberrations/fiends/fey/elementals/celestials attack with DISADVANTAGE (2d20kl1). Character attacks them with ADVANTAGE (2d20kh1).' : '';
  const recentEvents = (state.history_log||[]).slice(-8).map(e=>`• ${e.event}`).join('\n');
  const storyNotes = world.story_notes ? `\nSTORY NOTES (persisted facts — treat as canon):\n${world.story_notes}` : '';

  // Session recap from previous session — injected as narrative continuity
  const sessionRecap = world.session_recap
    ? `\nPREVIOUSLY IN YOUR ADVENTURE:\n${world.session_recap}\n`
    : '';

  // Auto-chronicle: last ~1500 chars of this session's DM narration (cross-turn continuity)
  let chronicleCtx = '';
  try {
    const cPath = path.join(APP_DIR, 'chronicle.txt');
    if (fs.existsSync(cPath)) {
      const raw = fs.readFileSync(cPath, 'utf8');
      const tail = raw.slice(-1800);
      const cut = tail.indexOf('\n---\n');
      chronicleCtx = cut >= 0 ? tail.slice(cut) : tail;
      if (chronicleCtx.trim()) chronicleCtx = `\nSESSION SO FAR (narrative log — treat as recent memory):\n${chronicleCtx.trim()}\n`;
    }
  } catch {}

  return `You are the Dungeon Master for a solo D&D 5e campaign. Your voice has four qualities woven together at all times:

TONE:
- Immersive & literary: Write in vivid, atmospheric prose. Every location has a smell, a sound, a feeling. NPCs have distinct voices and mannerisms. Descriptions pull the player into the world rather than summarizing it.
- Gritty & grounded: Consequences are real. The world doesn't bend to the player's will — it pushes back. Danger feels genuine. Resources matter. Not every problem has a clean solution.
- Classic tabletop energy: Warm, theatrical, forward-moving. You keep momentum, reward player engagement, and match their energy. Occasional dry wit when the moment allows.
- Dark & mysterious: Secrets run underneath everything. NPCs have agendas they don't reveal. Even quiet scenes carry a sense of something watching, waiting, or hidden. Mystery is a flavor, not a plot device.

⛔ ABSOLUTE PROHIBITION — NEVER DO THIS:
Do NOT present numbered or bulleted choice menus to the player. EVER.
Examples of what is FORBIDDEN:
  1. Go to the tavern
  2. Ask the guard
  3. Explore the ruins
  "Would you like to: (a) fight (b) flee (c) negotiate?"
  "You could: • Enter the building • Wait outside • Leave town"
This is a tabletop RPG, not a video game. The player decides what they do. You narrate consequences. Period.
If you produce a numbered or lettered option list, you have failed as a Dungeon Master.

NARRATIVE RULES:
- The player's words are the ONLY input that matters. Read their message, then respond DIRECTLY to it. If they ask "Is there an inn?" — show them the inn. If they say "I leave town" — they leave town. Do NOT have NPCs ignore or talk past what the player just said.
- NPCs must react to the player character's ACTUAL words. If the player answered a question, the NPC heard that answer. Do NOT repeat questions the player already answered.
- NEVER repeat narration, descriptions, or bullet choices you have already written. Every response must be new.
- Reference the CHARACTER DESCRIPTION whenever it's relevant — their past shapes how NPCs treat them, what they notice, what haunts them.
- Call update_story_notes for major permanent facts only: a character's true identity revealed, a quest-changing decision, a secret that must survive forever. The session chronicle and conversation history handle short-term memory automatically.
- ALWAYS narrate alongside tool calls. No tool-only responses.

MECHANICS RULES:
- Roll EVERY check with roll_dice. Call use_spell_slot when leveled spells cast. Call update_hp after damage/healing.
- Call set_concentration when a concentration spell is cast. Call skill_check after rolling for DC-based checks.
- Use add_condition/remove_condition for status effects. Use add_npc/update_npc when meeting or changing NPCs.
- Use add_quest/complete_quest_step to track objectives. Use update_location when scene changes.
- When HP reaches 0: add_condition("Unconscious"), then death_save for each roll. 3 successes = stable, 3 failures = dead.
- Call award_xp after combat, quest completions, milestones. Call end_session when player says "end session."
- Call update_ac whenever AC changes (equip/remove armor or shield, fighting style active). Use the tool — do NOT rely on story_notes.
- Lay on Hands is NOT a spell slot. Use the lay_on_hands tool, not use_spell_slot.
- LEVEL UP: If award_xp returns leveled:true or level_up_instructions is set, you MUST stop the narrative and follow those instructions exactly — announce the level-up dramatically, list new features, ask the player to roll their HP die, call add_trait for each new feature, call update_spells for each new spell chosen, then continue the story.
- Call update_spells (once per spell) when the player learns or swaps any spell. Call add_trait for each new class feature, racial ability, or permanent upgrade gained.

⚔️ COMBAT RULES — READ CAREFULLY:
- ADVANTAGE = 2d20kh1+X (keep highest). DISADVANTAGE = 2d20kl1+X (keep lowest). THESE ARE DIFFERENT. Never use kh1 for disadvantage.
- When "Concentrating on Protection from Evil and Good" is in Conditions: aberrations, celestials, elementals, fey, fiends, and undead ALL have DISADVANTAGE on attack rolls against the character (2d20kl1). Apply this automatically every time those creature types attack.
- Divine Smite: OPTIONAL — declare AFTER a hit is confirmed. Roll attack first. If it hits, narrate the opening and ask if the player smites. Only call use_spell_slot AFTER the player confirms. Never pre-spend the slot.
- The character always attacks with ADVANTAGE against undead/aberrations when Protection from Evil is active.
- NEVER roll dice to determine how many enemies are in a room — you decide that as DM.
- NEVER call skill_check for Religion when a spell is being cast — casting a prepared spell is automatic, no check required.

═══════════════════════
CAMPAIGN: ${world.name||'Unknown World'}
Location: ${world.current_location} | Time: ${world.time}

CHARACTER: ${char.name} | ${char.class} L${char.level} | HP: ${char.hp}/${hpMax}${dsStr} | AC: ${char.ac||'(use update_ac)'} | Prof +${pb}${xpStr?' | '+xpStr:''}
Attack bonus: +${meleeAtk} melee | Spell attack: +${spellAtk} | Spell DC: ${spellDC}${lohStr}
Spells: ${slots||'none'} | CD: ${cd.max-cd.used}/${cd.max}${hitDice?' | '+hitDice:''}
Conditions: ${conditions}${protEvilNote}
Gear: ${keyItems||'standard equipment'}${char.description ? `\nCHARACTER DESCRIPTION: ${char.description}` : ''}

ACTIVE QUESTS: ${questSummary||'None'}
WORLD: ${world.lore_summary||''}${world.weather?`\nWEATHER: ${world.weather.condition}${world.weather.description?' — '+world.weather.description:''}`:''}${storyNotes}${sessionRecap}${chronicleCtx}
RECENT EVENTS:
${recentEvents||'— Campaign beginning —'}`;

}

// ─── GEMINI NATIVE API HELPERS ────────────────────────────────────────────────

// Convert OpenAI-format message array + tool list to a native Gemini request body.
// OpenAI roles/shapes → Gemini roles/parts:
//   system    → systemInstruction
//   user      → {role:'user',  parts:[{text}]}            (consecutive merged)
//   assistant → {role:'model', parts:[{text?},{functionCall?}]}
//   tool      → merged into preceding/new user turn as    {functionResponse:{name,id,response}}
// thoughtSignature stored on tc.thought_signature is replayed into functionCall parts
// so Gemini 3 doesn't reject with "missing thought_signature" on the second loop.
function toGeminiRequest(msgs, tools, { maxOutputTokens = 8192, temperature = 0.72 } = {}) {
  let systemText = '';
  const contents = [];
  const missingThoughtSigIds = new Set(); // tracks tool call IDs serialized as text (no thoughtSignature)

  const lastContent = () => contents[contents.length - 1];
  const ensureRole = (role) => {
    if (lastContent()?.role !== role) contents.push({ role, parts: [] });
    return lastContent();
  };

  for (const msg of msgs) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n' : '') + (msg.content || '');
      continue;
    }

    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      ensureRole('user').parts.push({ text });
      continue;
    }

    if (msg.role === 'assistant') {
      const turn = ensureRole('model');
      if (msg.content) turn.parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.thought_signature) {
            // Has thoughtSignature — replay as proper functionCall
            let args;
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
            const fc = { name: tc.function?.name || 'unknown', args };
            if (tc.id) fc.id = tc.id;
            fc.thoughtSignature = tc.thought_signature;
            turn.parts.push({ functionCall: fc });
          } else {
            // No thoughtSignature (Gemini 3.5 Flash never returns it) — emit as text
            // to avoid "missing thought_signature" HTTP 400 on replay.
            missingThoughtSigIds.add(tc.id);
            turn.parts.push({ text: `[used ${tc.function?.name || 'tool'}]` });
          }
        }
      }
      // Gemini rejects model turns with zero parts
      if (turn.parts.length === 0) turn.parts.push({ text: '' });
      continue;
    }

    if (msg.role === 'tool') {
      if (missingThoughtSigIds.has(msg.tool_call_id)) {
        // Matching tool result for a text-fallback call — emit as user text to preserve context
        let result;
        try { result = JSON.parse(msg.content); } catch { result = { result: msg.content }; }
        ensureRole('user').parts.push({ text: `[${msg.name || 'tool'} result: ${JSON.stringify(result).slice(0, 300)}]` });
        continue;
      }
      let response;
      try { response = JSON.parse(msg.content); } catch { response = { result: msg.content }; }
      const fr = { name: msg.name || 'tool', response };
      if (msg.tool_call_id) fr.id = msg.tool_call_id;
      ensureRole('user').parts.push({ functionResponse: fr });
      continue;
    }
  }

  const reqBody = {
    // NOTE: Gemini 3.x (incl. 3.1-flash-lite) cannot disable thinking — the old
    // thinkingBudget:0 (a 2.5-era field) is ignored or rejected, so it's removed.
    // The model still emits thoughtSignatures; toGeminiRequest() handles that by
    // serializing unsigned tool calls as text on replay (see assistant branch above).
    generationConfig: { maxOutputTokens, temperature }
  };
  if (systemText) reqBody.systemInstruction = { parts: [{ text: systemText }] };
  reqBody.contents = contents;

  if (tools && tools.length > 0) {
    reqBody.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }];
    reqBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  return reqBody;
}

// ─── AGENTIC DM LOOP (Gemini native API) ──────────────────────────────────────

// makeAPICall with automatic 429 retry.
// onWait(seconds) is called so the agentic loop can notify the player.
function makeAPICall(bodyStr, retryCount = 0, onWait = null) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < REQUEST_DELAY_MS) {
      setTimeout(() => makeAPICall(bodyStr, retryCount, onWait).then(resolve).catch(reject),
        REQUEST_DELAY_MS - timeSinceLastRequest);
      return;
    }
    lastRequestTime = Date.now();

    const buf = Buffer.from(bodyStr);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${MODEL}:streamGenerateContent?key=${API_KEY}&alt=sse`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length
      }
    }, (res) => {
      // 429 — rate limit hit. Read Retry-After and retry automatically (up to 6 times).
      if (res.statusCode === 429 && retryCount < 6) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          // Gemini returns Retry-After in seconds (parse from body too, header may be absent)
          let retryAfterSec = parseInt(res.headers['retry-after'] || '0', 10);
          if (!retryAfterSec) {
            const m = body.match(/retry[_ ]in[^0-9]*([0-9.]+)s/i);
            retryAfterSec = m ? Math.ceil(parseFloat(m[1])) : 20;
          }
          // If wait > 2 minutes it's a daily/hourly cap — fail fast rather than freezing
          if (retryAfterSec > 120) {
            const mins = Math.ceil(retryAfterSec / 60);
            reject(new Error(`Gemini daily rate limit reached. Please wait ~${mins} minutes then try again.`));
            return;
          }
          const waitMs = retryAfterSec * 1000 + 1500; // honour full Retry-After + 1.5s buffer
          console.log(`  ⏳ Rate limit — waiting ${(waitMs/1000).toFixed(1)}s then retrying (attempt ${retryCount+1}/6)`);
          if (onWait) onWait(Math.ceil(waitMs / 1000));
          setTimeout(() => makeAPICall(bodyStr, retryCount + 1, onWait).then(resolve).catch(reject), waitMs);
        });
        res.on('error', reject);
        return;
      }

      if (res.statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          let errMsg = `HTTP ${res.statusCode}`;
          try {
            const j = JSON.parse(body);
            if (j.error?.message) errMsg = `HTTP ${res.statusCode} — ${j.error.message}`;
          } catch {}
          if (errMsg === `HTTP ${res.statusCode}`) errMsg += `: ${body.slice(0, 300)}`;
          if (res.statusCode === 400) {
            try { fs.writeFileSync(path.join(APP_DIR, 'last_400_body.json'), bodyStr); } catch {}
            console.error('  📝 Wrote failing request to last_400_body.json');
          }
          const err = new Error(errMsg);
          err.statusCode = res.statusCode;
          reject(err);
        });
        res.on('error', reject);
        return;
      }
      trackDailyRequest();
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('Gemini API request timed out after 90s')));
    req.write(buf); req.end();
  });
}

// Non-streaming Gemini call for tool loops.
// Returns the parsed response object with full thoughtSignature support.
// Used when tools are enabled — we need the full response including thoughtSignature.
function makeAPICallNonStreaming(bodyStr, retryCount = 0, onWait = null) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < REQUEST_DELAY_MS) {
      setTimeout(() => makeAPICallNonStreaming(bodyStr, retryCount, onWait).then(resolve).catch(reject),
        REQUEST_DELAY_MS - timeSinceLastRequest);
      return;
    }
    lastRequestTime = Date.now();

    const buf = Buffer.from(bodyStr);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length
      }
    }, (res) => {
      // 429 — rate limit hit. Read Retry-After and retry automatically (up to 6 times).
      if (res.statusCode === 429 && retryCount < 6) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          let retryAfterSec = parseInt(res.headers['retry-after'] || '0', 10);
          if (!retryAfterSec) {
            const m = body.match(/retry[_ ]in[^0-9]*([0-9.]+)s/i);
            retryAfterSec = m ? Math.ceil(parseFloat(m[1])) : 20;
          }
          if (retryAfterSec > 120) {
            const mins = Math.ceil(retryAfterSec / 60);
            reject(new Error(`Gemini daily rate limit reached. Please wait ~${mins} minutes then try again.`));
            return;
          }
          const waitMs = retryAfterSec * 1000 + 1500;
          console.log(`  ⏳ Rate limit — waiting ${(waitMs/1000).toFixed(1)}s then retrying (attempt ${retryCount+1}/6)`);
          if (onWait) onWait(Math.ceil(waitMs / 1000));
          setTimeout(() => makeAPICallNonStreaming(bodyStr, retryCount + 1, onWait).then(resolve).catch(reject), waitMs);
        });
        res.on('error', reject);
        return;
      }

      if (res.statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          let errMsg = `HTTP ${res.statusCode}`;
          try {
            const j = JSON.parse(body);
            if (j.error?.message) errMsg = `HTTP ${res.statusCode} — ${j.error.message}`;
          } catch {}
          if (errMsg === `HTTP ${res.statusCode}`) errMsg += `: ${body.slice(0, 300)}`;
          if (res.statusCode === 400) {
            try { fs.writeFileSync(path.join(APP_DIR, 'last_400_body.json'), bodyStr); } catch {}
            console.error('  📝 Wrote failing request to last_400_body.json');
          }
          const err = new Error(errMsg);
          err.statusCode = res.statusCode;
          reject(err);
        });
        res.on('error', reject);
        return;
      }

      trackDailyRequest();
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse Gemini response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('Gemini API request timed out after 90s')));
    req.write(buf); req.end();
  });
}

// Non-streaming Groq call — returns the full assistant text or throws.
// Used for summarization (no tools, no SSE).
function makeSimpleAPICall(messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0.3,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      }))],
      stream: false
    });
    const buf = Buffer.from(bodyStr);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/openai/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'Authorization': `Bearer ${API_KEY}`
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          const j = JSON.parse(body);
          const text = j.choices?.[0]?.message?.content || '';
          resolve(text.trim());
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Summary API call timed out after 30s')));
    req.write(buf); req.end();
  });
}


async function streamAgenticLoop(messages, systemPrompt, res, opts = {}) {
  const isCreation = opts.isCreation || false;
  let totalTokens = 0;
  let apiError = null;

  // Groq uses OpenAI-compatible format: system as first message in array.
  // contextMsgs is maintained separately so messages (caller's array) stays as
  // simple {role, content:string} pairs for history persistence.
  const contextMsgs = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }))
  ];

  console.log(`  ▶ Agentic loop start — ${messages.length} messages in context`);

  // Trim oldest non-system messages when context grows too large for Groq's TPM budget.
  // Target: system prompt + history ≤ 2,000 tokens (leaves budget for tools + 800 output).
  function pruneContext() {
    const MAX_MSG_TOKENS = 6000; // was 1000 — Gemini charges per request not per token, so larger context is free
    while (contextMsgs.length > 2) {
      const total = contextMsgs.reduce((s, m) =>
        s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')), 0);
      if (total <= MAX_MSG_TOKENS) break;
      // Remove oldest non-system message. If it's an assistant turn with tool_calls,
      // also remove all immediately following 'tool' result messages to avoid leaving
      // orphaned functionResponse parts that Gemini would reject.
      let removeCount = 1;
      if (contextMsgs[1]?.tool_calls?.length) {
        let i = 2;
        while (i < contextMsgs.length && contextMsgs[i].role === 'tool') i++;
        removeCount = i - 1;
      }
      contextMsgs.splice(1, removeCount);
    }
  }

  let goto_end = false;
  let funcCallFailures = 0;
  let consecutiveToolLoops = 0;
  let hasCalledToolsThisTurn = false;
  pruneContext(); // prune once before loop — never prune messages added mid-loop (prevents orphaned tool results)
  for (let loop = 0; loop < 6; loop++) {
    const msgsTokens = contextMsgs.reduce((s, m) =>
      s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
    const activeTools = isCreation ? CREATION_TOOLS : GAMEPLAY_TOOLS;
    const toolsTokens = estimateTokens(JSON.stringify(activeTools));
    await waitForTokenCapacity(msgsTokens + toolsTokens);

    // Narration passes omit tools entirely so Gemini cannot attempt function calls.
    const forceNarration = hasCalledToolsThisTurn || funcCallFailures > 0 || consecutiveToolLoops >= 2;
    const body = JSON.stringify(toGeminiRequest(
      contextMsgs,
      forceNarration ? null : activeTools,
      { maxOutputTokens: 8192, temperature: 0.72 }
    ));

    // onWait: called when a 429 retry is triggered — sends a status notice to the player
    const onWait = (seconds) => {
      res.write(`data: ${JSON.stringify({ type: 'text', content: `\n\n*— Rate limit reached. Resuming in ~${seconds}s… —*\n\n` })}\n\n`);
    };

    let textTurn = '';
    let toolCalls = [];
    let stopReason = 'stop';
    let stateUpdated = false;
    let apiErr = null;

    // Option A fix: Use non-streaming for tool loops (to capture thoughtSignature),
    // streaming for narration-only (for real-time player feedback).
    if (!forceNarration) {
      // Tool loop: use non-streaming generateContent to get full response with thoughtSignature
      try {
        const fullResponse = await makeAPICallNonStreaming(body, 0, onWait);
        if (fullResponse.error) {
          apiErr = fullResponse.error.message || 'Gemini API error';
        } else {
          if (fullResponse.usageMetadata) totalTokens += fullResponse.usageMetadata.candidatesTokenCount || 0;
          const candidate = fullResponse.candidates?.[0];
          if (candidate) {
            if (candidate.finishReason) stopReason = candidate.finishReason;
            for (const part of (candidate.content?.parts || [])) {
              if (part.thought) continue; // skip internal thinking tokens
              if (part.text) {
                textTurn += part.text;
                if (!isCreation || opts.creationStep === 8) {
                  res.write(`data: ${JSON.stringify({ type: 'text', content: part.text })}\n\n`);
                }
              }
              if (part.functionCall) {
                const fc = part.functionCall;
                toolCalls.push({
                  id:              fc.id || `call_${loop}_${toolCalls.length}_${Date.now()}`,
                  name:            fc.name || '',
                  argsStr:         JSON.stringify(fc.args || {}),
                  thought_signature: fc.thoughtSignature || null  // captured from full response
                });
              }
            }
          }
        }
        recordTokenUsage(msgsTokens + toolsTokens);
      } catch (err) {
        apiErr = err.message || String(err);
      }
    } else {
      // Narration loop: use streaming streamGenerateContent for real-time feedback
      let apiRes;
      try {
        apiRes = await makeAPICall(body, 0, onWait);
      } catch (err) {
        apiErr = err.message || String(err);
      }

      if (!apiErr) {
        // ── Parse Gemini native SSE stream ────────────────────────────────────────
        // Each SSE event is a complete JSON object (not deltas like OpenAI).
        let streamErr = null;
        await new Promise(resolve => {
          let buf = '';
          apiRes.on('data', chunk => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') { resolve(); return; }
              try {
                const d = JSON.parse(data);
                if (d.error) {
                  streamErr = d.error.message || 'Gemini streaming error';
                  console.error('  ✗ Stream error:', streamErr);
                  continue;
                }
                if (d.usageMetadata) totalTokens += d.usageMetadata.candidatesTokenCount || 0;
                const candidate = d.candidates?.[0];
                if (!candidate) continue;
                if (candidate.finishReason) stopReason = candidate.finishReason;

                for (const part of (candidate.content?.parts || [])) {
                  if (part.thought) continue; // skip internal thinking tokens

                  if (part.text) {
                    textTurn += part.text;
                    if (!isCreation || opts.creationStep === 8) {
                      res.write(`data: ${JSON.stringify({ type: 'text', content: part.text })}\n\n`);
                    }
                  }
                }
              } catch {}
            }
          });
          apiRes.on('end', resolve);
          apiRes.on('error', e => { streamErr = e.message; resolve(); });
        });

        if (streamErr) {
          apiErr = streamErr;
        } else {
          recordTokenUsage(msgsTokens + toolsTokens);
        }
      }
    }

    console.log(`  ⟳ Loop ${loop}: text=${textTurn.length}c, tools=${toolCalls.length}${toolCalls.length ? ` [${toolCalls.map(t => t.name).join(',')}]` : ''}, stop=${stopReason}${apiErr ? `, apiErr=${apiErr}` : ''}`);
    if (apiErr) {
      // Retry without tools on function-call-related errors
      if ((apiErr.includes('Failed to call a function') || apiErr.includes('MALFORMED_FUNCTION_CALL') || apiErr.includes('thought_signature')) && funcCallFailures < 2) {
        funcCallFailures++;
        console.log(`  ↻ Function call failure — retrying without tools (attempt ${funcCallFailures})`);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      apiError = apiErr; break;
    }
    // Gemini MALFORMED_FUNCTION_CALL arrives as a stop reason (not an error):
    // model tried to call a function but mangled it, produced no text, no tool calls.
    // Treat it like a function-call failure and retry without tools.
    if (stopReason && stopReason.includes('MALFORMED_FUNCTION_CALL') && funcCallFailures < 2) {
      funcCallFailures++;
      console.log(`  ↻ MALFORMED_FUNCTION_CALL — retrying without tools (attempt ${funcCallFailures})`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    funcCallFailures = 0; // reset on successful stream

    // ── Add assistant turn to context ──────────────────────────────────────────
    // Now using native Gemini API we capture thoughtSignature from the stream and
    // replay it here. toGeminiRequest() injects it into the functionCall part so
    // Gemini 3 never sees a "missing thought_signature" error on loop 1+.
    if (toolCalls.length > 0) {
      contextMsgs.push({
        role: 'assistant',
        content: textTurn || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argsStr || '{}' },
          thought_signature: tc.thought_signature   // preserved for toGeminiRequest
        }))
      });
    } else {
      if (textTurn) contextMsgs.push({ role: 'assistant', content: textTurn });
    }
    if (textTurn) messages.push({ role: 'assistant', content: textTurn });

    // ── Creation mode: stream buffered step 8 text if not already streamed ──────
    if (isCreation && textTurn.trim() && opts.creationStep !== 8) {
      // Steps 1-7: text was suppressed above — only show if there's no tool call
      // (shouldn't happen if model follows instructions, but show as fallback)
      if (toolCalls.length === 0) {
        res.write(`data: ${JSON.stringify({ type: 'text', content: textTurn })}\n\n`);
      }
    }

    // Gemini returns finish_reason='stop' even when tool calls are present.
    // Use toolCalls.length as the authoritative signal — not stopReason.
    if (toolCalls.length === 0) {
      consecutiveToolLoops = 0; // narration produced — reset counter
      break;
    }

    // After 2 consecutive tool-call loops with no narration, force narration next iteration
    consecutiveToolLoops++;
    if (consecutiveToolLoops >= 2) {
      console.log(`  ⚠️  ${consecutiveToolLoops} consecutive tool loops — forcing narration next`);
      funcCallFailures = Math.max(funcCallFailures, 1);
    }

    // ── Execute tools, push native functionResponse messages ───────────────────
    // With the native Gemini API + thoughtSignature in context, Gemini 3 accepts
    // the full functionCall/functionResponse round-trip without errors.
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.argsStr || '{}'); } catch {}
      console.log(`    🔧 ${tc.name}`, JSON.stringify(input).slice(0, 80));
      let result;
      try { result = executeTool(tc.name, input); } catch (e) { result = { error: e.message }; }
      console.log(`    ✓`, JSON.stringify(result).slice(0, 120));

      if (result.state_updated) stateUpdated = true;
      if (result.dice_rolled)   res.write(`data: ${JSON.stringify({ type: 'dice_roll',      expression: result.rolled, purpose: result.purpose, breakdown: result.result, total: result.total })}\n\n`);
      if (result.combat_started)res.write(`data: ${JSON.stringify({ type: 'combat_started', enemies: result.enemies })}\n\n`);
      if (result.leveled)       res.write(`data: ${JSON.stringify({ type: 'level_up',       level: result.level })}\n\n`);

      // Native tool result — toGeminiRequest converts to functionResponse part
      contextMsgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: JSON.stringify(result) });

      if (result.direct_message) {
        const msg = result.direct_message;
        res.write(`data: ${JSON.stringify({ type: 'text', content: msg })}\n\n`);
        messages.push({ role: 'assistant', content: msg });
        if (stateUpdated || result.state_updated) {
          const ns = loadState();
          if (ns) {
            console.log(`  📡 Sending state_update SSE event (campaign_id=${ns.campaign_id})`);
            res.write(`data: ${JSON.stringify({ type: 'state_update', state: ns })}\n\n`);
          }
        }
        console.log(`  ✓ direct_message streamed (${msg.length} chars) — skipping model`);
        goto_end = true;
        break;
      }
    }

    if (goto_end) break;

    hasCalledToolsThisTurn = true; // tools ran — next loop gets narration-only (no tool schemas)

    // ── 1-call-per-turn optimisation ──────────────────────────────────────────
    // If the model already produced narration text alongside the tool calls AND
    // none of those tools involved dice (whose result must shape the narration),
    // we're done — skip the second API call entirely. This halves quota usage on
    // turns where the model narrates while it acts (state updates, NPC beats, etc.)
    const hadDiceRoll = toolCalls.some(tc => tc.name === 'roll_dice');
    if (textTurn.trim() && !hadDiceRoll) {
      console.log('  ⚡ Narration + tools in one pass — skipping narration loop');
      consecutiveToolLoops = 0;
      // Fast-exit skips the bottom-of-loop state_update send — do it here
      if (stateUpdated) {
        const ns = loadState();
        if (ns) res.write(`data: ${JSON.stringify({ type: 'state_update', state: ns })}\n\n`);
      }
      break;
    }

    if (stateUpdated) {
      const ns = loadState();
      if (ns) res.write(`data: ${JSON.stringify({ type: 'state_update', state: ns })}\n\n`);
    }
  }

  // ── Auto-chronicle: silently append this turn to chronicle.txt ───────────────
  // Gives the DM a persistent narrative memory of everything said this session.
  // No API call needed — pure server-side file write.
  if (!apiError && !isCreation) {
    try {
      const narration = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
      const playerMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
      if (narration && playerMsg) {
        const cPath = path.join(APP_DIR, 'chronicle.txt');
        const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const entry = `\n---\n[${ts}] ${playerMsg.slice(0, 120)}\n${narration.slice(0, 600)}\n`;
        fs.appendFileSync(cPath, entry, 'utf8');
      }
    } catch {}
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
  if(req.method==='POST'&&req.url==='/api/chat/summarize-and-clear'){
    let body='';req.on('data',c=>body+=c);
    req.on('end',async()=>{
      try{
        const history=loadHistory();
        const msgs=history.messages||[];
        let summary='';
        if(msgs.length>1){
          // Build a compact transcript (last 30 messages, alternating u/a)
          const transcript=msgs.slice(-30).map(m=>`${m.role==='user'?'Player':'DM'}: ${(m.content||'').slice(0,300)}`).join('\n');
          const sysPrompt=`You are a D&D campaign historian. The player just cleared the chat log. Summarize the narrative below into 4-6 bullet points (•) covering: what happened, key decisions made, important NPCs encountered, any clues or items found. Be specific and factual. This summary will be injected into the DM's context so the story can continue seamlessly. Max 350 words.`;
          console.log('  ↻ Summarizing chat history before clear...');
          summary=await makeSimpleAPICall(msgs.slice(-30).map(m=>({role:m.role,content:(m.content||'').slice(0,400)})),sysPrompt);
          // Append to world.story_notes
          const state=loadState();
          if(!state.world)state.world={};
          const existing=state.world.story_notes||'';
          const timestamp=new Date().toISOString().slice(0,10);
          const separator=existing?'\n\n':'';
          state.world.story_notes=(existing+separator+`[Summary from ${timestamp}]\n${summary}`).slice(-3000);
          state.history_log.push({timestamp:new Date().toISOString(),event:`Chat cleared. Summary saved to story_notes (${summary.length} chars).`});
          saveState(state);
          console.log(`  ✓ Summary saved to story_notes (${summary.length} chars)`);
        }
        saveHistory({messages:[],created_at:new Date().toISOString(),token_count:0,model:MODEL});
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:true,summary}));
      }catch(e){
        console.error('  ✗ summarize-and-clear error:',e.message);
        // Even if summarization fails, still clear
        saveHistory({messages:[],created_at:new Date().toISOString(),token_count:0,model:MODEL});
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:true,summary:'',error:e.message}));
      }
    });
    return;
  }
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
        // Mistral free tier: 40K TPM — we can afford a generous history window.
        // Keep enough context for the model to know what just happened (avoids repetition loops).
        const HISTORY_TOKEN_BUDGET = 6000;
        const HARD_MAX_MESSAGES    = 40;
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
        // Ensure messages alternate user/assistant — drop a leading assistant if the window starts on one
        while (messagesForAPI.length > 1 && messagesForAPI[0]?.role === 'assistant') messagesForAPI = messagesForAPI.slice(1);
        // Inject the last DM response so the model cannot regenerate the same text
        const lastDMMsg = [...history.messages].reverse().find(m => m.role === 'assistant' && m.content && !m.content.startsWith('⚠️'));
        const lastDMSnippet = lastDMMsg ? lastDMMsg.content.slice(0, 500) : null;
        const currentState=loadState();
        // RAG: only during active campaigns — stat blocks are useless during creation
        const ragCtx = (currentState && currentState.campaign_id !== 'new-campaign')
          ? buildRagContext(prompt, lastDMSnippet || '', currentState) : '';
        if (ragCtx) console.log(`  📖 RAG: injected data (${ragCtx.length} chars)`);
        const systemPrompt = buildSystemPrompt(currentState) + ragCtx + (lastDMSnippet
          ? `\n\n⚠️ YOUR PREVIOUS RESPONSE (DO NOT REPEAT OR PARAPHRASE THIS — write something completely new):\n"${lastDMSnippet}${lastDMMsg.content.length > 500 ? '…' : ''}"`
          : '');
        console.log(`\n  ━━━ Chat request — history=${history.messages.length} msgs (sending last ${messagesForAPI.length}, ~${runningTokens} tokens) ━━━`);
        const msgStartIdx=messagesForAPI.length;
        const isCreation=currentState.campaign_id==='new-campaign';
        const creationStep=currentState.creation_step||1;

        // Step 1 is server-sent like all other creation steps — model only handles the response.
        // If we're at step 1 and no assistant has spoken yet, send the adventure-type question directly.
        const noAssistantYet = !messagesForAPI.some(m => m.role === 'assistant');
        if (isCreation && creationStep === 1 && noAssistantYet) {
          const step1Msg = `Welcome, adventurer. Before we begin — what kind of world do you want to enter?\n\n1. **Classic High Fantasy** — Ancient kingdoms, dragon-haunted mountains, magic woven into the fabric of reality.\n2. **Dark Gothic** — Crumbling castles, cursed bloodlines, horrors that wear human faces.\n3. **Seafaring** — Uncharted oceans, buried treasure, storms that swallow ships whole.\n4. **Political Intrigue** — Courts of power, poisoned alliances, secrets that topple dynasties.\n\nWhich calls to you?`;
          res.write(`data: ${JSON.stringify({ type: 'text', content: step1Msg })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          messagesForAPI.push({ role: 'assistant', content: step1Msg });
          history.messages.push({ role: 'user', content: prompt });
          history.messages.push({ role: 'assistant', content: step1Msg });
          saveHistory(history);
          res.end();
          return;
        }

        const r1=await streamAgenticLoop(messagesForAPI,systemPrompt,res,{isCreation,creationStep});
        let outTokens=r1.totalTokens, apiError=r1.apiError;
        const collectFinalText=()=>{let t='';for(let i=msgStartIdx;i<messagesForAPI.length;i++){const m=messagesForAPI[i];if(m.role==='assistant'){if(Array.isArray(m.content))t+=m.content.filter(b=>b.type==='text').map(b=>b.text).join('');else if(typeof m.content==='string')t+=m.content;}}return t;};
        let finalText=collectFinalText();
        // Emergency fallback: tools ran successfully but no narration produced (and no API error).
        // Skip fallback on API errors — retrying will just hit the same error.
        // Skip in creation mode — direct_message handles the response there.
        if(!isCreation&&!apiError&&!finalText.trim()&&messagesForAPI.length>msgStartIdx+1){
          console.warn('  ⚠️  No narration after tools — forcing follow-up narration call');
          messagesForAPI.push({role:'user',content:'You called tools but wrote no narration. Write your DM response now — describe what happens in the scene.'});
          const r2=await streamAgenticLoop(messagesForAPI,systemPrompt,res,{isCreation,creationStep});
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
          // Only accept proper save files that have meta.character — raw state dumps don't
          if (!raw.meta || !raw.meta.character) return null;
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
    console.log('  GEMINI_API_KEY=your-gemini-key-here');
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
