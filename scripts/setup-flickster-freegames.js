/**
 * Free Games system for Flickster's House:
 *   - #free-games channel in 💬 Community (Verified-only, bot-post-only)
 *   - 🎮 Free Games notification role (opt-in)
 *   - free_games_subscriptions row with that role as mention
 *   - Rebuild the Notifications panel in #roles to include the new opt-in
 */
import dotenv from 'dotenv';
dotenv.config();
import {
    Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';
const VERIFIED_ROLE = '1502814371502624858';

// Existing notification roles we'll keep on the panel
const ANNOUNCE_ROLE     = '1502814374837096498'; // 📢 Announcements
const GIVEAWAYS_ROLE    = '1502814375386284104'; // 🎉 Giveaways
const STREAM_PINGS_ROLE = '1502814376367882323'; // 🔔 Stream Pings

async function main() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        ],
    });
    await client.login(token);
    await new Promise(r => client.once('ready', r));
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    await guild.roles.fetch();
    const log = (m) => console.log(`[FreeGames] ${m}`);

    const everyoneId = guild.id;
    const botId = client.user.id;

    const catCommunity = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === '💬 Community');
    const chRoles = guild.channels.cache.find(c => c.name === 'roles');
    if (!catCommunity || !chRoles) { console.error('Missing #roles or 💬 Community'); process.exit(1); }

    // 1. Free Games role
    let freeGamesRole = guild.roles.cache.find(r => r.name === '🎮 Free Games');
    if (!freeGamesRole) {
        freeGamesRole = await guild.roles.create({
            name: '🎮 Free Games', color: 0x95A5A6, mentionable: true,
            reason: 'Free games notification opt-in',
        });
        log(`+ Created role "🎮 Free Games" (${freeGamesRole.id})`);
    } else {
        log(`✓ Role "🎮 Free Games" exists (${freeGamesRole.id})`);
    }

    // 2. #free-games channel — Verified can view, only bot posts
    let chFreeGames = guild.channels.cache.find(c => c.name === 'free-games' && c.parentId === catCommunity.id);
    if (!chFreeGames) {
        chFreeGames = await guild.channels.create({
            name: 'free-games', type: ChannelType.GuildText, parent: catCommunity.id,
            permissionOverwrites: [
                { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
                { id: VERIFIED_ROLE, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
                { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.ManageMessages] },
            ],
        });
        log(`+ Created channel #${chFreeGames.name} (${chFreeGames.id})`);
    } else {
        log(`✓ Channel #${chFreeGames.name} exists (${chFreeGames.id})`);
    }

    // 3. free_games_subscriptions row
    const [existing] = await pool.execute(
        'SELECT id FROM free_games_subscriptions WHERE guild_id = ? AND discord_channel_id = ?',
        [GUILD_ID, chFreeGames.id]
    );
    if (existing.length) {
        await pool.execute(
            `UPDATE free_games_subscriptions SET
                mention_role_id = ?, custom_message = NULL,
                notify_free = 1, notify_weekend = 0, notify_dlc = 0,
                filter_steam = 1, filter_epic = 1, filter_gog = 1, filter_humble = 1, filter_prime = 1,
                filter_windows = 1, is_enabled = 1
             WHERE guild_id = ? AND discord_channel_id = ?`,
            [freeGamesRole.id, GUILD_ID, chFreeGames.id]
        );
        log(`✓ Updated free_games_subscriptions row`);
    } else {
        await pool.execute(
            `INSERT INTO free_games_subscriptions (
                guild_id, discord_channel_id, mention_role_id, custom_message,
                notify_free, notify_weekend, notify_dlc,
                filter_steam, filter_epic, filter_gog, filter_humble, filter_prime,
                filter_windows, is_enabled
            ) VALUES (?, ?, ?, NULL, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1)`,
            [GUILD_ID, chFreeGames.id, freeGamesRole.id]
        );
        log(`+ Inserted free_games_subscriptions row`);
    }
    log(`  Stores: Steam · Epic · GOG · Humble · Prime`);
    log(`  Platform: Windows | Types: Free to Keep`);
    log(`  Mention role: 🎮 Free Games`);

    // 4. Rebuild Notifications panel — add 🎮 Free Games as the 4th button
    const [[notifPanel]] = await pool.execute(
        `SELECT id, channel_id, message_id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = 'notifications' ORDER BY id DESC LIMIT 1`,
        [GUILD_ID]
    );
    if (notifPanel) {
        // Delete the old panel message
        try {
            const oldCh = await guild.channels.fetch(notifPanel.channel_id);
            const oldMsg = await oldCh.messages.fetch(notifPanel.message_id).catch(() => null);
            if (oldMsg) await oldMsg.delete().catch(() => {});
        } catch {}

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('🔔 Notification Roles')
            .setDescription('Click a button to toggle. Get pinged when stuff happens.')
            .addFields(
                { name: '📢 Announcements', value: 'Server announcements & updates',  inline: true },
                { name: '🎉 Giveaways',     value: 'Get pinged for giveaways',         inline: true },
                { name: '🔔 Stream Pings',  value: 'Get pinged when streamers go live', inline: true },
                { name: '🎮 Free Games',    value: 'Get pinged for new free games',    inline: true },
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`rr_${ANNOUNCE_ROLE}`).setLabel('Announcements').setEmoji('📢').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`rr_${GIVEAWAYS_ROLE}`).setLabel('Giveaways').setEmoji('🎉').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`rr_${STREAM_PINGS_ROLE}`).setLabel('Stream Pings').setEmoji('🔔').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`rr_${freeGamesRole.id}`).setLabel('Free Games').setEmoji('🎮').setStyle(ButtonStyle.Primary),
        );

        const newMsg = await chRoles.send({ embeds: [embed], components: [row] });
        await pool.execute(
            `UPDATE reaction_role_panels SET message_id = ?, channel_id = ? WHERE id = ?`,
            [newMsg.id, chRoles.id, notifPanel.id]
        );

        // Reset and reseed mappings
        await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [notifPanel.id]);
        const mappings = [
            { roleId: ANNOUNCE_ROLE,     emoji: '📢', label: 'Announcements' },
            { roleId: GIVEAWAYS_ROLE,    emoji: '🎉', label: 'Giveaways' },
            { roleId: STREAM_PINGS_ROLE, emoji: '🔔', label: 'Stream Pings' },
            { roleId: freeGamesRole.id,  emoji: '🎮', label: 'Free Games' },
        ];
        for (const m of mappings) {
            await pool.execute(
                `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?, ?, ?, ?, 'primary')`,
                [notifPanel.id, m.roleId, m.emoji, m.label]
            );
        }
        log(`✓ Notifications panel rebuilt with Free Games button (msg ${newMsg.id})`);
    } else {
        log(`! No existing notifications panel found — Free Games role created but not added to a panel`);
    }

    console.log('\n' + '═'.repeat(50));
    console.log('FREE GAMES SETUP COMPLETE');
    console.log('═'.repeat(50));
    console.log(`Channel: #${chFreeGames.name}`);
    console.log(`Opt-in role: 🎮 Free Games (added to #roles panel)`);
    console.log(`Stores: Steam, Epic, GOG, Humble, Prime`);
    console.log(`Run /alerts freegames check to test, /alerts freegames current to see active deals`);
    console.log('═'.repeat(50));

    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
