#!/usr/bin/env node
'use strict';

/**
 * load-context.js
 * Reads Campaign Context full.md and loads session state into campaign_state.json.
 * Preserves spell slot usage across sessions; resets on long rest.
 *
 * Usage:
 *   node scripts/load-context.js
 *
 * Behavior:
 *   - Reads Campaign Context full.md (source of truth)
 *   - Extracts: day, location, time, HP, spell slots, channel divinity
 *   - Merges into campaign_state.json WITHOUT losing history or previous state
 *   - If context indicates "long rest", resets all spell slot usage
 *   - Appends history_log entry for audit trail
 */

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
//  PARSING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split markdown file by ## sections into object
 */
function parseSections(md) {
  const sections = {};
  const lines = md.split('\n');
  let currentSection = null;
  let currentContent = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection) {
        sections[currentSection] = currentContent.join('\n').trim();
      }
      currentSection = line.slice(3).trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    sections[currentSection] = currentContent.join('\n').trim();
  }

  return sections;
}

/**
 * Extract SESSION STATE table from markdown
 * Expected format:
 * | Location | Old Marta's Cabin, Phandalin outskirts |
 * | HP | 27 / 27 (full — long rest complete) |
 * | Spell Slots | 4× 1st, 2× 2nd (full) |
 * | Channel Divinity | 1 / 1 available |
 */
