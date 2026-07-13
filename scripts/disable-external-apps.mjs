import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });
import pool from '/home/death/CertiFriedUtility/utils/db.js';
import encryption from '/home/death/CertiFriedUtility/utils/encryption.js';
import { PermissionsBitField } from 'discord.js';

const DRY_RUN = process.env.DRY_RUN === '1';
const USE_EXTERNAL_APPS = PermissionsBitField.Flags.UseExternalApps;
const API_BASE = 'https://discord.com/api/v10';
const RATE_LIMIT_MS = 300;

if (DRY_RUN) console.log('=== DRY RUN ===\n');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function discordFetch(path, token, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json', 'X-Audit-Log-Reason': 'Disable Use External Apps permission', ...options.headers },
    });
    if (res.status === 429) {
        const retry = res.headers.get('Retry-After');
        const waitMs = retry ? parseFloat(retry) * 1000 : 5000;
        console.log(`  Rate limited, waiting ${Math.ceil(waitMs)}ms...`);
        await sleep(waitMs + 100);
        return discordFetch(path, token, options);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Discord API ${res.status}: ${body.substring(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

// Get all bot tokens
const [mappings] = await pool.execute('SELECT DISTINCT guild_id, bot_id FROM guild_bot_mapping');
const guildBotMap = Object.fromEntries(mappings.map(r => [r.guild_id, r.bot_id]));

const botIds = [...new Set(Object.values(guildBotMap))];
const botTokens = {};

if (botIds.length) {
    const [bots] = await pool.execute(
        `SELECT bot_id, bot_token FROM custom_bots WHERE bot_id IN (${botIds.map(() => '?').join(',')})`, botIds
    );
    for (const bot of bots) {
        botTokens[bot.bot_id] = encryption.decrypt(JSON.parse(bot.bot_token));
    }
}
botTokens['main'] = process.env.DISCORD_TOKEN;

// Get bot user IDs
const botUserIds = {};
for (const [botId, token] of Object.entries(botTokens)) {
    try {
        const me = await discordFetch('/users/@me', token);
        botUserIds[botId] = me.id;
        console.log(`Bot ${botId}: ${me.username} (${me.id})`);
    } catch (e) {
        console.log(`Bot ${botId}: failed — ${e.message}`);
    }
}

// Get all guilds across all bots
let allGuilds = [];
for (const [botId, token] of Object.entries(botTokens)) {
    try {
        const guilds = await discordFetch('/users/@me/guilds?limit=200', token);
        for (const g of guilds) {
            if (!allGuilds.find(x => x.id === g.id)) {
                const effectiveBotId = guildBotMap[g.id] || 'main';
                allGuilds.push({ ...g, botId: effectiveBotId });
            }
        }
    } catch (e) {
        console.log(`Failed to list guilds for bot ${botId}: ${e.message}`);
    }
}

console.log(`\nProcessing ${allGuilds.length} guilds...\n`);

let totalModified = 0;
let totalSkipped = 0;

for (const guild of allGuilds) {
    const token = botTokens[guild.botId];
    if (!token) { console.log(`[${guild.name}] No token for bot ${guild.botId}, skipping`); continue; }

    try {
        const roles = await discordFetch(`/guilds/${guild.id}/roles`, token);
        const botMember = await discordFetch(`/guilds/${guild.id}/members/${botUserIds[guild.botId]}`, token);
        const botHighestRolePos = Math.max(...botMember.roles.map(rId => {
            const r = roles.find(x => x.id === rId);
            return r ? r.position : 0;
        }), 0);

        let modified = 0;
        let skipped = 0;

        for (const role of roles) {
            // Skip @everyone (handled separately), admin roles, and managed roles
            const perms = BigInt(role.permissions);
            const isAdmin = (perms & PermissionsBitField.Flags.Administrator) !== 0n;
            const hasExternalApps = (perms & USE_EXTERNAL_APPS) !== 0n;

            if (!hasExternalApps) { continue; } // Already disabled
            if (isAdmin) { skipped++; continue; } // Admin bypass — leave alone
            if (role.managed) { skipped++; continue; } // Bot/integration role — can't edit
            if (role.position >= botHighestRolePos) { skipped++; continue; } // Above bot's role

            // Remove USE_EXTERNAL_APPS from permissions
            const newPerms = (perms & ~USE_EXTERNAL_APPS).toString();

            if (DRY_RUN) {
                console.log(`  [${guild.name}] WOULD modify role: ${role.name}`);
                modified++;
            } else {
                try {
                    await discordFetch(`/guilds/${guild.id}/roles/${role.id}`, token, {
                        method: 'PATCH',
                        body: JSON.stringify({ permissions: newPerms }),
                    });
                    console.log(`  [${guild.name}] Modified: ${role.name}`);
                    modified++;
                    await sleep(RATE_LIMIT_MS);
                } catch (e) {
                    console.log(`  [${guild.name}] Failed to modify ${role.name}: ${e.message}`);
                }
            }
        }

        // Also handle @everyone role
        const everyoneRole = roles.find(r => r.id === guild.id);
        if (everyoneRole) {
            const perms = BigInt(everyoneRole.permissions);
            if ((perms & USE_EXTERNAL_APPS) !== 0n) {
                const newPerms = (perms & ~USE_EXTERNAL_APPS).toString();
                if (DRY_RUN) {
                    console.log(`  [${guild.name}] WOULD modify @everyone`);
                    modified++;
                } else {
                    try {
                        await discordFetch(`/guilds/${guild.id}/roles/${guild.id}`, token, {
                            method: 'PATCH',
                            body: JSON.stringify({ permissions: newPerms }),
                        });
                        console.log(`  [${guild.name}] Modified: @everyone`);
                        modified++;
                        await sleep(RATE_LIMIT_MS);
                    } catch (e) {
                        console.log(`  [${guild.name}] Failed to modify @everyone: ${e.message}`);
                    }
                }
            }
        }

        if (modified > 0 || skipped > 0) {
            console.log(`  [${guild.name}] ${DRY_RUN ? 'Would modify' : 'Modified'}: ${modified} roles, skipped: ${skipped} (admin/managed/above bot)`);
        }
        totalModified += modified;
        totalSkipped += skipped;
    } catch (e) {
        console.log(`  [${guild.name}] Error: ${e.message}`);
    }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`${DRY_RUN ? 'DRY RUN' : 'DONE'}`);
console.log(`  Roles modified: ${totalModified}`);
console.log(`  Roles skipped: ${totalSkipped} (admin/managed/above bot)`);
console.log(`  Guilds processed: ${allGuilds.length}`);
console.log(`${'═'.repeat(50)}`);

await pool.end();
