/**
 * Setup script for YYZ Studio (961514092848382043)
 * Replaces SteamWatch + Tickets v2 with CertiFried's steam-watcher-manager and ticket system.
 *
 * Part 1: Steam watchers for 4 games (app_news)
 * Part 2: Per-game ticket panels in each game category (Developer role)
 * Part 3: Server support panel in #📩︱tickets (Mod Perms role)
 * Part 4: Cleanup summary
 *
 * Usage: node scripts/setup-yyz-steam-tickets.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_ID = '1345684217438273577';
const GUILD_ID = '961514092848382043';

// ── Role IDs ──────────────────────────────────────────────────────────────
const DEVELOPER_ROLE = '1001536111979544576';
const MOD_PERMS_ROLE = '1352488296495841340';
const TICKET_LOG_CHANNEL = '1353883718095474779';

// ── Steam Games ───────────────────────────────────────────────────────────
const STEAM_GAMES = [
    { name: 'Havendock',   appId: '2020710',  channelId: '1345469710904463511' },
    { name: 'Stormbridge', appId: '3362750',  channelId: '1345470051763093504' },
    { name: 'Last Fuse',   appId: '3558060',  channelId: '1345494024144027730' },
    { name: 'Siegeturtle',  appId: '3959050',  channelId: '1401917456720859228' },
];

// ── Game Categories (for ticket panels) ───────────────────────────────────
const GAME_CATEGORIES = [
    { name: 'Havendock',    categoryId: '1345461112736321566', slug: 'havendock' },
    { name: 'Stormbridge',  categoryId: '1345464291570094191', slug: 'stormbridge' },
    { name: 'Last Fuse',    categoryId: '1345493667829256242', slug: 'last-fuse' },
    { name: 'Siegeturtle',  categoryId: '1401917204827603026', slug: 'siegeturtle' },
    { name: 'Astral Bloom', categoryId: '1477098489736593488', slug: 'astral-bloom' },
];

// ── Server Support ────────────────────────────────────────────────────────
const TICKETS_CHANNEL = '1345463513996328970';       // #📩︱tickets
const SUPPORT_CATEGORY = '1353868683834953830';       // ▬▬ Support ▬▬

async function setup() {
    // ── Connect via encrypted bot token ───────────────────────────────────
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
        ]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.error('Guild not found'); process.exit(1); }

    // ==================================================================
    // PART 1: STEAM WATCHERS
    // ==================================================================
    console.log('='.repeat(50));
    console.log('PART 1: STEAM WATCHERS');
    console.log('='.repeat(50));

    for (const game of STEAM_GAMES) {
        // Idempotency check
        const [existing] = await pool.execute(
            `SELECT id FROM steam_watchers
             WHERE guild_id = ? AND discord_channel_id = ? AND watcher_type = ? AND steam_id = ?`,
            [GUILD_ID, game.channelId, 'app_news', game.appId]
        );

        if (existing.length > 0) {
            console.log(`  [skip] ${game.name} (${game.appId}) — already exists (id: ${existing[0].id})`);
            continue;
        }

        await pool.execute(
            `INSERT INTO steam_watchers
                (guild_id, discord_channel_id, watcher_type, steam_id, steam_name,
                 mention_role_ids, mention_user_ids, check_interval_minutes, is_enabled)
             VALUES (?, ?, 'app_news', ?, ?, NULL, NULL, 5, TRUE)`,
            [GUILD_ID, game.channelId, game.appId, game.name]
        );
        console.log(`  [+] ${game.name} (${game.appId}) → #updates channel ${game.channelId}`);
    }

    // ==================================================================
    // PART 2: PER-GAME TICKET PANELS (Developer Role)
    // ==================================================================
    console.log('\n' + '='.repeat(50));
    console.log('PART 2: PER-GAME TICKET PANELS');
    console.log('='.repeat(50));

    for (const game of GAME_CATEGORIES) {
        // Step 2a: Create #📩︱support channel in game category
        const category = guild.channels.cache.get(game.categoryId);
        if (!category) {
            console.error(`  [!] Category not found for ${game.name} (${game.categoryId}), skipping`);
            continue;
        }

        // Check if channel already exists in this category
        const existingChannel = guild.channels.cache.find(
            c => c.parentId === game.categoryId && c.name === '📩︱support'
        );

        let supportChannel;
        if (existingChannel) {
            supportChannel = existingChannel;
            console.log(`  [skip] #📩︱support already exists in ${game.name} (${existingChannel.id})`);
        } else {
            supportChannel = await guild.channels.create({
                name: '📩︱support',
                type: ChannelType.GuildText,
                parent: game.categoryId,
            });
            console.log(`  [+] Created #📩︱support in ${game.name} category (${supportChannel.id})`);
        }

        // Step 2b: Check if panel already exists for this channel
        const [existingPanels] = await pool.execute(
            `SELECT panel_id FROM ticket_panels WHERE guild_id = ? AND panel_channel_id = ? AND panel_name = ?`,
            [GUILD_ID, supportChannel.id, `${game.name} Support`]
        );

        let panelId;
        if (existingPanels.length > 0) {
            panelId = existingPanels[0].panel_id;
            console.log(`  [skip] Panel "${game.name} Support" already exists (id: ${panelId})`);
        } else {
            const [result] = await pool.execute(
                `INSERT INTO ticket_panels
                    (guild_id, panel_name, panel_channel_id, embed_title, embed_description,
                     embed_color, button_text, button_emoji, ticket_category_id,
                     support_role_id, ticket_name_format, save_transcripts, log_channel_id, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
                [
                    GUILD_ID,
                    `${game.name} Support`,
                    supportChannel.id,
                    `${game.name} Support`,
                    `Having an issue with **${game.name}**? Click below to open a ticket and the developer will help you out.`,
                    '#5865F2',
                    `Open ${game.name} Ticket`,
                    '📩',
                    game.categoryId,       // tickets created inside game category
                    DEVELOPER_ROLE,
                    `${game.slug}-{username}`,
                    TICKET_LOG_CHANNEL,
                ]
            );
            panelId = result.insertId;
            console.log(`  [+] Panel "${game.name} Support" created (id: ${panelId})`);
        }

        // Step 2c: Deploy panel (send embed + button, store message ID)
        await deployPanel(supportChannel, panelId, {
            title: `${game.name} Support`,
            description: `Having an issue with **${game.name}**? Click below to open a ticket and the developer will help you out.`,
            color: '#5865F2',
            buttonText: `Open ${game.name} Ticket`,
            buttonEmoji: '📩',
        });
    }

    // ==================================================================
    // PART 3: SERVER SUPPORT PANEL (Mod Perms Role)
    // ==================================================================
    console.log('\n' + '='.repeat(50));
    console.log('PART 3: SERVER SUPPORT PANEL');
    console.log('='.repeat(50));

    const ticketsChannel = guild.channels.cache.get(TICKETS_CHANNEL);
    if (!ticketsChannel) {
        console.error('  [!] #📩︱tickets channel not found!');
    } else {
        const [existingServer] = await pool.execute(
            `SELECT panel_id FROM ticket_panels WHERE guild_id = ? AND panel_channel_id = ? AND panel_name = ?`,
            [GUILD_ID, TICKETS_CHANNEL, 'Server Support']
        );

        let serverPanelId;
        if (existingServer.length > 0) {
            serverPanelId = existingServer[0].panel_id;
            console.log(`  [skip] Panel "Server Support" already exists (id: ${serverPanelId})`);
        } else {
            const [result] = await pool.execute(
                `INSERT INTO ticket_panels
                    (guild_id, panel_name, panel_channel_id, embed_title, embed_description,
                     embed_color, button_text, button_emoji, ticket_category_id,
                     support_role_id, ticket_name_format, save_transcripts, log_channel_id, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
                [
                    GUILD_ID,
                    'Server Support',
                    TICKETS_CHANNEL,
                    'Server Support',
                    'Need help with a server issue? Click below to open a ticket and our moderation team will assist you.',
                    '#5865F2',
                    'Open Server Ticket',
                    '🛡️',
                    SUPPORT_CATEGORY,      // tickets created in ▬▬ Support ▬▬
                    MOD_PERMS_ROLE,
                    'server-{username}',
                    TICKET_LOG_CHANNEL,
                ]
            );
            serverPanelId = result.insertId;
            console.log(`  [+] Panel "Server Support" created (id: ${serverPanelId})`);
        }

        await deployPanel(ticketsChannel, serverPanelId, {
            title: 'Server Support',
            description: 'Need help with a server issue? Click below to open a ticket and our moderation team will assist you.',
            color: '#5865F2',
            buttonText: 'Open Server Ticket',
            buttonEmoji: '🛡️',
        });
    }

    // ==================================================================
    // PART 4: CLEANUP SUMMARY
    // ==================================================================
    console.log('\n' + '='.repeat(50));
    console.log('SETUP COMPLETE');
    console.log('='.repeat(50));
    console.log('');
    console.log('Configured:');
    console.log('  [x] Steam watchers: Havendock, Stormbridge, Last Fuse, Siegeturtle (5-min interval)');
    console.log('  [x] Game ticket panels: Havendock, Stormbridge, Last Fuse, Siegeturtle, Astral Bloom');
    console.log('  [x] Server support panel in #📩︱tickets');
    console.log('');
    console.log('Manual cleanup (after verifying everything works):');
    console.log('  - Remove SteamWatch webhooks from 4 #updates channels (or leave — won\'t conflict)');
    console.log('  - Kick SteamWatch bot (optional)');
    console.log('  - Kick Tickets v2 bot after verifying new panels work');
    console.log('  - Kick ProBot (dormant, optional)');
    console.log('');
    console.log('Verification steps:');
    console.log('  1. pm2 restart CertiFriedUtility');
    console.log('  2. Click a game panel button → ticket created in that game\'s category');
    console.log('  3. Click server support button → ticket created in ▬▬ Support ▬▬');
    console.log('  4. /media steam watchers → 4 active watchers listed');
    console.log('  5. /media steam check → manual trigger, check PM2 logs');

    client.destroy();
    await pool.end();
    process.exit(0);
}

/**
 * Deploy a ticket panel — sends embed + button to channel, stores panel_message_id.
 * Mirrors the pattern from commands/admin/support/panel.js:164-194.
 */
async function deployPanel(channel, panelId, { title, description, color, buttonText, buttonEmoji }) {
    // Delete old panel message if one exists
    const [panels] = await pool.execute(
        'SELECT panel_message_id FROM ticket_panels WHERE panel_id = ?',
        [panelId]
    );
    if (panels[0]?.panel_message_id) {
        try {
            const oldMsg = await channel.messages.fetch(panels[0].panel_message_id).catch(() => null);
            if (oldMsg) await oldMsg.delete();
        } catch { /* ignore */ }
    }

    // Build embed
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();

    // Build button
    const button = new ButtonBuilder()
        .setCustomId(`ticket_create_panel_${panelId}`)
        .setLabel(buttonText)
        .setStyle(ButtonStyle.Primary);

    if (buttonEmoji) button.setEmoji(buttonEmoji);

    const row = new ActionRowBuilder().addComponents(button);

    // Send and store message ID
    const message = await channel.send({ embeds: [embed], components: [row] });
    await pool.execute(
        'UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?',
        [message.id, panelId]
    );

    console.log(`  [deployed] Panel ${panelId} → message ${message.id}`);
}

setup().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});
