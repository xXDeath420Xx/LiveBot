/**
 * Surgical upsert of the /manage command only.
 *
 * The bot has 105 commands in code vs Discord's 100-slot application cap, so
 * `deploy-all-commands.js` fails with "Maximum number of application commands
 * reached (100)" on bulk PUT. Discord's "Create" (POST) endpoint, however,
 * treats a command with an existing `name` as an upsert — it replaces that
 * slot without changing the count. We use it to push the new /manage
 * definition (with the hide-results option on `poll create` and the new
 * `poll peek` subcommand) without needing a full redeploy.
 *
 * This updates:
 *   - the main bot's GLOBAL /manage registration
 *   - every custom bot's /manage registration in each guild it serves
 *
 * Pre-existing bug this script does NOT fix: bulk deploys are broken until
 * the command set is trimmed below 100. That's a separate conversation with
 * the owner.
 */
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { resolve, join } from 'path';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const log = (...a) => {
    const ts = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${ts}] ` + a.join(' ') + '\n');
};

// Load the /manage command definition from source.
const manageModule = await import(pathToFileURL(resolve(process.cwd(), 'commands/community/manage.js')).href);
const manageCommand = manageModule.default || manageModule;
const manageData = manageCommand.data?.toJSON ? manageCommand.data.toJSON() : manageCommand.data;
if (!manageData?.name) {
    console.error('Failed to load /manage command definition');
    process.exit(1);
}
log(`Loaded /manage definition — ${(manageData.options || []).length} subcommand groups/subcommands`);

const UA = 'CertiFriedUtility-upsert-manage (https://certifriedmultitool.com, 1.0)';

async function upsert(url, token, label) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': UA,
        },
        body: JSON.stringify(manageData),
    });
    const body = await resp.text();
    if (resp.ok) {
        log(`  ✓ ${label} — HTTP ${resp.status}`);
        return { ok: true };
    }
    if (resp.status === 429) {
        const ra = parseFloat(resp.headers.get('retry-after') || '5');
        log(`  ⏸ ${label} rate-limited, waiting ${ra}s`);
        await new Promise(r => setTimeout(r, (ra + 1) * 1000));
        return upsert(url, token, label);
    }
    log(`  ✗ ${label} — HTTP ${resp.status}: ${body.slice(0, 300)}`);
    return { ok: false, status: resp.status, body };
}

// 1. Main bot global
const mainToken = process.env.DISCORD_TOKEN;
const mainClientId = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
if (!mainToken || !mainClientId) {
    console.error('DISCORD_TOKEN or CLIENT_ID missing from env');
    process.exit(1);
}

log('\n=== MAIN BOT (global) ===');
await upsert(
    `https://discord.com/api/v10/applications/${mainClientId}/commands`,
    mainToken,
    `main bot ${mainClientId}`,
);

// 2. Every custom bot — per guild it serves
log('\n=== CUSTOM BOTS ===');
const [customBots] = await pool.execute(
    'SELECT bot_id, bot_name, bot_token, client_id FROM custom_bots'
);
log(`Found ${customBots.length} custom bot(s)`);

let successCount = 0;
let failCount = 0;

for (const bot of customBots) {
    const [guilds] = await pool.execute(
        'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
        [bot.bot_id]
    );
    if (!guilds.length) continue;

    let token;
    try {
        token = encryption.decrypt(JSON.parse(bot.bot_token));
    } catch (err) {
        log(`[${bot.bot_name}] ✗ decrypt failed: ${err.message}`);
        failCount += guilds.length;
        continue;
    }

    for (const g of guilds) {
        const r = await upsert(
            `https://discord.com/api/v10/applications/${bot.client_id}/guilds/${g.guild_id}/commands`,
            token,
            `${bot.bot_name} @ ${g.guild_id}`,
        );
        if (r.ok) successCount++; else failCount++;
        // small spacing to be gentle
        await new Promise(r => setTimeout(r, 150));
    }
}

log(`\n=== DONE === ${successCount} ok, ${failCount} failed`);
await pool.end();
process.exit(0);
