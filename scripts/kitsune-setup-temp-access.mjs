/**
 * One-shot setup of temporary guest access for the Kitsune guild.
 *
 * REST + DB only, so it is safe to run alongside the live PM2 process (see the
 * competing-sessions rule: a second gateway session with the same token is not).
 *
 * Idempotent. Re-running finds the existing role by name rather than making a
 * second one, and the config write is an upsert.
 */
import dotenv from 'dotenv'; dotenv.config();
import mysql from 'mysql2/promise';

const { resolveBotForGuild } = await import('../utils/bot-resolver.js');

const GUILD_ID = '1469931133981687873';
// The acting bot comes from guild_bot_mapping — never pinned here.
const ROLE_NAME = 'Guest Pass';
// The guild gates every channel on this role; the guest role itself carries no
// permissions, so this is what actually makes the server usable for a guest.
const ACCESS_ROLE_ID = '1498502484912635906'; // @Verified
const TRIAL_HOURS = 24;

const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

try {
    const bot = await resolveBotForGuild(GUILD_ID, { db });
    const BOT_ID = bot.botId;
    const token = bot.token;

    const api = async (path, init = {}) => {
        const res = await fetch(`https://discord.com/api/v10${path}`, {
            ...init,
            headers: {
                Authorization: `Bot ${token}`,
                'Content-Type': 'application/json',
                // ASCII only — the audit-log reason header rejects anything above 255.
                ...(init.reason ? { 'X-Audit-Log-Reason': init.reason } : {}),
                ...init.headers,
            },
        });
        if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${await res.text()}`);
        return res.status === 204 ? null : res.json();
    };

    const roles = await api(`/guilds/${GUILD_ID}/roles`);
    const botRole = roles.find(r => r.managed && r.tags?.bot_id === BOT_ID);
    if (!botRole) throw new Error('could not find the bot\'s own managed role');

    let role = roles.find(r => r.name === ROLE_NAME);
    if (role) {
        console.log(`Role already exists: ${role.name} (${role.id}) at position ${role.position}`);
    } else {
        role = await api(`/guilds/${GUILD_ID}/roles`, {
            method: 'POST',
            reason: 'Temporary guest access system',
            body: JSON.stringify({
                name: ROLE_NAME,
                // Zero permissions on purpose. Access is granted by @Verified;
                // this role exists only so the reaper can tell a guest apart from
                // a member, and so staff can hand out access by hand.
                permissions: '0',
                color: 0xFB923C,
                hoist: false,
                mentionable: false,
            }),
        });
        console.log(`Created role ${role.name} (${role.id})`);
    }

    if (role.position >= botRole.position) {
        console.warn(`WARNING: ${ROLE_NAME} (pos ${role.position}) is not below the bot role (pos ${botRole.position}); the bot cannot assign it.`);
    }

    const verified = roles.find(r => r.id === ACCESS_ROLE_ID);
    if (!verified) throw new Error(`access role ${ACCESS_ROLE_ID} not found in this guild`);
    if (verified.position >= botRole.position) {
        console.warn(`WARNING: ${verified.name} (pos ${verified.position}) is not below the bot role; the bot cannot grant it.`);
    }

    await db.execute(`
        INSERT INTO temp_access_config
            (guild_id, enabled, temp_role_id, access_role_ids, trial_hours, dm_on_kick, keep_role_on_pass, log_channel_id, created_by)
        VALUES (?, 1, ?, ?, ?, 1, 0, NULL, 'setup-script')
        ON DUPLICATE KEY UPDATE
            enabled = 1, temp_role_id = VALUES(temp_role_id),
            access_role_ids = VALUES(access_role_ids), trial_hours = VALUES(trial_hours)
    `, [GUILD_ID, role.id, JSON.stringify([ACCESS_ROLE_ID]), TRIAL_HOURS]);

    const [[cfg]] = await db.execute('SELECT * FROM temp_access_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('\nConfig written:');
    console.log(`  guest role     ${cfg.temp_role_id}  (${ROLE_NAME})`);
    console.log(`  also granted   ${cfg.access_role_ids}  (@${verified.name})`);
    console.log(`  trial          ${cfg.trial_hours}h`);
    console.log(`  DM on removal  ${cfg.dm_on_kick ? 'yes' : 'no'}`);
    console.log(`  role on pass   ${cfg.keep_role_on_pass ? 'kept' : 'removed'}`);
    console.log('\nNext: /systems temp-access invite  to mint a link tied to this role.');
} catch (err) {
    console.error('Setup FAILED:', err.message);
    process.exitCode = 1;
} finally {
    await db.end();
}
