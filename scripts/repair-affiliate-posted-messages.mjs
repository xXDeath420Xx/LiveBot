/**
 * Correct the (Affiliate)/(Non-Affiliate) tag on community-support confirmation embeds
 * the bot already posted, after scripts/repair-affiliate-backlog.mjs has fixed the DB.
 *
 * Only the tag is rewritten — the surrounding description, point totals, target order
 * and every other embed field are left byte-for-byte identical. Lines are synced to the
 * current DB value, so a message listing several targets keeps the ones that were
 * already right.
 *
 * Usage:
 *   node scripts/repair-affiliate-posted-messages.mjs             # dry run, 7 days
 *   node scripts/repair-affiliate-posted-messages.mjs --apply
 *   node scripts/repair-affiliate-posted-messages.mjs --days=30 --apply
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const daysArg = process.argv.find(a => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;

// Confirmations whose source message was deleted were sent as a plain channel message,
// so they carry no message_reference to match on. Map them to their entry explicitly.
const ORPHANS = { '1534018604700401886': '1534004327423938592' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(token, path, init = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const res = await fetch(`https://discord.com/api/v10${path}`, {
            ...init,
            headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
        });
        if (res.status === 429) {
            const body = await res.json().catch(() => ({}));
            await sleep(((body.retry_after ?? 1) * 1000) + 250);
            continue;
        }
        if (!res.ok) throw new Error(`${res.status} ${path} ${(await res.text()).slice(0, 200)}`);
        return res.status === 204 ? null : res.json();
    }
    throw new Error(`rate limited out on ${path}`);
}

async function scanChannel(token, channelId) {
    let before = null, all = [], pages = 0;
    while (pages < 10) {
        const m = await api(token, `/channels/${channelId}/messages?limit=100${before ? '&before=' + before : ''}`);
        all.push(...m);
        if (m.length < 100) break;
        before = m[m.length - 1].id;
        pages++;
        await sleep(200);
    }
    return all;
}

const tagOf = isAff => (isAff ? 'Affiliate' : 'Non-Affiliate');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Old handle -> new handle, for targets that were rebound to their real Twitch account
 * (see scripts/rebind-twitch-handle.mjs). The DB now carries the new login while the
 * already-posted embed still shows the old one, so a tag-only rewrite would never match.
 * Loaded from the same --map=<file.json> the rebind tool takes.
 */
let RENAMES = new Map();

/** Rewrite only the tag for `username`, leaving everything else untouched. */
function retag(description, username, isAffiliate) {
    const want = tagOf(isAffiliate);
    const other = tagOf(!isAffiliate);
    const re = new RegExp(`(\\*\\*${esc(username)}\\*\\*\\s*\\()${other}(\\))`, 'gi');
    return description.replace(re, `$1${want}$2`);
}

/**
 * Rewrite `**oldName** (AnyTag)` to `**newName** (correct tag)`. Used when the target was
 * bound to the wrong Twitch account: both the handle and the tag in the public embed are
 * wrong, and the handle must change for the tag to mean anything.
 */
function rename(description, oldName, newName, isAffiliate) {
    const re = new RegExp(`\\*\\*${esc(oldName)}\\*\\*(\\s*\\()(?:Affiliate|Non-Affiliate)(\\))`, 'gi');
    return description.replace(re, `**${newName}**$1${tagOf(isAffiliate)}$2`);
}

