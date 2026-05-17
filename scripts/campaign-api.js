#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3140;
const STATE_PATH = path.join(__dirname, '..', 'campaign_state.json');

function readState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function validateState(state) {
  const party = state.party[0];
  if (!party) return { ok: false, err: 'No party member' };

  for (const [level, data] of Object.entries(party.spell_slots || {})) {
    if (data.used > data.max) {
      return { ok: false, err: `spell_slots.${level}: used (${data.used}) exceeds max (${data.max})` };
    }
  }

  for (const item of (party.inventory || [])) {
    if (item.quantity < 0) {
      return { ok: false, err: `Inventory "${item.name}": quantity cannot be negative` };
    }
  }

  return { ok: true };
}

function buildChangeLog(oldState, newState) {
  const changes = [];
  const oldParty = oldState.party[0];
  const newParty = newState.party[0];

  if (oldParty.hp !== newParty.hp) {
    changes.push(`HP: ${oldParty.hp} → ${newParty.hp}`);
  }

  for (const level of Object.keys(oldParty.spell_slots)) {
    if (oldParty.spell_slots[level].used !== newParty.spell_slots[level].used) {
      changes.push(`${level}: ${oldParty.spell_slots[level].used}/${oldParty.spell_slots[level].max} → ${newParty.spell_slots[level].used}/${newParty.spell_slots[level].max}`);
    }
  }

  if (oldParty.channel_divinity.used !== newParty.channel_divinity.used) {
    changes.push(`Channel Divinity: ${oldParty.channel_divinity.used}/${oldParty.channel_divinity.max} → ${newParty.channel_divinity.used}/${newParty.channel_divinity.max}`);
  }

  if (JSON.stringify(oldParty.inventory) !== JSON.stringify(newParty.inventory)) {
    changes.push('Updated inventory');
  }

  if (JSON.stringify(oldState.quests) !== JSON.stringify(newState.quests)) {
    changes.push('Updated quests');
  }

  return changes.length > 0 ? changes.join(' | ') : 'State update';
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/state') {
    try {
      const state = readState();
      res.writeHead(200);
      res.end(JSON.stringify(state));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/state') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const newState = JSON.parse(body);
        const validation = validateState(newState);

        if (!validation.ok) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: validation.err }));
          return;
        }

        const oldState = readState();
        const changeLog = buildChangeLog(oldState, newState);

        newState.history_log.push({
          timestamp: new Date().toISOString(),
          event: changeLog
        });

        writeState(newState);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, state: newState }));

      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`✓ Campaign API running on port ${PORT}`);
  console.log(`  GET  http://localhost:${PORT}/api/state`);
  console.log(`  POST http://localhost:${PORT}/api/state`);
});