function parseSessionStateTable(sessionStateText) {
  const lines = sessionStateText.split('\n');
  const result = { day: null, location: null, hp: null, time: null, spell_slots: null, channel_divinity: null, long_rest: false };

  for (const line of lines) {
    const match = line.match(/\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (!match) continue;

    const [, field, value] = match;
    const fieldLower = field.toLowerCase().trim();
    const valueTrim = value.trim();

    if (fieldLower.includes('location'))  result.location = valueTrim;
    if (fieldLower.includes('hp'))        result.hp = valueTrim;
    if (fieldLower.includes('spell slot')) result.spell_slots = valueTrim;
    if (fieldLower.includes('channel'))    result.channel_divinity = valueTrim;
    if (fieldLower.includes('time') || fieldLower.includes('day')) {
      // Try to extract both day and time
      const dayMatch = valueTrim.match(/Day\s+(\d+)/i);
      const timeMatch = valueTrim.match(/\b(Morning|Afternoon|Evening|Night)\b/i);
      if (dayMatch) result.day = parseInt(dayMatch[1], 10);
      if (timeMatch) result.time = timeMatch[1];
    }
  }

  // Check for "long rest complete" marker
  if (result.hp && result.hp.includes('long rest')) {
    result.long_rest = true;
  }

  return result;
}

/**
 * Parse spell slot string: "4× 1st, 2× 2nd"
 * Returns: { level_1: { max: 4 }, level_2: { max: 2 }, ... }
 */
function parseSpellSlots(slotString) {
  const result = {
    cantrip:  { max: 0 },
    level_1:  { max: 0 },
    level_2:  { max: 0 },
    level_3:  { max: 0 },
    level_4:  { max: 0 },
    level_5:  { max: 0 }
  };

  if (!slotString) return result;

  // Regex: "4× 1st" or "4×1st" (with optional space)
  const regex = /(\d+)×\s*(?:(\d+)\s*)?(?:cantrip|0th|1st|2nd|3rd|4th|5th|6th|7th|8th|9th)/gi;
  let match;

  while ((match = regex.exec(slotString)) !== null) {
    const [full, count, levelDigit] = match;
    let level;

    if (levelDigit) {
      level = parseInt(levelDigit, 10);
    } else {
      // Infer from ordinal
      const text = full.toLowerCase();
      if (text.includes('cantrip') || text.includes('0th')) level = 0;
      else if (text.includes('1st'))                         level = 1;
      else if (text.includes('2nd'))                         level = 2;
      else if (text.includes('3rd'))                         level = 3;
      else if (text.includes('4th'))                         level = 4;
      else if (text.includes('5th'))                         level = 5;
      else if (text.includes('6th'))                         level = 6;
      else if (text.includes('7th'))                         level = 7;
      else if (text.includes('8th'))                         level = 8;
      else if (text.includes('9th'))                         level = 9;
    }

    const key = level === 0 ? 'cantrip' : `level_${level}`;
    if (result[key]) result[key].max = parseInt(count, 10);
  }

  return result;
}

/**
 * Parse channel divinity: "1 / 1 available"
 * Returns: { max: 1 }
 */
function parseChannelDivinity(cdString) {
  const match = cdString.match(/(\d+)\s*\/\s*(\d+)/);
  if (match) {
    return { max: parseInt(match[2], 10) };
  }
  return { max: 1 };
}

/**
 * Parse HP: "27 / 27 (full — long rest complete)"
 * Returns: { current: 27, max: 27 }
 */
function parseHp(hpString) {
  const match = hpString.match(/(\d+)\s*\/\s*(\d+)/);
  if (match) {
    return { current: parseInt(match[1], 10), max: parseInt(match[2], 10) };
  }
  return { current: 27, max: 27 };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATE MERGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge context data into campaign state.
 * Preserves spell slot usage UNLESS long rest is indicated.
 */
function mergeIntoState(contextData, campaignState) {
  // Update world state
  if (contextData.location) campaignState.world.current_location = contextData.location;
  if (contextData.time) campaignState.world.time = `Day ${contextData.day} — ${contextData.time}`;

  // Update party member (Rurik)
  if (campaignState.party && campaignState.party.length > 0) {
    const rurik = campaignState.party[0];

    // HP
    if (contextData.hp) {
      const hpParsed = parseHp(contextData.hp);
      rurik.hp = hpParsed.current;
    }

    // Spell slots: update MAX, reset USED only if long rest
    if (contextData.spell_slots) {
      const parsed = parseSpellSlots(contextData.spell_slots);
      if (!rurik.spell_slots) rurik.spell_slots = {};

      for (const [key, data] of Object.entries(parsed)) {
        if (!rurik.spell_slots[key]) rurik.spell_slots[key] = {};
        rurik.spell_slots[key].max = data.max;

        // Reset used count if long rest, otherwise preserve
        if (contextData.long_rest) {
          rurik.spell_slots[key].used = 0;
        } else if (rurik.spell_slots[key].used === undefined) {
          rurik.spell_slots[key].used = 0;
        }
      }
    }

    // Channel Divinity
    if (contextData.channel_divinity) {
      const cdParsed = parseChannelDivinity(contextData.channel_divinity);
      if (!rurik.channel_divinity) rurik.channel_divinity = {};
      rurik.channel_divinity.max = cdParsed.max;

      if (contextData.long_rest) {
        rurik.channel_divinity.used = 0;
      } else if (rurik.channel_divinity.used === undefined) {
        rurik.channel_divinity.used = 0;
      }
    }
  }

  // Append history log entry
  const slotInfo = contextData.spell_slots || 'unknown';
  const restStatus = contextData.long_rest ? 'spell slots RESET' : 'spell slots PRESERVED';
  campaignState.history_log.push({
    timestamp: new Date().toISOString(),
    event: `Loaded context file. Day ${contextData.day}, ${contextData.location}, ${contextData.hp}, ${slotInfo} (${restStatus}).`
  });

  return campaignState;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const root = path.resolve(__dirname, '..');
  const contextPath = path.join(root, 'Campaign Context full.md');
  const statePath = path.join(root, 'campaign_state.json');

  // Read context file
  if (!fs.existsSync(contextPath)) {
    console.error(`❌ Context file not found: ${contextPath}`);
    process.exit(1);
  }

  const contextMd = fs.readFileSync(contextPath, 'utf8');
  const sections = parseSections(contextMd);

  // Find SESSION STATE section (might have "— Day 7, Morning" suffix)
  let sessionStateSection = null;
  for (const key of Object.keys(sections)) {
    if (key.includes('SESSION STATE')) {
      sessionStateSection = key;
      break;
    }
  }

  if (!sessionStateSection) {
    console.error('❌ SESSION STATE section not found in context file');
    process.exit(1);
  }

  // Parse session state
  const sessionData = parseSessionStateTable(sections[sessionStateSection]);

  // Extract day/time from section header if not in table
  // Format: "SESSION STATE — Day 7, Morning"
  if (!sessionData.day) {
    const headerMatch = sessionStateSection.match(/Day\s+(\d+)/i);
    if (headerMatch) sessionData.day = parseInt(headerMatch[1], 10);
  }
  if (!sessionData.time) {
    const timeMatch = sessionStateSection.match(/\b(Morning|Afternoon|Evening|Night)\b/i);
    if (timeMatch) sessionData.time = timeMatch[1];
  }

  // Load campaign state
  if (!fs.existsSync(statePath)) {
    console.error(`❌ Campaign state not found: ${statePath}`);
    process.exit(1);
  }

  let campaignState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  // Merge
  campaignState = mergeIntoState(sessionData, campaignState);

  // Write back
  fs.writeFileSync(statePath, JSON.stringify(campaignState, null, 2), 'utf8');

  // Report
  console.log(`\n✓ Context loaded successfully`);
  console.log(`  Day ${sessionData.day} · ${sessionData.time}`);
  console.log(`  Location: ${sessionData.location}`);
  console.log(`  HP: ${sessionData.hp}`);
  console.log(`  Spell slots: ${sessionData.spell_slots}`);
  console.log(`  Channel divinity: ${sessionData.channel_divinity}`);
  if (sessionData.long_rest) {
    console.log(`  ↻ Long rest detected — all spell slots RESET`);
  } else {
    console.log(`  → Spell slot usage PRESERVED from previous session`);
  }
  console.log(`\n✓ campaign_state.json updated`);
  console.log(`✓ history_log appended\n`);
}

main().catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
