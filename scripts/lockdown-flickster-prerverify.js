/**
 * Lock down everything except #rules for unverified users in Flickster's House.
 * After this, a fresh joiner sees ONLY #rules (and their permitted system channels).
 * Clicking ✅ I Agree grants Verified, which then unlocks #welcome / #roles / community.
 */
import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';
const VERIFIED_ROLE = '1502814371502624858'; // ✅ Verified

async function main() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
    await client.login(token);
    await new Promise(r => client.once('ready', r));
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    const log = (m) => console.log(`[Lockdown] ${m}`);

    const verifiedRole = guild.roles.cache.get(VERIFIED_ROLE);
    if (!verifiedRole) { console.error('Verified role not found'); process.exit(1); }
    log(`Verified role: ${verifiedRole.name} (${verifiedRole.id})`);

    const rulesCh = guild.channels.cache.find(c => c.name === 'rules' && c.type === ChannelType.GuildText);
    log(`Rules channel: #${rulesCh?.name} (${rulesCh?.id}) — leaving public`);

    let lockedDown = 0, alreadyLocked = 0;
    for (const [, ch] of guild.channels.cache) {
        if (ch.id === rulesCh?.id) continue; // public

        // Skip Discord-managed channels we can't safely gate (rules screening, system channels, AFK)
        if (ch.id === guild.rulesChannelId || ch.id === guild.publicUpdatesChannelId || ch.id === guild.afkChannelId || ch.id === guild.systemChannelId) {
            log(`  - skipping system channel #${ch.name} (${ch.id})`);
            continue;
        }

        // Inspect current @everyone overwrite
        const everyoneOw = ch.permissionOverwrites?.cache?.get(guild.id);
        const denyView = everyoneOw && (everyoneOw.deny.bitfield & PermissionFlagsBits.ViewChannel);
        if (denyView) { alreadyLocked++; continue; }

        try {
            await ch.permissionOverwrites.edit(guild.id, { ViewChannel: false }, { reason: 'Pre-verify lockdown: only #rules visible until Verified' });
            await ch.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: true }, { reason: 'Pre-verify lockdown: Verified unlocks all gated channels' });
            lockedDown++;
            log(`  + locked #${ch.name} (${ch.id})`);
        } catch (e) {
            log(`  ! failed #${ch.name}: ${e.message}`);
        }
    }
    log(`Locked ${lockedDown} channels; ${alreadyLocked} were already gated`);

    // Belt-and-suspenders: ensure #rules ITSELF is open to @everyone
    if (rulesCh) {
        await rulesCh.permissionOverwrites.edit(guild.id, {
            ViewChannel: true, ReadMessageHistory: true, SendMessages: false,
        }, { reason: 'Rules channel: visible to everyone, read-only' });
        log(`  ✓ #rules: @everyone can view, cannot send`);
    }

    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
