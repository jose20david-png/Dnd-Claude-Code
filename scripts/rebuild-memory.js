#!/usr/bin/env node
'use strict';

/**
 * rebuild-memory.js
 * Rurik Stormhammer Campaign — Persistent DM Memory Compiler
 *
 * Reads: ../Campaign Context full.md
 * Writes: ../campaigns/lost-mine/
 *   campaign_state.json       (canonical full state)
 *   npcs/<id>.json            (one file per NPC)
 *   quests/<id>.json          (one file per quest)
 *   locations/<id>.json       (one file per location)
 *   diffs/session_NNN.json    (empty diff scaffold for this session)
 *
 * Usage: node scripts/rebuild-memory.js
 */

const fs   = require('fs');
const path = require('path');

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT         = path.join(__dirname, '..');
const CONTEXT_FILE = path.join(ROOT, 'Campaign Context full.md');
const OUT_ROOT     = path.join(ROOT, 'campaigns', 'lost-mine');
const DIFF_DIR     = path.join(OUT_ROOT, 'diffs');

// ── Helpers ──────────────────────────────────────────────────────────────────
const ensureDir = d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };
const write     = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');
const now       = () => new Date().toISOString();
const pad       = (n, w=3) => String(n).padStart(w, '0');

// ── Section parser ───────────────────────────────────────────────────────────
function parseSections(md) {
  const out = {};
  const parts = md.split(/^## /m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const lines   = part.split('\n');
    const heading = lines[0].trim().toLowerCase();
    out[heading]  = lines.slice(1).join('\n').trim();
  }
  return out;
}

// ── Extract session state ────────────────────────────────────────────────────
function extractSessionState(sections) {
  const raw    = Object.entries(sections).find(([k]) => k.includes('session'))?.[1] ?? '';
  const dayM   = raw.match(/Day\s+(\d+)/i);
  const hpM    = raw.match(/(\d+)\s*\/\s*(\d+)/);
  const timeM  = raw.match(/\|\s*(\w+)\s*\|$/, 'm') || raw.match(/morning|evening|night|afternoon/i);

  return {
    current_session : 7,
    in_world_day    : dayM  ? parseInt(dayM[1])  : 7,
    time_of_day     : 'Morning',
    last_updated    : now(),
    location        : "Old Marta's Cabin, Phandalin outskirts",
    pending_decision: true,
    party_resources : {
      hp          : hpM ? `${hpM[1]}/${hpM[2]}` : '27/27',
      spell_slots : { level_1: { used: 0, max: 4 }, level_2: { used: 0, max: 2 } },
      channel_divinity: { used: 0, max: 1 },
    },
  };
}

// ── Extract world state ──────────────────────────────────────────────────────
function extractWorldState(sections) {
  return {
    summary : 'The binding ritual is complete. The Witness is contained beneath Wave Echo Cave. Phandalin remains under Redbrand control. The Mind Flayer is at large. Harpers arrive in ~2 days.',
    tone    : 'dark fantasy, high stakes, survival horror',
    themes  : ['burden of power', 'imprisonment and freedom', 'corruption and redemption', 'community vs. evil'],
    flags   : {
      witness_contained         : true,
      seal_integrity_pct        : 100,
      breeding_chamber_destroyed: true,
      phandalin_occupied        : true,
      harpers_inbound           : true,
      harpers_eta_days          : 2,
      mind_flayer_at_large      : true,
      artifacts_secured         : true,
    },
  };
}

