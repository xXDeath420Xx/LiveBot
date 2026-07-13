// Audit script: read-only inspection of The Bat Cave Discord guild permissions
// Checks for gaps in the lockdown: @everyone access leaks, missing Gotham Citizen allows, Muted denies
//
// Usage: node scripts/gotham-audit-channel-perms.mjs
//
// Do NOT execute — for inspection only.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const EVERYONE_ID = GUILD;  // @everyone role is the guild ID
const GOTHAM_CITIZEN_ID = '800252381513777158';
const MUTED_ROLE_ID = '1503946366542548992';
const BOT_ID = '1503936879635202149';  // Harley's Bat

const WELCOME_CH = '1503938671857106955';
const RULES_CH = '800256456997863434';
const SAFE_PUBLIC = new Set([WELCOME_CH, RULES_CH]);

// Permission bit definitions
const VIEW_CHANNEL = 1024n;
const SEND_MESSAGES = 2048n;
const READ_HISTORY = 65536n;
const ADD_REACTIONS = 64n;
const CONNECT = 1n << 20n;   // 1048576
const SPEAK = 1n << 21n;     // 2097152
const MUTED_DENY_MASK = ADD_REACTIONS | SEND_MESSAGES | SPEAK;  // 2097216

let tokenFetched = false;
let token = null;

async function fetchBotToken() {
  if (tokenFetched) return token;
  try {
    const [rows] = await pool.execute(
      'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
      [BOT_ID]
    );
    if (rows.length === 0) {
      console.error(`[!] Harley's Bat token not found in custom_bots table`);
      return null;
    }
    const decrypted = encryption.decrypt(JSON.parse(rows[0].bot_token));
    tokenFetched = true;
    token = decrypted;
    return token;
  } catch (err) {
    console.error(`[!] Failed to decrypt bot token:`, err.message);
    return null;
  }
}

