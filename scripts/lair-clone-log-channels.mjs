// Clone + delete log channels to wipe all historical bot-spam in one shot.
// Runs with bot OFFLINE (PM2 stopped) so no log-manager double-echo.
//
// Strategy per channel:
//   1. GET full channel config
//   2. POST clone into same category with same perms/topic/slowmode/nsfw
//   3. PATCH new channel to old position
//   4. UPDATE logging_config / log_event_config to new id
//   5. DELETE old channel (wipes everything server-side)
import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD = '1216126780767731722';
const oldToken = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + oldToken, 'Content-Type': 'application/json' };

const TARGET_NAME_SUBSTRINGS = ['member-log', 'message-log', 'mod-log', 'channel-log', 'role-log'];

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

async function rest(method, url, body) {
    for (let i = 0; i < 6; i++) {
        const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
        if (r.status === 429) {
            const b = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 150));
            continue;
        }
        if (r.status === 404) return { __notfound: true };
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.log(`  ${method} ${url.slice(-70)}: ${r.status} ${t.slice(0, 200)}`);
            return null;
        }
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return null;
}

// Fetch all channels
const channels = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
const targets = channels.filter(c => [0, 5].includes(c.type)
    && TARGET_NAME_SUBSTRINGS.some(s => c.name.toLowerCase().includes(s)));
console.log(`targets (${targets.length}):`);
for (const c of targets) console.log(`  ${c.name} (${c.id}) type=${c.type} pos=${c.position} parent=${c.parent_id}`);

if (!targets.length) { console.log('no matches — abort'); process.exit(0); }

const remap = []; // { oldId, newId, name }
for (const old of targets) {
    console.log(`\n-- cloning #${old.name} --`);
    // Clone payload
    const payload = {
        name: old.name,
        type: old.type,
        topic: old.topic || undefined,
        nsfw: old.nsfw || false,
        rate_limit_per_user: old.rate_limit_per_user || 0,
        parent_id: old.parent_id || undefined,
        permission_overwrites: old.permission_overwrites || [],
        default_auto_archive_duration: old.default_auto_archive_duration || undefined,
    };
    const created = await rest('POST',
        `https://discord.com/api/v10/guilds/${GUILD}/channels`, payload);
    if (!created?.id) { console.log(`  CLONE FAILED, skipping`); continue; }
    console.log(`  cloned → ${created.id}`);

    // Set position to match old
    await rest('PATCH', `https://discord.com/api/v10/channels/${created.id}`,
        { position: old.position });

    remap.push({ oldId: old.id, newId: created.id, name: old.name });

    // Update DB references
    try {
        // logging_config has per-event columns (log_member_events_channel_id, log_message_events_channel_id, ...)
        const [cols] = await pool.execute(`SHOW COLUMNS FROM logging_config WHERE Field LIKE '%channel_id'`);
        for (const c of cols) {
            const [r] = await pool.execute(
                `UPDATE logging_config SET \`${c.Field}\` = ? WHERE guild_id = ? AND \`${c.Field}\` = ?`,
                [created.id, GUILD, old.id]);
            if (r.affectedRows) console.log(`  logging_config.${c.Field}: ${old.id} → ${created.id}`);
        }
        // log_event_config (per-event overrides)
        const [r2] = await pool.execute(
            `UPDATE log_event_config SET channel_id = ? WHERE guild_id = ? AND channel_id = ?`,
            [created.id, GUILD, old.id]);
        if (r2.affectedRows) console.log(`  log_event_config.channel_id: ${r2.affectedRows} rows → ${created.id}`);
    } catch (e) { console.log(`  DB update err: ${e.message}`); }

    // Delete old
    const del = await rest('DELETE', `https://discord.com/api/v10/channels/${old.id}`);
    if (del?.__ok || del?.id) console.log(`  deleted old ${old.id}`);
    else console.log(`  DELETE old failed: ${JSON.stringify(del)?.slice(0,120)}`);
}

console.log(`\n== remap ==`);
for (const r of remap) console.log(`  ${r.name}: ${r.oldId} → ${r.newId}`);

console.log('\nDONE');
await pool.end();