async function main() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME
    });

    console.log(`\n=== Posted-message tag repair — last ${DAYS} day(s) — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

    const mapArg = process.argv.find(a => a.startsWith('--map='));
    if (mapArg) {
        const { readFile } = await import('node:fs/promises');
        const jobs = JSON.parse(await readFile(mapArg.split('=')[1], 'utf8'));
        RENAMES = new Map(jobs.filter(j => j.wrong).map(j => [j.twitch.toLowerCase(), j.wrong]));
        console.log(`rename map: ${[...RENAMES].map(([n, o]) => `${o} -> ${n}`).join(', ')}\n`);
    }

    const [entries] = await db.execute(
        `SELECT guild_id, channel_id, message_id, target_username, target_is_affiliate
         FROM community_support_entries
         WHERE created_at > NOW() - INTERVAL ? DAY`,
        [DAYS]
    );

    // Re-confirm every target against Twitch right now. A posted message is public and
    // durable, so we only rewrite a tag we can prove — never one resting on a DB flag
    // whose account no longer resolves (renamed/deleted), and never one where the DB
    // and Twitch disagree.
    const { getTwitchUsers } = await import('../utils/platforms/twitch-api.js');
    const logins = [...new Set(entries.map(e => (e.target_username || '').toLowerCase()).filter(Boolean))];
    const truth = new Map();
    for (const u of await getTwitchUsers(logins)) {
        truth.set(u.login.toLowerCase(), u.broadcaster_type === 'affiliate' || u.broadcaster_type === 'partner');
    }

    const unverifiable = logins.filter(l => !truth.has(l));
    if (unverifiable.length) {
        console.log(`SKIPPING (Twitch cannot resolve, tag left as posted): ${unverifiable.join(', ')}\n`);
    }

    // message_id -> [{username, isAffiliate}]
    const wanted = new Map();
    const conflicts = [];
    for (const e of entries) {
        const login = (e.target_username || '').toLowerCase();
        if (!truth.has(login)) continue;
        const live = truth.get(login);
        if (live !== !!e.target_is_affiliate) {
            conflicts.push(`${e.target_username}: db=${!!e.target_is_affiliate} twitch=${live}`);
            continue;
        }
        if (!wanted.has(e.message_id)) wanted.set(e.message_id, []);
        wanted.get(e.message_id).push({ username: e.target_username, isAffiliate: live });
    }
    if (conflicts.length) {
        console.log(`SKIPPING (db disagrees with Twitch — run repair-affiliate-backlog.mjs first):`);
        for (const c of [...new Set(conflicts)]) console.log(`  ${c}`);
        console.log('');
    }

    // Resolve the token for each guild: custom bot if mapped, else the main bot.
    const [mappings] = await db.execute('SELECT guild_id, bot_id FROM guild_bot_mapping');
    const botForGuild = new Map(mappings.map(m => [m.guild_id, m.bot_id]));
    const enc = await import('../utils/encryption.js');
    const tokenCache = new Map();
    async function tokenFor(guildId) {
        if (tokenCache.has(guildId)) return tokenCache.get(guildId);
        const botId = botForGuild.get(guildId);
        let token = process.env.DISCORD_TOKEN;
        if (botId) {
            const [rows] = await db.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [botId]);
            if (rows.length) token = (enc.default || enc).decrypt(JSON.parse(rows[0].bot_token));
        }
        tokenCache.set(guildId, token);
        return token;
    }

    const channels = [...new Set(entries.map(e => `${e.guild_id}|${e.channel_id}`))];
    let edited = 0, alreadyOk = 0;

    for (const key of channels) {
        const [guildId, channelId] = key.split('|');
        const token = await tokenFor(guildId);
        const msgs = await scanChannel(token, channelId).catch(err => {
            console.log(`  ! cannot scan channel ${channelId}: ${err.message}`);
            return [];
        });

        for (const m of msgs) {
            if (!m.author.bot || !m.embeds?.length) continue;
            const srcId = m.message_reference?.message_id || ORPHANS[m.id];
            if (!srcId || !wanted.has(srcId)) continue;

            const embed = m.embeds[0];
            const before = embed.description || '';
            let after = before;
            for (const t of wanted.get(srcId)) {
                // Rebound targets need the stale handle swapped first — the tag rewrite
                // keys on the username, so it cannot match until the name is current.
                const old = RENAMES.get(t.username.toLowerCase());
                if (old) after = rename(after, old, t.username, t.isAffiliate);
                after = retag(after, t.username, t.isAffiliate);
            }

            if (after === before) { alreadyOk++; continue; }

            const changedLines = after.split('\n')
                .filter((l, i) => l !== before.split('\n')[i])
                .map(l => l.trim());
            console.log(`  ${m.id} (src ${srcId})`);
            for (const l of changedLines) console.log(`     -> ${l}`);

            if (APPLY) {
                await api(token, `/channels/${channelId}/messages/${m.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ embeds: [{ ...embed, description: after }] })
                });
                await sleep(400);
            }
            edited++;
        }
    }

    console.log(`\nembeds ${APPLY ? 'edited' : 'to edit'}: ${edited}`);
    console.log(`already correct: ${alreadyOk}`);
    if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.\n');

    await db.end();
}

main().catch(err => {
    console.error('FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