// ── NPC registry ─────────────────────────────────────────────────────────────
// Hardcoded because the campaign context is too rich for pure regex.
// Update this block after major narrative events.
function buildNPCRegistry() {
  return [
    // ── Player Character ──
    {
      id: 'npc_rurik', name: 'Rurik Stormhammer',
      role: 'Player Character — Bearer of the Seal',
      faction: 'Independent / Church of Talos',
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'player',
      traits: ['stubborn', 'devout (Talos)', 'protective', 'storm-touched', 'permanent seal bond'],
      goals: ['protect Phandalin civilians', 'hunt the Mind Flayer', 'honor the Seal bond'],
      secrets: ['Feels the Witness as a second heartbeat — permanent, unfading'],
      relationships: [
        { target_id: 'npc_garaele',     type: 'ally',   notes: 'Confirmed him as Bearer of the Seal' },
        { target_id: 'npc_sildar',      type: 'ally',   notes: 'Trusted combat partner' },
        { target_id: 'npc_gundren',     type: 'ally',   notes: 'Shared ritual burden' },
        { target_id: 'npc_the_witness', type: 'bound',  notes: 'Permanent ritual anchor bond' },
      ],
      inventory_notes: ['Warhammer +4/1d8+2', 'Chain Mail AC16', 'Storm-cloud Shield', 'Holy Symbol of Talos', 'Guild Papers'],
      session_state: { injured: false, combat_ready: true, hp: '27/27', spell_slots_full: true },
    },

    // ── Allies ──
    {
      id: 'npc_garaele', name: 'Sister Garaele',
      role: 'Shrine Keeper · Harper Agent · Ritual Voice #1',
      faction: 'Harpers / Church of Selûne',
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'ally',
      traits: ['devout', 'exhausted but joyful', 'brave', 'harper operative'],
      goals: ['see Phandalin freed', 'protect the seal', 'recover her staff'],
      secrets: ['Harper field operative with deeper network than she reveals'],
      relationships: [{ target_id: 'npc_rurik', type: 'ally', notes: 'Wept when the seal closed. Fully trusts him.' }],
      session_state: { injured: false, combat_ready: false, staff_spent: true, staff_recharging: true },
    },
    {
      id: 'npc_sildar', name: 'Sildar Hallwinter',
      role: 'Retired Soldier · Lord\'s Alliance · Ritual Voice #2',
      faction: "Lord's Alliance",
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'ally',
      traits: ['tactical', 'experienced', 'cautious', 'intel-focused'],
      goals: ['liberate Phandalin', 'gather Silga intel before action', 'protect civilians'],
      secrets: [],
      relationships: [
        { target_id: 'npc_rurik', type: 'ally', notes: 'Combat partner, trusts his judgment' },
        { target_id: 'npc_silga', type: 'enemy', notes: 'Wants intel before confrontation' },
      ],
      knowledge: ['Redbrand command structure', 'Patrol patterns via Qelline briefing'],
      session_state: { injured: false, combat_ready: true },
      known_preference: 'Wants Silga intel before committing to any escape route',
    },
    {
      id: 'npc_gundren', name: 'Gundren Rockseeker',
      role: 'Dwarf Merchant · Wave Echo Cave Claimant · Ritual Voice #3',
      faction: 'Independent',
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'ally',
      traits: ['determined', 'shaken but steady', 'proud mine claimant'],
      goals: ['reclaim Wave Echo Cave', 'see Phandalin safe'],
      secrets: ['Mining claim gives legal right to the cave — politically complex post-ritual'],
      relationships: [{ target_id: 'npc_rurik', type: 'ally', notes: 'His mine, his responsibility. Volunteered.' }],
      session_state: { injured: false, combat_ready: true },
    },
    {
      id: 'npc_toblen', name: 'Toblen Stonehill',
      role: "Innkeeper · Ritual Voice #4",
      faction: 'Phandalin Civilians',
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'ally',
      traits: ['protective of community', 'stubborn', 'wants to fight'],
      goals: ['liberate Phandalin', 'protect his inn and neighbors'],
      secrets: [],
      relationships: [],
      session_state: { injured: false, combat_ready: true },
      known_preference: 'Strongly favors holding at cabin and waiting for Harpers',
    },
    {
      id: 'npc_borik', name: 'Borik Stonehammer',
      role: 'Dwarf Local · Perimeter Guard',
      faction: 'Phandalin Civilians',
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'ally',
      traits: ['reliable', 'unshakeable', 'on watch'],
      goals: ['protect the group', 'hold the perimeter'],
      secrets: [],
      relationships: [],
      session_state: { injured: false, combat_ready: true, on_watch: true },
    },
    {
      id: 'npc_qelline', name: 'Qelline',
      role: 'Intelligence Operative · Halfling',
      faction: 'Independent',
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'ally',
      traits: ['observant', 'detail-oriented', 'quick-thinking'],
      goals: ['provide actionable intel for escape or liberation'],
      secrets: [],
      relationships: [],
      knowledge: [
        'Detailed Redbrand patrol patterns',
        'South Road patrol gap: 3–5am window',
        'Outrider positions on Triboar Trail',
        'Forest path NE terrain — partial knowledge',
      ],
      session_state: { injured: false, combat_ready: false, intel_ready: true },
    },
    {
      id: 'npc_marta', name: 'Old Marta',
      role: '40-Year Seal Guardian · Host',
      faction: 'Independent',
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'ally',
      traits: ['ancient wisdom', 'steady under pressure', 'seal historian'],
      goals: ['support the party', 'advise on seal implications'],
      secrets: ['Journals hold 40 years of seal degradation records — invaluable lore'],
      relationships: [{ target_id: 'npc_rurik', type: 'ally', notes: 'Warned him: some anchors broke, some endured' }],
      session_state: { injured: false, combat_ready: false },
    },
    {
      id: 'npc_elmar', name: 'Elmar Barthen',
      role: "Merchant · Barthen's Provisions",
      faction: 'Phandalin Civilians',
      status: 'alive', location_id: 'loc_phandalin', disposition: 'ally',
      traits: ['cooperative', 'well-supplied', 'knows trade roads south'],
      goals: ['survive Redbrand occupation', 'resume normal trade'],
      secrets: [],
      relationships: [],
      session_state: { under_occupation: true },
    },

    // ── Uncertain ──
    {
      id: 'npc_iarno', name: 'Iarno Albrek',
      role: "Former Glasstaff · Ritual Voice #5 · Cipher Expert",
      faction: 'Recovering / Formerly Redbrands',
      status: 'alive', location_id: 'loc_marta_cabin', disposition: 'uncertain',
      traits: ['intelligent', 'haunted by past', 'earnest in recovery', 'tactically sharp'],
      goals: ['atone for Redbrand service', 'use inside knowledge to help', 'fully recover'],
      secrets: [
        'Former Redbrand leadership — knows their internal structure intimately',
        "Knows Silga's patrol patterns and blind spots — critical intelligence asset",
      ],
      relationships: [
        { target_id: 'npc_silga',  type: 'rival',   notes: 'Former colleague — knows her vulnerabilities' },
        { target_id: 'npc_rurik',  type: 'neutral', notes: 'Volunteered for ritual, earning trust slowly' },
      ],
      session_state: { injured: false, recovering: true, combat_ready: false, intel_available: true },
    },
    {
      id: 'npc_harbin', name: 'Harbin Wester',
      role: 'Townmaster of Phandalin',
      faction: 'Phandalin Civilians',
      status: 'alive', location_id: 'loc_phandalin', disposition: 'neutral',
      traits: ['cowardly', 'self-preserving', 'follows power'],
      goals: ['survive', 'maintain position under whoever holds power'],
      secrets: [],
      relationships: [],
      session_state: { under_occupation: true, compliant_with_redbrands: true },
    },

    // ── Threats ──
    {
      id: 'npc_silga', name: 'Silga',
      role: 'Redbrand Field Commander',
      faction: 'Redbrands',
      status: 'alive', location_id: 'loc_phandalin', disposition: 'hostile',
      traits: ['tactical', 'brutal', 'motivated', 'half-elf', 'relentless'],
      goals: [
        'Capture or eliminate Rurik and the party',
        'Maintain Redbrand control of Phandalin',
        'Recover the stolen ritual artifacts',
      ],
      secrets: ["Blind spots and patrol schedules known to Iarno"],
      relationships: [
        { target_id: 'npc_rurik', type: 'enemy', notes: 'Personally led shrine raid, knows party escaped' },
        { target_id: 'npc_iarno', type: 'rival', notes: 'Former colleague — betrayal factor' },
      ],
      session_state: { controlling_phandalin: true, has_outriders: true, actively_hunting: true, force_size: '8-12 Redbrands' },
      threat_level: 'high',
    },
    {
      id: 'npc_mind_flayer', name: 'The Mind Flayer',
      role: 'Illithid · Former Witness Servant',
      faction: 'Independent (severed from Witness)',
      status: 'alive', location_id: 'loc_unknown', disposition: 'hostile',
      traits: ['ancient', 'cunning', 'severed from master', 'rebuilding'],
      goals: ['escape and regroup', 'rebuild influence without Witness power', 'survive'],
      secrets: ['Knows Rurik is the Seal anchor — could become a targeted threat'],
      relationships: [{ target_id: 'npc_the_witness', type: 'severed', notes: 'Cut off after sealing ritual' }],
      session_state: { location_unknown: true, thralls_weakening: true, breeding_army_destroyed: true },
      threat_level: 'critical',
    },
    {
      id: 'npc_the_witness', name: 'The Witness',
      role: 'Ancient Imprisoned Entity',
      faction: 'None — primordial',
      status: 'contained', location_id: 'loc_seal_chamber', disposition: 'contained',
      traits: ['vast', 'aware', 'hungry', 'patient', 'unknowable'],
      goals: ['freedom', 'consumption of knowledge and minds'],
      secrets: ['Still fully aware despite containment — watches Rurik constantly through the seal bond'],
      relationships: [{ target_id: 'npc_rurik', type: 'bound', notes: 'Rurik is the eternal anchor — permanent bond, both ways' }],
      session_state: { contained: true, seal_integrity_pct: 100, stable_years: true },
      threat_level: 'existential (contained)',
    },
  ];
}

