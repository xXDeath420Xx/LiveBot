// Backfill @Verified on every non-bot member of guild 1428091358522114090
// who has been in the guild for at least 24 hours and does not yet have it.
//
// One-shot: run once after the lockdown to preserve access for existing
// members. New joiners verify themselves via the I-Agree button in #rules.
//
// REST-only via DarkWolf's bot token. Safe to run while PM2 is live.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID      = '1428091358522114090';
const BOT_ID        = '1506374126594691092';
const VERIFIED_ROLE = '1506378052286812200';
const MIN_AGE_MS    = 24 * 60 * 60 * 1000;

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
if (!rows.length) { console.error('Bot row missing'); process.exit(1); }
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
    await new Promise(r => setTimeout(r, 60));
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 300));
        return api(method, path, body);
    }
    if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 250) } };
    return res.status === 204 ? null : res.json();
}

console.log(`=== Wolves of shadows @Verified backfill — guild ${GUILD_ID} ===\n`);
console.log(`Cutoff: members joined before ${new Date(Date.now() - MIN_AGE_MS).toISOString()}\n`);

const members = [];
let after = '0';
while (true) {
    const page = await api('GET', `/guilds/${GUILD_ID}/members?limit=1000&after=${after}`);
    if (page?.__err) { console.error('Member fetch failed:', page.__err); process.exit(1); }
    if (!page || page.length === 0) break;
    members.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
}
console.log(`Fetched ${members.length} member(s).\n`);

const cutoff = Date.now() - MIN_AGE_MS;
const stats = { bots: 0, alreadyVerified: 0, tooNew: 0, granted: 0, errored: 0 };

for (const m of members) {
    const u = m.user;
    if (!u) continue;
    if (u.bot) { stats.bots++; continue; }
    if ((m.roles || []).includes(VERIFIED_ROLE)) { stats.alreadyVerified++; continue; }

    const joinedAt = m.joined_at ? new Date(m.joined_at).getTime() : 0;
    if (!joinedAt || joinedAt > cutoff) {
        stats.tooNew++;
        const ageHrs = joinedAt ? ((Date.now() - joinedAt) / 3600000).toFixed(1) : '?';
        console.log(`  - skip (too new, ${ageHrs}h): ${u.username} (${u.id})`);
        continue;
    }

    const r = await api('PUT', `/guilds/${GUILD_ID}/members/${u.id}/roles/${VERIFIED_ROLE}`);
    if (r?.__err) {
        stats.errored++;
        console.log(`  ✗ ${u.username} (${u.id}): ${r.__err.status} ${r.__err.body.slice(0,150)}`);
    } else {
        stats.granted++;
        console.log(`  ✓ ${u.username} (${u.id}) — joined ${m.joined_at}`);
    }
}

console.log('\n=== Summary ===');
console.log(`  Total members:        ${members.length}`);
console.log(`  Bots (skipped):       ${stats.bots}`);
console.log(`  Already verified:     ${stats.alreadyVerified}`);
console.log(`  Too new (<24h):       ${stats.tooNew}`);
console.log(`  Granted @Verified:    ${stats.granted}`);
console.log(`  Errored:              ${stats.errored}`);

await pool.end();
console.log('\nDone.');
