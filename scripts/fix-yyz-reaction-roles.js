/**
 * Fix YYZ Studio reaction role dropdowns
 *
 * The old bot's dropdowns used `reaction_roles.dropdown.*` custom IDs which
 * CertiFried doesn't handle. This script rebuilds both messages as proper
 * CertiFried panels with `rr_select` custom IDs and DB-backed role mappings.
 *
 * Message 1 (1348130671469527132): "What games are you here for?"
 *   - Havendock, Stormbridge, Last Fuse, Siegeturtle, Astral Bloom
 *
 * Message 2 (1348130703715598408): "Announcement Pings"
 *   - Server Announcement ping, General Game Announcements
 *
 * Usage: node scripts/fix-yyz-reaction-roles.js
 */
import dotenv from 'dotenv';
dotenv.config();

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

const GUILD_ID = '961514092848382043';
const BOT_ID = '1345684217438273577';
const CHANNEL_ID = '1345464357466804305'; // #🧬︱roles

const PANELS = [
    {
        messageId: '1348130671469527132',
        name: 'What games are you here for?',
        description: 'React to this message to get your roles!',
        color: '#5865F2',
        mode: 'multiple',
        roles: [
            { roleId: '1314607877603983431', label: 'Havendock', emoji: '<:Havendock:1345472073610469406>', description: 'Get the Havendock role' },
            { roleId: '1314607918288601179', label: 'Stormbridge', emoji: '🌉', description: 'Get the Stormbridge role' },
            { roleId: '1343588436443136031', label: 'Last Fuse', emoji: '🧨', description: 'Get the Last Fuse role' },
            { roleId: '1401916800370999418', label: 'Siegeturtle', emoji: '<:turyyz:1401920461776183357>', description: 'Get the Siegeturtle role' },
            { roleId: '1477098291081515179', label: 'Astral Bloom', emoji: '🌻', description: 'Get the Astral Bloom role' },
        ]
    },
    {
        messageId: '1348130703715598408',
        name: 'Announcement Pings',
        description: 'If you would like to get notified for any of these subjects, please respond with the reaction role drop down below!',
        color: '#5865F2',
        mode: 'multiple',
        roles: [
            { roleId: '1011220524946444349', label: 'Server Announcements', emoji: '📢', description: 'Get pinged for server announcements' },
            { roleId: '1345585510164463658', label: 'General Game Announcements', emoji: '🎮', description: 'Get pinged for game announcements' },
        ]
    }
];

async function setup() {
    console.log(`\n=== YYZ Studio — Fix Reaction Role Dropdowns ===\n`);

    // Get bot token for API calls
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // Fetch custom emojis to get proper emoji format for API
    const emojiResp = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/emojis`, {
        headers: { Authorization: `Bot ${token}` }
    });
    const guildEmojis = await emojiResp.json();
    const emojiMap = {};
    for (const e of guildEmojis) {
        emojiMap[e.name] = { id: e.id, name: e.name, animated: e.animated || false };
    }

    for (const panel of PANELS) {
        console.log(`Panel: "${panel.name}" (msg ${panel.messageId})`);

        // 1. Insert panel into DB
        const [result] = await pool.execute(`
            INSERT INTO reaction_role_panels
            (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
            VALUES (?, ?, ?, ?, ?, ?, 'select_menu', ?)
        `, [GUILD_ID, CHANNEL_ID, panel.messageId, panel.name, panel.description, panel.color, panel.mode]);

        const panelId = result.insertId;
        console.log(`  DB panel created: id=${panelId}`);

        // 2. Insert role mappings
        for (const role of panel.roles) {
            const emojiId = role.emoji.includes(':')
                ? role.emoji.split(':')[2].replace('>', '')
                : role.emoji;
            await pool.execute(
                'INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)',
                [panelId, role.roleId, emojiId]
            );
        }
        console.log(`  ${panel.roles.length} role mappings inserted`);

        // 3. Build the new select menu with rr_select custom ID
        const options = panel.roles.map(role => {
            const opt = {
                label: role.label,
                value: role.roleId,
                description: role.description,
            };
            // Parse emoji for Discord API format
            if (role.emoji.includes(':')) {
                const emojiName = role.emoji.split(':')[1];
                const emojiId = role.emoji.split(':')[2].replace('>', '');
                opt.emoji = { id: emojiId, name: emojiName };
            } else {
                opt.emoji = { name: role.emoji };
            }
            return opt;
        });

        const componentPayload = [{
            type: 1, // ActionRow
            components: [{
                type: 3, // StringSelect
                custom_id: 'rr_select',
                placeholder: 'Choose your roles',
                min_values: 0,
                max_values: options.length,
                options: options
            }]
        }];

        // 4. Edit the Discord message to replace the old dropdown
        const editResp = await fetch(
            `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${panel.messageId}`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bot ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ components: componentPayload })
            }
        );

        if (editResp.ok) {
            console.log(`  Discord message updated with rr_select dropdown`);
        } else {
            const err = await editResp.text();
            console.error(`  FAILED to edit message: ${editResp.status} ${err}`);
        }

        console.log('');
    }

    console.log('=== Done ===');
    console.log('Both dropdowns now use CertiFried\'s rr_select handler.');
    console.log('No restart needed — the handler already exists.\n');

    process.exit(0);
}

setup().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});
