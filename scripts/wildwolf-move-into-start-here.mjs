// Follow-up: move rules/welcome/introduce-yourself/self-roles into 📜 START HERE.
// Discord's bulk PATCH /guilds/:id/channels rejects multi-channel parent_id
// changes (error 40009); we have to PATCH each channel individually.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1414753158999179286';
const BOT_ID   = '1507873568095076425';

const [botRows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const TOKEN = encryption.decrypt(JSON.parse(botRows[0].bot_token));

async function api(method, path, body) {
    await new Promise(r => setTimeout(r, 250));
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 300));
        return api(method, path, body);
    }
    if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 400) } };
    return res.status === 204 ? null : res.json();
}

const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const startHere = channels.find(c => c.type === 4 && /start.here|📜/.test(c.name));
if (!startHere) { console.error('📜 START HERE category not found'); process.exit(1); }
console.log(`📜 START HERE = ${startHere.id}`);

const targets = [
    { name: 'rules' },
    { name: 'welcome' },
    { name: 'introduce-yourself' },
    { name: 'self-roles' },
];

for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const ch = channels.find(c => c.type === 0 && c.name === t.name);
    if (!ch) { console.log(`  ⚠ #${t.name} not found`); continue; }
    if (ch.parent_id === startHere.id) {
        console.log(`  = #${t.name} (${ch.id}) already in START HERE — repositioning to ${i}`);
        const r = await api('PATCH', `/channels/${ch.id}`, { position: i, lock_permissions: false });
        if (r?.__err) console.log(`    ✗ ${r.__err.body}`);
        continue;
    }
    const r = await api('PATCH', `/channels/${ch.id}`, {
        parent_id: startHere.id,
        position: i,
        lock_permissions: false,  // preserve our per-channel overwrites
    });
    if (r?.__err) console.log(`  ✗ #${t.name}: ${r.__err.status} ${r.__err.body}`);
    else console.log(`  ✓ #${t.name} → 📜 START HERE @ pos ${i}`);
}

// Verify
const after = await api('GET', `/guilds/${GUILD_ID}/channels`);
const startKids = after.filter(c => c.parent_id === startHere.id).sort((a,b)=>a.position-b.position);
console.log(`\n📜 START HERE now contains: ${startKids.map(c => `#${c.name}`).join(', ')}`);

await pool.end();
