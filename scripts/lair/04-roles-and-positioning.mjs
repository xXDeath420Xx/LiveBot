// Phase A — create missing roles for CertiFried's systems + set hierarchy.
// Principle: ADDITIVE, don't touch the Lair's existing bear-themed roles.
import 'dotenv/config';
import fs from 'fs';

const GUILD = '1216126780767731722';
const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };

async function rest(method, url, body) {
    const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
}

// Bot Manager perm bitfield — all non-admin perms
const BITS = [0,1,2,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,49,50];
const allNonAdmin = BITS.reduce((a, b) => a | (1n << BigInt(b)), 0n).toString();

// Beta-style mod perms (used if we later want a ModBears 2.0, but for now reuse existing ModBears role)
const MOD_BITS = [0,1,2,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23,24,25,26,27,31,32,33,34,35,36,37,38,39,40,42,43,44,45,46,49,50];
const modPerms = MOD_BITS.reduce((a, b) => a | (1n << BigInt(b)), 0n).toString();

// Full role plan. Existing roles (Lair Bear, ModBears, Mama Bear, etc.) are NOT touched.
const PLAN = [
    // ── Admin/bot tier ──
    { name: 'Bot Manager',      color: 0x1591FD, hoist: true,  mentionable: false, permissions: allNonAdmin, reason: 'Admin-without-admin role for server owner/tooling' },

    // ── Verification gates ──
    { name: 'Verified',          color: 0x43B581, hoist: false, mentionable: false, permissions: '0',        reason: 'Granted on rule acceptance' },
    { name: 'Unverified',        color: 0x95A5A6, hoist: false, mentionable: false, permissions: '0',        reason: 'Auto-assigned on join, stripped on verify' },
    { name: 'Muted',             color: 0x4F545C, hoist: false, mentionable: false, permissions: '0',        reason: 'Legacy mute (timeouts preferred) — channel-level denies applied below' },

    // ── NSFW opt-in ──
    { name: 'NSFW Access',       color: 0xE74C3C, hoist: false, mentionable: false, permissions: '0',        reason: 'Age-confirmed access to NSFW channels' },

    // ── Color roles (6) ──
    { name: 'Purple', color: 0xAA8ED6, hoist: false, mentionable: false, permissions: '0', reason: 'Color role' },
    { name: 'Orange', color: 0xFFAC33, hoist: false, mentionable: false, permissions: '0', reason: 'Color role' },
    { name: 'Green',  color: 0x78B159, hoist: false, mentionable: false, permissions: '0', reason: 'Color role' },
    { name: 'Red',    color: 0xDD2E44, hoist: false, mentionable: false, permissions: '0', reason: 'Color role' },
    { name: 'Yellow', color: 0xFDCB58, hoist: false, mentionable: false, permissions: '0', reason: 'Color role' },
    { name: 'Blue',   color: 0x55ACEE, hoist: false, mentionable: false, permissions: '0', reason: 'Color role' },

    // ── Level reward progression (bear-themed, NEW roles — doesn't conflict with existing "Lair Bear") ──
    { name: 'Cubs',                color: 0xFFC58C, hoist: true,  mentionable: false, permissions: '0', reason: 'Level 1 reward' },
    { name: 'Shoutout Eligible',   color: 0x9B59B6, hoist: false, mentionable: false, permissions: '0', reason: 'Level 3 — unlocks auto-shoutouts' },
    { name: 'Lair Sentinel',       color: 0x2ECC71, hoist: false, mentionable: true,  permissions: '0', reason: 'Level 5' },
    { name: 'Lair Hunter',         color: 0x27AE60, hoist: false, mentionable: true,  permissions: '0', reason: 'Level 10' },
    { name: 'Lair Warrior',        color: 0x2980B9, hoist: false, mentionable: true,  permissions: '0', reason: 'Level 15' },
    { name: 'Lair Elder',          color: 0x8E44AD, hoist: false, mentionable: true,  permissions: '0', reason: 'Level 20' },
    { name: 'Lair Legend',         color: 0xE67E22, hoist: false, mentionable: true,  permissions: '0', reason: 'Level 25' },
    { name: 'Lair Legacy',         color: 0xC0392B, hoist: false, mentionable: true,  permissions: '0', reason: 'Level 30' },

    // ── Self-assignable opt-ins ──
    { name: 'Announcements', color: 0xE67E22, hoist: false, mentionable: true,  permissions: '0', reason: 'Opt-in announcement pings' },
    { name: 'Music',         color: 0x1ABC9C, hoist: false, mentionable: false, permissions: '0', reason: 'Unlocks #music channel' },
];

// Load existing roles — skip creation if name collides
const existing = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/roles`);
const existingByName = new Map(existing.map(r => [r.name.toLowerCase(), r]));

const created = {};
const skipped = {};
for (const def of PLAN) {
    const coll = existingByName.get(def.name.toLowerCase());
    if (coll) {
        skipped[def.name] = coll.id;
        console.log(`skip (exists): ${def.name} → ${coll.id}`);
        continue;
    }
    const r = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/roles`, {
        name: def.name, color: def.color, hoist: def.hoist, mentionable: def.mentionable,
        permissions: def.permissions, reason: def.reason,
    });
    created[def.name] = r.id;
    console.log(`created: ${def.name} → ${r.id}`);
}

// Write to state file for subsequent phases
const roleIds = { ...skipped, ...created };
// Also capture key existing role IDs we'll reference
const existingRolesNeeded = ['Mama Bear', 'Co-Owner/Admin', 'Lead ModBear', 'ModBears', 'Lair Bear', 'Founding Bear', 'VIB (Very Important Bear)', 'Twitch Streamer', 'Palia Community', 'MBLive', 'Notify Me'];
for (const name of existingRolesNeeded) {
    const r = existing.find(r => r.name === name);
    if (r) roleIds[name] = r.id;
}

fs.writeFileSync('/home/death/CertiFriedUtility/scripts/lair/role-ids.json', JSON.stringify(roleIds, null, 2));
console.log(`\nwrote role-ids.json (${Object.keys(roleIds).length} role references)`);
