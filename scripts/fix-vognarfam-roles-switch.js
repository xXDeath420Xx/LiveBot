/**
 * Fix VognarFam roles channel: add Switch to Gaming Platform panel
 * 1. Create Switch role
 * 2. Delete existing panel messages + DB entries
 * 3. Recreate all 3 panels with Switch added
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const ROLES_CHANNEL_ID = '903160651462107146';

const ROLES = {
    affiliate: '903146908988612618',
    nonAffiliate: '903146909751996446',
    verified: '1476143521365884984'
};

// Panel IDs to clean up
const OLD_PANEL_IDS = [37, 38, 39];
const OLD_MESSAGE_IDS = ['1476147611781038173', '1476147613547106416', '1476147614637621258'];

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    const rolesCh = guild.channels.cache.get(ROLES_CHANNEL_ID);

    // ================================================================
    // STEP 1: Create Switch role
    // ================================================================
    console.log('=== CREATING SWITCH ROLE ===');
    let switchRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'switch');
    if (!switchRole) {
        switchRole = await guild.roles.create({
            name: 'Switch',
            color: 0xE60012,
            reason: 'Self-assignable role for roles panel'
        });
        console.log(`  Created: ${switchRole.name} (${switchRole.id})`);
    } else {
        console.log(`  Exists: ${switchRole.name} (${switchRole.id})`);
    }

    // Get existing roles
    const createdRoles = {};
    for (const name of ['PlayStation', 'Xbox', 'PC', 'Content Creator', 'Event Notifications']) {
        createdRoles[name] = guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());
    }
    createdRoles['Switch'] = switchRole;

    // ================================================================
    // STEP 2: Clean up old panels
    // ================================================================
    console.log('\n=== CLEANING UP OLD PANELS ===');

    // Delete old messages from Discord
    for (const msgId of OLD_MESSAGE_IDS) {
        try {
            const msg = await rolesCh.messages.fetch(msgId);
            await msg.delete();
            console.log(`  Deleted message: ${msgId}`);
        } catch (e) {
            console.log(`  Skip message ${msgId}: ${e.message}`);
        }
    }

    // Delete old DB entries
    for (const panelId of OLD_PANEL_IDS) {
        await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panelId]);
        await pool.execute('DELETE FROM reaction_role_panels WHERE id = ?', [panelId]);
        console.log(`  Deleted panel ${panelId} from DB`);
    }

    // ================================================================
    // STEP 3: Recreate panels with Switch
    // ================================================================
    console.log('\n=== CREATING NEW PANELS ===');

    // ---- Panel 1: Streamer Status ----
    const streamerEmbed = new EmbedBuilder()
        .setColor(0x9146FF)
        .setTitle('\uD83C\uDFAE Streamer Status')
        .setDescription(
            'Are you a Twitch streamer? Let us know your status so we can support you properly!\n\n' +
            '\uD83D\uDFE3 **Affiliate** \u2014 You\'ve achieved Twitch Affiliate status\n' +
            '\u26AA **Non-Affiliate** \u2014 You\'re working toward Affiliate\n\n' +
            '*Select one below:*'
        );

    const streamerRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`rr_${ROLES.affiliate}`)
            .setLabel('Affiliate')
            .setEmoji('\uD83D\uDFE3')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`rr_${ROLES.nonAffiliate}`)
            .setLabel('Non-Affiliate')
            .setEmoji('\u26AA')
            .setStyle(ButtonStyle.Secondary)
    );

    const streamerMsg = await rolesCh.send({ embeds: [streamerEmbed], components: [streamerRow] });
    const [p1] = await pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [GUILD_ID, ROLES_CHANNEL_ID, streamerMsg.id, 'streamer-status', 'Affiliate or Non-Affiliate', '#9146FF', 'button', 'unique']
    );
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [p1.insertId, ROLES.affiliate, '\uD83D\uDFE3']);
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [p1.insertId, ROLES.nonAffiliate, '\u26AA']);
    console.log(`  Streamer panel: ${streamerMsg.id}`);

    // ---- Panel 2: Gaming Platform (with Switch!) ----
    const platformEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('\uD83D\uDD79\uFE0F Gaming Platform')
        .setDescription(
            'What do you game on? Pick your platform(s) to connect with others!\n\n' +
            '\uD83D\uDD35 **PlayStation**\n' +
            '\uD83D\uDFE2 **Xbox**\n' +
            '\uD83D\uDFE3 **PC**\n' +
            '\uD83D\uDD34 **Switch**\n\n' +
            '*You can select multiple:*'
        );

    const platformRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`rr_${createdRoles['PlayStation'].id}`)
            .setLabel('PlayStation')
            .setEmoji('\uD83D\uDD35')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`rr_${createdRoles['Xbox'].id}`)
            .setLabel('Xbox')
            .setEmoji('\uD83D\uDFE2')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`rr_${createdRoles['PC'].id}`)
            .setLabel('PC')
            .setEmoji('\uD83D\uDFE3')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`rr_${createdRoles['Switch'].id}`)
            .setLabel('Switch')
            .setEmoji('\uD83D\uDD34')
            .setStyle(ButtonStyle.Danger)
    );

    const platformMsg = await rolesCh.send({ embeds: [platformEmbed], components: [platformRow] });
    const [p2] = await pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [GUILD_ID, ROLES_CHANNEL_ID, platformMsg.id, 'gaming-platform', 'Gaming platform selection', '#5865F2', 'button', 'normal']
    );
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [p2.insertId, createdRoles['PlayStation'].id, '\uD83D\uDD35']);
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [p2.insertId, createdRoles['Xbox'].id, '\uD83D\uDFE2']);
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [p2.insertId, createdRoles['PC'].id, '\uD83D\uDFE3']);
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [p2.insertId, createdRoles['Switch'].id, '\uD83D\uDD34']);
    console.log(`  Platform panel: ${platformMsg.id} (includes Switch!)`);

    // ---- Panel 3: Notifications & Extras ----
    const notifEmbed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('\uD83D\uDD14 Notifications & Extras')
        .setDescription(
            'Opt in to notifications and extra roles!\n\n' +
            '\uD83C\uDFA5 **Content Creator** \u2014 You create content (YouTube, TikTok, etc.)\n' +
            '\uD83D\uDD14 **Event Notifications** \u2014 Get pinged for community events\n\n' +
            '*Toggle on/off by clicking:*'
        );

    const notifRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`rr_${createdRoles['Content Creator'].id}`)
            .setLabel('Content Creator')
            .setEmoji('\uD83C\uDFA5')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`rr_${createdRoles['Event Notifications'].id}`)
            .setLabel('Event Notifications')
            .setEmoji('\uD83D\uDD14')
            .setStyle(ButtonStyle.Success)
    );

    const notifMsg = await rolesCh.send({ embeds: [notifEmbed], components: [notifRow] });
    const [p3] = await pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [GUILD_ID, ROLES_CHANNEL_ID, notifMsg.id, 'notifications', 'Notification preferences', '#FEE75C', 'button', 'normal']
    );
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [p3.insertId, createdRoles['Content Creator'].id, '\uD83C\uDFA5']);
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [p3.insertId, createdRoles['Event Notifications'].id, '\uD83D\uDD14']);
    console.log(`  Notifications panel: ${notifMsg.id}`);

    console.log('\n========================================');
    console.log('ROLES CHANNEL UPDATED');
    console.log('========================================');
    console.log('Panels:');
    console.log('  1. Streamer Status: Affiliate / Non-Affiliate (unique)');
    console.log('  2. Gaming Platform: PlayStation / Xbox / PC / Switch (multi-select)');
    console.log('  3. Notifications: Content Creator / Event Notifications (multi-select)');

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