// ── Location registry ─────────────────────────────────────────────────────────
function buildLocationRegistry() {
  return [
    {
      id: 'loc_marta_cabin', name: "Old Marta's Cabin",
      type: 'building',
      description: 'Isolated cabin on the outskirts of Phandalin. Current party base of operations. Hosted the full party since Day 4.',
      importance: 'critical',
      connected_locations: ['loc_phandalin', 'loc_south_road', 'loc_forest_path_ne'],
      notable_npcs: ['npc_marta', 'npc_rurik', 'npc_garaele', 'npc_sildar', 'npc_gundren', 'npc_iarno', 'npc_toblen', 'npc_borik', 'npc_qelline'],
      status: 'safe — not yet discovered by Redbrands',
    },
    {
      id: 'loc_phandalin', name: 'Phandalin',
      type: 'town',
      description: 'Frontier mining town under Redbrand occupation. Silga commands 8–12 Redbrands. Three families extorted this week.',
      importance: 'critical',
      connected_locations: ['loc_marta_cabin', 'loc_wave_echo_cave', 'loc_south_road', 'loc_shrine_of_luck'],
      notable_npcs: ['npc_silga', 'npc_harbin', 'npc_elmar'],
      controlled_by: 'Redbrands',
      threat_level: 'high',
    },
    {
      id: 'loc_wave_echo_cave', name: 'Wave Echo Cave',
      type: 'dungeon',
      description: 'Ancient mine beneath the Sword Mountains. Contains the Seal Chamber. The binding ritual was performed here on Day 6.',
      importance: 'critical',
      connected_locations: ['loc_phandalin', 'loc_seal_chamber'],
      notable_npcs: ['npc_the_witness'],
      lore: 'Gundren Rockseeker holds the mining claim. 400-year-old imprisonment site of the Witness.',
    },
    {
      id: 'loc_seal_chamber', name: 'Seal Chamber',
      type: 'dungeon',
      description: 'Deep within Wave Echo Cave. Obsidian floor seal, now whole and glowing steady green. The Witness is imprisoned here. Rurik feels it as a second heartbeat.',
      importance: 'critical',
      connected_locations: ['loc_wave_echo_cave'],
      notable_npcs: ['npc_the_witness'],
      seal_integrity_pct: 100,
      seal_status: 'stable — years or decades',
    },
    {
      id: 'loc_shrine_of_luck', name: 'Shrine of Luck',
      type: 'building',
      description: "Shrine of Tymora in Phandalin. Blessed catacombs currently hold the five ritual artifacts. Sister Garaele's home base.",
      importance: 'high',
      connected_locations: ['loc_phandalin'],
      notable_npcs: ['npc_garaele'],
      status: 'artifacts secured in blessed catacombs',
    },
    {
      id: 'loc_south_road', name: 'South Road — Triboar Trail',
      type: 'wilderness',
      description: 'Main route south toward Baldur\'s Gate. Redbrand outriders patrol. Patrol gap identified: 3–5am.',
      importance: 'medium',
      connected_locations: ['loc_phandalin', 'loc_marta_cabin'],
      threat_level: 'medium',
      intel: 'Patrol gap 3–5am. Outriders present outside that window.',
    },
    {
      id: 'loc_forest_path_ne', name: 'Forest Path NE',
      type: 'wilderness',
      description: 'Rough forest path toward Conyberry. Weakening thralls may linger. Less monitored by Redbrands.',
      importance: 'medium',
      connected_locations: ['loc_marta_cabin'],
      threat_level: 'low-medium',
      intel: 'Weakening thralls possibly present. Rougher terrain. Qelline has partial knowledge.',
    },
  ];
}

