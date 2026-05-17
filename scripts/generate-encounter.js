#!/usr/bin/env node
'use strict';

/**
 * generate-encounter.js — D&D 5e Encounter Generator
 * Fetches monster data from the Open5e API and builds a balanced
 * encounter within the XP budget for the given party.
 *
 * Usage:
 *   node scripts/generate-encounter.js [options]
 *
 * Options:
 *   --level <n>           Character level (default: 3)
 *   --party <n>           Number of players (default: 1)
 *   --difficulty <str>    easy | medium | hard | deadly (default: medium)
 *   --theme <str>         Monster search keywords (default: "bandit")
 *   --help                Show this help
 *
 * Examples:
 *   node scripts/generate-encounter.js --theme "undead thrall" --difficulty hard
 *   node scripts/generate-encounter.js --theme "bandit redbrand" --difficulty medium
 *   node scripts/generate-encounter.js --theme "goblin" --difficulty easy
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CR → XP TABLE (DMG p.274) ─────────────────────────────────────────────────
const CR_XP = {
  '0':    10,  '1/8':  25,  '1/4':  50,  '1/2': 100,
  '1':   200,  '2':   450,  '3':   700,  '4':  1100,
  '5':  1800,  '6':  2300,  '7':  2900,  '8':  3900,
  '9':  5000,  '10': 5900,  '11': 7200,  '12': 8400,
  '13': 10000, '14': 11500, '15': 13000, '16': 15000,
};

// ── XP THRESHOLDS per character, per level (DMG p.82) ────────────────────────
const THRESHOLDS = {
  1:  { easy:  25, medium:   50, hard:   75, deadly:  100 },
  2:  { easy:  50, medium:  100, hard:  150, deadly:  200 },
  3:  { easy:  75, medium:  150, hard:  225, deadly:  400 },
  4:  { easy: 125, medium:  250, hard:  375, deadly:  500 },
  5:  { easy: 250, medium:  500, hard:  750, deadly: 1100 },
  6:  { easy: 300, medium:  600, hard:  900, deadly: 1400 },
  7:  { easy: 350, medium:  750, hard: 1100, deadly: 1700 },
  8:  { easy: 450, medium:  900, hard: 1400, deadly: 2100 },
};

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function crToFloat(cr) {
  if (cr === null || cr === undefined) return 0;
  const s = String(cr).trim();
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    return n / d;
  }
  return parseFloat(s) || 0;
}

function xpForCr(cr) {
  const key = String(cr).trim();
  if (CR_XP[key] !== undefined) return CR_XP[key];
  // Fallback: round up to nearest key
  const f = crToFloat(cr);
  const entries = Object.entries(CR_XP)
    .map(([k, v]) => [crToFloat(k), v])
    .sort((a, b) => a[0] - b[0]);
  for (const [cf, xp] of entries) if (cf >= f) return xp;
  return 0;
}

/**
 * Encounter multiplier by monster count (DMG p.82).
 * For solo / small parties (≤ 2), bump one tier.
 */
function encounterMultiplier(monsterCount, partySize) {
  const tiers = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0];
  let idx;
  if      (monsterCount === 1)  idx = 0;
  else if (monsterCount === 2)  idx = 1;
  else if (monsterCount <= 6)   idx = 2;
  else if (monsterCount <= 10)  idx = 3;
  else if (monsterCount <= 15)  idx = 4;
  else                           idx = 5;
  if (partySize <= 2) idx = Math.min(idx + 1, tiers.length - 1);
  return tiers[idx];
}

function parseArgs(argv) {
  const args = { level: 3, party: 1, difficulty: 'medium', theme: 'bandit' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--help')       { printHelp(); process.exit(0); }
    if (argv[i] === '--level')      { args.level      = parseInt(argv[++i], 10); }
    if (argv[i] === '--party')      { args.party      = parseInt(argv[++i], 10); }
    if (argv[i] === '--difficulty') { args.difficulty = argv[++i]; }
    if (argv[i] === '--theme')      { args.theme      = argv[++i]; }
  }
  if (!['easy', 'medium', 'hard', 'deadly'].includes(args.difficulty)) {
    console.error(`❌  Unknown difficulty "${args.difficulty}". Use: easy | medium | hard | deadly`);
    process.exit(1);
  }
  return args;
}