async function api(method, path, body) {
  const t = await fetchBotToken();
  if (!t) throw new Error('Bot token unavailable');
  
  await new Promise(r => setTimeout(r, 50));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${t}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 200));
    return api(method, path, body);
  }
  
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 250)}`);
  }
  return r.status === 204 ? null : r.json();
}

function hasPermBit(perms, bit) {
  if (!perms) return false;
  const p = BigInt(perms);
  return (p & bit) === bit;
}

async function main() {
  console.log('\n=== Bat Cave Permission Audit ===\n');

  // 1. Fetch all channels
  console.log('[1/5] Fetching channels…');
  const channels = await api('GET', `/guilds/${GUILD}/channels`);
  const nonCategoryChannels = channels.filter(c => c.type !== 4);
  const categories = new Map(channels.filter(c => c.type === 4).map(c => [c.id, c]));
  console.log(`    ${channels.length} total channels (${nonCategoryChannels.length} non-categories, ${categories.size} categories)\n`);

  // 2. Fetch guild-level @everyone role
  console.log('[2/5] Fetching guild roles…');
  const roles = await api('GET', `/guilds/${GUILD}/roles`);
  const everyoneRole = roles.find(r => r.id === EVERYONE_ID);
  const gothamRole = roles.find(r => r.id === GOTHAM_CITIZEN_ID);
  const mutedRole = roles.find(r => r.id === MUTED_ROLE_ID);

  const everyoneHasView = everyoneRole && hasPermBit(everyoneRole.permissions, VIEW_CHANNEL);
  const everyoneHasReadHistory = everyoneRole && hasPermBit(everyoneRole.permissions, READ_HISTORY);

  console.log(`    @everyone role (${EVERYONE_ID}):`);
  console.log(`      permissions=${everyoneRole?.permissions || 'N/A'}`);
  console.log(`      has VIEW_CHANNEL: ${everyoneHasView ? 'YES (❌ LEAK!)' : 'no (✓ correct)'}`);
  console.log(`      has READ_MESSAGE_HISTORY: ${everyoneHasReadHistory ? 'YES (❌ LEAK!)' : 'no (✓ correct)'}`);
  console.log(`    Gotham Citizen (${GOTHAM_CITIZEN_ID}): ${gothamRole ? 'found' : 'NOT FOUND'}`);
  console.log(`    Muted (${MUTED_ROLE_ID}): ${mutedRole ? 'found' : 'NOT FOUND'}\n`);

  // 3. Audit per-channel overwrites
  console.log('[3/5] Auditing per-channel overwrites…\n');

  const findings = {
    leaks: [],           // @everyone can view per-channel
    missingCitizen: [],  // Gotham Citizen can't see
    missingMuted: [],    // Muted missing deny
    syncMismatches: [],  // Category sync issues
  };

  const channelReports = [];

  for (const ch of nonCategoryChannels) {
    const overwrites = ch.permission_overwrites || [];
    const parent = categories.get(ch.parent_id);
    const parentOverwrites = parent?.permission_overwrites || [];

    const everyoneOverwrite = overwrites.find(o => o.id === EVERYONE_ID);
    const gothamOverwrite = overwrites.find(o => o.id === GOTHAM_CITIZEN_ID);
    const mutedOverwrite = overwrites.find(o => o.id === MUTED_ROLE_ID);

    const everyoneAllowHasView = everyoneOverwrite && hasPermBit(everyoneOverwrite.allow, VIEW_CHANNEL);
    const gothamHasViewAllow = gothamOverwrite && hasPermBit(gothamOverwrite.allow, VIEW_CHANNEL);
    const mutedHasFullDeny = mutedOverwrite && (BigInt(mutedOverwrite.deny || '0') & MUTED_DENY_MASK) === MUTED_DENY_MASK;

    // Check for @everyone per-channel allow VIEW (leak)
    if (everyoneAllowHasView && !SAFE_PUBLIC.has(ch.id)) {
      findings.leaks.push({
        id: ch.id,
        name: ch.name,
        reason: '@everyone has allow VIEW_CHANNEL per-channel overwrite',
      });
    }

    // Check if Gotham Citizen can view (should have explicit allow OR guild-wide access)
    const citizenCanView = gothamHasViewAllow || (gothamRole && hasPermBit(gothamRole.permissions, VIEW_CHANNEL));
    if (!citizenCanView && !SAFE_PUBLIC.has(ch.id)) {
      findings.missingCitizen.push({
        id: ch.id,
        name: ch.name,
        reason: 'Gotham Citizen lacks VIEW_CHANNEL (per-channel and guild-level)',
      });
    }

    // Check if Muted has full deny (SEND + SPEAK + ADD_REACTIONS)
    if (!mutedHasFullDeny) {
      findings.missingMuted.push({
        id: ch.id,
        name: ch.name,
        reason: `Muted missing deny mask; has deny=${mutedOverwrite?.deny || 'none'} (need 2097216)`,
      });
    }

    // Check sync state with parent category
    if (parent && ch.type !== 4) {
      const parentEveryoneOverwrite = parentOverwrites.find(o => o.id === EVERYONE_ID);
      const chEveryoneOverwrite = overwrites.find(o => o.id === EVERYONE_ID);
      
      // Simple sync check: if parent has @everyone and channel doesn't match, flag it
      const parentEveryoneDeny = parentEveryoneOverwrite?.deny;
      const chEveryoneDeny = chEveryoneOverwrite?.deny;
      
      if (parent && (String(parentEveryoneDeny || '0') !== String(chEveryoneDeny || '0'))) {
        findings.syncMismatches.push({
          id: ch.id,
          name: ch.name,
          parent: parent.name,
          parentDeny: parentEveryoneDeny,
          channelDeny: chEveryoneDeny,
        });
      }
    }

    channelReports.push({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      parent: parent?.name || '(none)',
      everyoneOverwrite: everyoneOverwrite ? { allow: everyoneOverwrite.allow, deny: everyoneOverwrite.deny } : null,
      gothamOverwrite: gothamOverwrite ? { allow: gothamOverwrite.allow, deny: gothamOverwrite.deny } : null,
      mutedOverwrite: mutedOverwrite ? { allow: mutedOverwrite.allow, deny: mutedOverwrite.deny } : null,
      mutedFullDeny: mutedHasFullDeny,
      citizenCanView,
      everyoneLeaksView: everyoneAllowHasView,
    });
  }

  // 4. Print per-channel details (sample)
  console.log('Sample channel audit (first 10):');
  for (const ch of channelReports.slice(0, 10)) {
    console.log(`\n  #${ch.name} (${ch.id}) [type=${ch.type}, parent=${ch.parent}]`);
    if (ch.everyoneOverwrite) {
      console.log(`    @everyone: allow=${ch.everyoneOverwrite.allow}, deny=${ch.everyoneOverwrite.deny} ${ch.everyoneLeaksView ? '❌ LEAK' : ''}`);
    } else {
      console.log(`    @everyone: (no overwrite)`);
    }
    if (ch.gothamOverwrite) {
      console.log(`    Gotham Citizen: allow=${ch.gothamOverwrite.allow}, deny=${ch.gothamOverwrite.deny}`);
    } else {
      console.log(`    Gotham Citizen: (no overwrite) [inherit guild-level]`);
    }
    if (ch.mutedOverwrite) {
      console.log(`    Muted: allow=${ch.mutedOverwrite.allow}, deny=${ch.mutedOverwrite.deny} ${!ch.mutedFullDeny ? '❌ INCOMPLETE' : '✓'}`);
    } else {
      console.log(`    Muted: (no overwrite) ❌ MISSING`);
    }
  }

  // 5. Summary report
  console.log('\n\n=== Summary Report ===\n');

  console.log(`GUILD-LEVEL @everyone PERMISSIONS (CRITICAL):`);
  if (everyoneHasView) {
    console.log(`  ❌ @everyone HAS VIEW_CHANNEL — lockdown completely broken`);
  } else {
    console.log(`  ✓ @everyone lacks VIEW_CHANNEL`);
  }
  if (everyoneHasReadHistory) {
    console.log(`  ⚠️  @everyone HAS READ_MESSAGE_HISTORY — may need review`);
  } else {
    console.log(`  ✓ @everyone lacks READ_MESSAGE_HISTORY`);
  }

  console.log(`\nPER-CHANNEL @everyone ALLOW LEAKS (${findings.leaks.length}):`);
  if (findings.leaks.length === 0) {
    console.log(`  ✓ No unauthorized @everyone allows found`);
  } else {
    for (const leak of findings.leaks) {
      console.log(`  ❌ #${leak.name} (${leak.id}): ${leak.reason}`);
    }
  }

  console.log(`\nMISSING GOTHAM CITIZEN ALLOWS (${findings.missingCitizen.length}):`);
  if (findings.missingCitizen.length === 0) {
    console.log(`  ✓ All channels accessible to Gotham Citizen`);
  } else {
    for (const miss of findings.missingCitizen) {
      console.log(`  ❌ #${miss.name} (${miss.id}): ${miss.reason}`);
    }
  }

  console.log(`\nMISSING MUTED DENY MASKS (${findings.missingMuted.length}):`);
  if (findings.missingMuted.length === 0) {
    console.log(`  ✓ All channels have Muted deny applied`);
  } else {
    console.log(`  Top 15 missing Muted denies:`);
    for (const miss of findings.missingMuted.slice(0, 15)) {
      console.log(`    #${miss.name} (${miss.id}): ${miss.reason}`);
    }
    if (findings.missingMuted.length > 15) {
      console.log(`    ... and ${findings.missingMuted.length - 15} more`);
    }
  }

  console.log(`\nCATEGORY SYNC MISMATCHES (${findings.syncMismatches.length}):`);
  if (findings.syncMismatches.length === 0) {
    console.log(`  ✓ All channels sync with parent categories`);
  } else {
    for (const mismatch of findings.syncMismatches) {
      console.log(`  ⚠️  #${mismatch.name} (${mismatch.id}) in [${mismatch.parent}]:`);
      console.log(`      parent deny=${mismatch.parentDeny}, channel deny=${mismatch.channelDeny}`);
    }
  }

  console.log(`\n=== Audit Complete ===\n`);

  // Close pool
  await pool.end();
}

main().catch(err => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});