// ── Quest registry ────────────────────────────────────────────────────────────
function buildQuestRegistry() {
  return [
    {
      id: 'quest_escape_route',
      name: 'Escape Route Decision',
      status: 'active', priority: 'immediate',
      summary: 'The party must decide how to move civilians safely from Marta\'s cabin. Three options on the table.',
      objectives: [
        { text: 'Choose escape route: South Road, Forest Path NE, or Hold for Harpers', done: false },
        { text: 'Brief civilians on the chosen plan', done: false },
        { text: 'Execute the move safely', done: false },
      ],
      current_stage: 'Decision pending — Rurik has not yet chosen.',
      related_npcs: ['npc_rurik', 'npc_sildar', 'npc_qelline', 'npc_iarno', 'npc_toblen'],
      related_locations: ['loc_marta_cabin', 'loc_south_road', 'loc_forest_path_ne'],
      rewards: ['Civilian safety', 'Harpers coordination opportunity'],
      options: {
        south_road    : { risk: 'medium',     intel: 'Patrol gap 3–5am, outriders outside window' },
        forest_path_ne: { risk: 'low-medium', intel: 'Weakening thralls may linger, rougher terrain' },
        hold_for_harpers: { risk: 'hold in place ~2 days', intel: 'Harpers arrive Day 9 with armed support' },
      },
    },
    {
      id: 'quest_hunt_mind_flayer',
      name: 'Hunt the Mind Flayer',
      status: 'active', priority: 'critical',
      summary: 'The Mind Flayer is at large after the sealing ritual. Breeding army destroyed. Must be hunted before it rebuilds.',
      objectives: [
        { text: 'Discover the breeding chamber',                   done: true  },
        { text: 'Destroy the breeding chamber (Shatter + collapse)', done: true  },
        { text: 'Locate the Mind Flayer',                          done: false },
        { text: 'Eliminate or drive off the Mind Flayer',          done: false },
      ],
      current_stage: 'Breeding army destroyed (Day 6). Location unknown.',
      related_npcs: ['npc_mind_flayer'],
      related_locations: ['loc_wave_echo_cave'],
      rewards: ['Regional safety', 'Elimination of thrall threat'],
    },
    {
      id: 'quest_liberate_phandalin',
      name: 'Liberate Phandalin',
      status: 'active', priority: 'high',
      summary: 'Silga and the Redbrands control Phandalin. ~8–12 Redbrands active, three families extorted. Harpers arrive Day 9.',
      objectives: [
        { text: 'Gather intel on Silga (Iarno can provide)',       done: false },
        { text: 'Coordinate with arriving Harpers (Day 9)',        done: false },
        { text: 'Neutralize Redbrand presence',                   done: false },
        { text: 'Restore Phandalin to civilian control',          done: false },
      ],
      current_stage: "Planning phase. Iarno has intel on Silga. Harpers ETA Day 9.",
      related_npcs: ['npc_silga', 'npc_iarno', 'npc_sildar', 'npc_toblen'],
      related_locations: ['loc_phandalin'],
      rewards: ['Town freedom', 'Redbrand defeat', 'Harpers alliance deepened'],
    },
    {
      id: 'quest_contain_the_witness',
      name: 'Contain the Witness',
      status: 'completed', priority: 'resolved',
      summary: 'Ancient entity imprisoned 400 years ago was escaping. Rurik performed the binding ritual as Bearer of the Seal on Day 6.',
      objectives: [
        { text: 'Locate Wave Echo Cave and investigate the seal',              done: true },
        { text: 'Gather the five ritual voices',                               done: true },
        { text: 'Perform the binding ritual with Rurik as anchor',            done: true },
        { text: 'Reinforce and stabilize the seal',                           done: true },
      ],
      current_stage: 'COMPLETE. Seal reinforced. Rurik permanently bonded as Bearer of the Seal.',
      related_npcs: ['npc_rurik', 'npc_garaele', 'npc_sildar', 'npc_gundren', 'npc_toblen', 'npc_iarno', 'npc_the_witness'],
      related_locations: ['loc_wave_echo_cave', 'loc_seal_chamber'],
      rewards: ['Witness contained for years or decades', 'Rurik becomes Bearer of the Seal (permanent)'],
    },
  ];
}