function printHelp() {
  console.log(`
  generate-encounter.js — D&D 5e Encounter Generator

  Options:
    --level <n>           Character level (default: 3)
    --party <n>           Number of players (default: 1)
    --difficulty <str>    easy | medium | hard | deadly  (default: medium)
    --theme <str>         Monster search keywords        (default: "bandit")
    --help                Show this help

  Examples:
    node scripts/generate-encounter.js --theme "undead thrall"     --difficulty hard
    node scripts/generate-encounter.js --theme "bandit redbrand"   --difficulty medium
    node scripts/generate-encounter.js --theme "goblin"            --difficulty easy
    node scripts/generate-encounter.js --theme "mind flayer psionic" --difficulty deadly
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP / OPEN5E
// ─────────────────────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'dnd-encounter-gen/1.0' } }, res => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(httpGet(res.headers.location));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

/**
 * Search Open5e for monsters matching a keyword string.
 * Returns all results with CR ≤ crMax, deduped by slug.
 */
async function searchOpen5e(theme, crMax) {
  const keywords = theme.trim().split(/\s+/);
  // Try full phrase first, then individual keywords for broader coverage
  const queries = [theme, ...keywords.slice(0, 2)];
  const seen    = new Set();
  const results = [];

  for (const q of queries) {
    const url = `https://api.open5e.com/v1/monsters/?search=${encodeURIComponent(q)}&limit=50`;
    try {
      const data = await httpGet(url);
      for (const m of (data.results || [])) {
        if (!seen.has(m.slug)) {
          seen.add(m.slug);
          if (crToFloat(m.cr) <= crMax) results.push(m);
        }
      }
    } catch (err) {
      console.warn(`  ⚠  Search "${q}" failed: ${err.message}`);
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENCOUNTER SELECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the highest-adjusted-XP grouping that still fits within budget.
 * Tries 1–8 copies of each candidate.
 */
function selectBestEncounter(candidates, budget, partySize) {
  let best         = null;
  let bestAdjusted = 0;

  for (const monster of candidates) {
    const xpEach = xpForCr(monster.cr);
    if (!xpEach) continue;

    for (let count = 1; count <= 8; count++) {
      const rawXP  = xpEach * count;
      const mult   = encounterMultiplier(count, partySize);
      const adjXP  = rawXP * mult;

      if (adjXP <= budget && adjXP > bestAdjusted) {
        bestAdjusted = adjXP;
        best = { monster, count, xpEach, rawXP, adjXP, mult };
      }
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISPLAY
// ─────────────────────────────────────────────────────────────────────────────

function statMod(score) {
  const m = Math.floor((score - 10) / 2);
  return (m >= 0 ? '+' : '') + m;
}

/** Format Open5e speed object ({walk:30, fly:60}) or plain string */
function formatSpeed(speed) {
  if (!speed) return '—';
  if (typeof speed === 'string') return speed;
  if (typeof speed === 'object') {
    return Object.entries(speed)
      .map(([k, v]) => k === 'walk' ? `${v} ft.` : `${k} ${v} ft.`)
      .join(', ');
  }
  return String(speed);
}

function printEncounter(enc, budget) {
  const { monster: m, count, xpEach, adjXP, mult } = enc;
  const pct   = Math.round(adjXP / budget * 100);
  const label = count === 1 ? m.name : `${count}× ${m.name}`;
  const line  = '─'.repeat(64);

  console.log(`\n${line}`);
  console.log(`⚔️   ENCOUNTER: ${label}`);
  console.log(line);
  console.log(`  CR ${m.cr}  ·  ${xpEach} XP each  ·  ×${mult} multiplier  →  ${adjXP} adj. XP`);
  console.log(`  Budget: ${adjXP} / ${budget} XP  (${pct}%)`);
  console.log('');
  console.log(`  HP ${m.hit_points}   AC ${m.armor_class}   Speed: ${formatSpeed(m.speed)}`);

  // Ability scores
  const stats = ['STR','DEX','CON','INT','WIS','CHA'];
  const vals  = [m.strength, m.dexterity, m.constitution, m.intelligence, m.wisdom, m.charisma];
  const row   = stats.map((s, i) => `${s} ${String(vals[i]).padStart(2)} (${statMod(vals[i])})`).join('  ');
  console.log(`  ${row}`);

  if (m.special_abilities?.length) {
    console.log('\n  ✨ Traits:');
    m.special_abilities.slice(0, 4).forEach(a => {
      const desc = a.desc.length > 110 ? a.desc.slice(0, 107) + '…' : a.desc;
      console.log(`     • ${a.name}: ${desc}`);
    });
  }

  if (m.actions?.length) {
    console.log('\n  ⚔️  Actions:');
    m.actions.forEach(a => {
      const desc = a.desc.length > 120 ? a.desc.slice(0, 117) + '…' : a.desc;
      console.log(`     • ${a.name}: ${desc}`);
    });
  }

  if (count > 1) {
    console.log('');
    console.log(`  📋 DM Notes: ${count} ${m.name}s — spread across the encounter space.`);
    console.log(`     Total HP pool: ${m.hit_points * count}`);
    console.log(`     Focus fire: they will coordinate on the nearest threat.`);
  }

  console.log(`${line}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  OUTPUT / DIFF
// ─────────────────────────────────────────────────────────────────────────────

function buildDiff(enc, args, budget) {
  const { monster: m, count, xpEach, adjXP, mult } = enc;
  const encId = `enc_${Date.now()}`;

  return {
    op:          'add',
    entity_type: 'encounter',
    entity_id:   encId,
    data: {
      id:              encId,
      session:         'session_007',
      theme:           args.theme,
      difficulty:      args.difficulty,
      party_level:     args.level,
      party_size:      args.party,
      budget_xp:       budget,
      adjusted_xp:     adjXP,
      budget_use_pct:  Math.round(adjXP / budget * 100),
      multiplier:      mult,
      groups: [
        {
          count,
          xp_each: xpEach,
          monster: {
            name:              m.name,
            slug:              m.slug,
            cr:                m.cr,
            xp:                m.xp || xpEach,
            hp:                m.hit_points,
            ac:                m.armor_class,
            speed:             formatSpeed(m.speed),
            str:               m.strength,
            dex:               m.dexterity,
            con:               m.constitution,
            int:               m.intelligence,
            wis:               m.wisdom,
            cha:               m.charisma,
            actions:           (m.actions || []).map(a => ({ name: a.name, desc: a.desc })),
            special_abilities: (m.special_abilities || []).slice(0, 5).map(a => ({ name: a.name, desc: a.desc })),
            source:            m.document__slug || 'unknown',
          },
        },
      ],
      generated_at: new Date().toISOString(),
    },
    reason:     `Generated ${args.difficulty} encounter (${Math.round(adjXP / budget * 100)}% budget) — theme: "${args.theme}"`,
    confidence: 0.9,
  };
}

function saveOutput(diff, args) {
  const root    = path.resolve(__dirname, '..');
  const outDir  = path.join(root, 'campaigns', 'lost-mine', 'diffs');
  fs.mkdirSync(outDir, { recursive: true });

  // Overwrite latest (for quick re-use)
  const latestPath = path.join(outDir, 'encounter_latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(diff, null, 2), 'utf8');

  // Timestamped archive
  const ts          = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivePath = path.join(outDir, `encounter_${ts}_${args.difficulty}.json`);
  fs.writeFileSync(archivePath, JSON.stringify(diff, null, 2), 'utf8');

  console.log(`💾 encounter_latest.json → ${latestPath}`);
  console.log(`💾 archive               → ${archivePath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args   = parseArgs(process.argv);
  const thresh = (THRESHOLDS[args.level] || THRESHOLDS[3]);
  const budget = thresh[args.difficulty] * args.party;
  // CR ceiling: roughly budget/200 with a small buffer, capped at reasonable max
  const crMax  = Math.min(Math.max(1, Math.ceil(budget / 150)), 12);

  console.log('\n⚔️   D&D 5e Encounter Generator');
  console.log(`    Level ${args.level} · Party of ${args.party} · ${args.difficulty.toUpperCase()}`);
  console.log(`    Budget: ${budget} XP  ·  CR ceiling: ${crMax}`);
  console.log(`    Theme: "${args.theme}"\n`);

  console.log(`🔍 Querying Open5e for "${args.theme}"…`);
  const candidates = await searchOpen5e(args.theme, crMax);

  if (candidates.length === 0) {
    console.log('⚠️   No monsters found within CR ceiling.');
    console.log('    Try a broader keyword (e.g., "humanoid", "undead", "beast", "goblin").');
    process.exit(0);
  }

  // Sort by CR desc for display
  const sorted = [...candidates].sort((a, b) => crToFloat(b.cr) - crToFloat(a.cr));
  console.log(`    ${candidates.length} candidates found\n`);
  console.log('📋 Candidates (top 10 by CR):');
  sorted.slice(0, 10).forEach(m => {
    const xp = xpForCr(m.cr);
    console.log(
      `    • ${m.name.padEnd(34)} CR ${String(m.cr).padEnd(5)} ${String(xp).padStart(5)} XP` +
      `   HP:${String(m.hit_points).padStart(3)}  AC:${m.armor_class}`
    );
  });

  const enc = selectBestEncounter(candidates, budget, args.party);

  if (!enc) {
    console.log('\n⚠️   Could not fit any monster group within the XP budget.');
    console.log('    Options: use --difficulty deadly, raise --level, or pick a different theme.');
    process.exit(0);
  }

  printEncounter(enc, budget);

  const diff = buildDiff(enc, args, budget);
  saveOutput(diff, args);

  console.log('\nNext steps:');
  console.log('  • Run the encounter, then update campaign state:');
  console.log('      node scripts/rebuild-memory.js apply-diffs');
  console.log('  • Or generate another option:');
  console.log(`      node scripts/generate-encounter.js --theme "${args.theme}" --difficulty ${args.difficulty}\n`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