// ── Build canonical state ─────────────────────────────────────────────────────
function buildCampaignState(sections) {
  const allNPCs = buildNPCRegistry();
  return {
    campaign_id   : 'lost_mine_witness_arc',
    campaign_name : 'Lost Mine of Phandelver — The Witness Arc',
    session_state : extractSessionState(sections),
    world_state   : extractWorldState(sections),
    party         : allNPCs.filter(n => n.disposition === 'player'),
    npcs          : allNPCs.filter(n => n.disposition !== 'player'),
    locations     : buildLocationRegistry(),
    quests        : buildQuestRegistry(),
    meta: {
      source_file          : 'Campaign Context full.md',
      extraction_confidence: 0.97,
      extraction_method    : 'structured-parse + curated-registry',
      schema_version       : '1.0',
      notes                : 'Generated by rebuild-memory.js. Full narrative history in Campaign Context full.md and dashboard Events tab.',
    },
  };
}

// ── Apply a session diff to the state ────────────────────────────────────────
function applyDiff(state, diff) {
  for (const op of diff.operations) {
    const { op: type, entity_type, entity_id, data } = op;
    let collection;
    if      (entity_type === 'npc')          collection = [...state.party, ...state.npcs];
    else if (entity_type === 'quest')        collection = state.quests;
    else if (entity_type === 'location')     collection = state.locations;
    else if (entity_type === 'world_state')  { Object.assign(state.world_state, data); continue; }
    else if (entity_type === 'session')      { Object.assign(state.session_state, data); continue; }

    const existing = collection?.find(e => e.id === entity_id);

    if (type === 'add' && !existing) {
      if (entity_type === 'npc') state.npcs.push({ id: entity_id, ...data });
      else collection.push({ id: entity_id, ...data });
    } else if (type === 'update' && existing) {
      Object.assign(existing, data);
    } else if (type === 'append' && existing) {
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(existing[k]) && Array.isArray(v)) existing[k].push(...v);
        else existing[k] = v;
      }
    } else if (type === 'delete' && existing) {
      const idx = collection.indexOf(existing);
      if (idx !== -1) collection.splice(idx, 1);
    }
  }
  state.session_state.last_updated = now();
  return state;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const [,, command = 'rebuild'] = process.argv;

  if (!fs.existsSync(CONTEXT_FILE)) {
    console.error(`ERROR: Campaign Context full.md not found at:\n  ${CONTEXT_FILE}`);
    process.exit(1);
  }

  const markdown = fs.readFileSync(CONTEXT_FILE, 'utf8');
  const sections = parseSections(markdown);

  ensureDir(OUT_ROOT);
  ensureDir(DIFF_DIR);
  ensureDir(path.join(OUT_ROOT, 'npcs'));
  ensureDir(path.join(OUT_ROOT, 'quests'));
  ensureDir(path.join(OUT_ROOT, 'locations'));

  // ── Rebuild full state ──
  const state = buildCampaignState(sections);

  // ── Apply any existing diffs in order ──
  if (command === 'apply-diffs') {
    const diffFiles = fs.readdirSync(DIFF_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
    for (const f of diffFiles) {
      const diff = JSON.parse(fs.readFileSync(path.join(DIFF_DIR, f), 'utf8'));
      if (diff.operations?.length) {
        applyDiff(state, diff);
        console.log(`  Applied diff: ${f} (${diff.operations.length} ops)`);
      }
    }
  }

  // ── Write full state ──
  write(path.join(OUT_ROOT, 'campaign_state.json'), state);
  console.log('✓ campaigns/lost-mine/campaign_state.json');

  // ── Write individual entity files ──
  for (const npc of [...state.party, ...state.npcs]) {
    write(path.join(OUT_ROOT, 'npcs', `${npc.id}.json`), npc);
  }
  console.log(`✓ npcs/  (${state.party.length + state.npcs.length} files)`);

  for (const quest of state.quests) {
    write(path.join(OUT_ROOT, 'quests', `${quest.id}.json`), quest);
  }
  console.log(`✓ quests/ (${state.quests.length} files)`);

  for (const loc of state.locations) {
    write(path.join(OUT_ROOT, 'locations', `${loc.id}.json`), loc);
  }
  console.log(`✓ locations/ (${state.locations.length} files)`);

  // ── Scaffold empty diff for current session ──
  const sessionNum  = state.session_state.current_session;
  const diffFile    = path.join(DIFF_DIR, `session_${pad(sessionNum)}.json`);
  if (!fs.existsSync(diffFile)) {
    write(diffFile, {
      campaign_id: state.campaign_id,
      session_id : sessionNum,
      timestamp  : now(),
      operations : [],
      meta       : { source: 'session_transcript', notes: 'Scaffold. Populate operations after session.' },
    });
    console.log(`✓ diffs/session_${pad(sessionNum)}.json  (scaffold)`);
  }

  console.log(`\n🎲 Memory rebuilt.`);
  console.log(`   ${state.party.length + state.npcs.length} NPCs · ${state.locations.length} locations · ${state.quests.length} quests`);
  console.log(`   Session ${sessionNum} · ${state.world_state.flags.seal_integrity_pct}% seal integrity\n`);
}

main();
