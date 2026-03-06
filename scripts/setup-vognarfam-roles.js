/**
 * Create Verified role, link to rules button, and finalize VognarFam setup
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const RULES_CHANNEL_ID = '903149773987667979';
const RULES_MESSAGE_ID = '1476141871217770518';

async function setup() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildMembers
        ]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.error('Guild not found'); process.exit(1); }

    // ========== STEP 1: Create Verified Role ==========
    console.log('\n=== CREATING VERIFIED ROLE ===');

    // Check if it already exists
    let verifiedRole = guild.roles.cache.find(r =>
        r.name.toLowerCase() === 'verified' ||
        r.name.toLowerCase() === 'member'
    );

    if (!verifiedRole) {
        verifiedRole = await guild.roles.create({
            name: 'Verified',
            color: 0x2ECC71,
            reason: 'Auto-created for rules agreement system',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.UseExternalEmojis,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
                PermissionFlagsBits.UseVAD
            ]
        });
        console.log(`Created "Verified" role: ${verifiedRole.id}`);
    } else {
        console.log(`Found existing role: ${verifiedRole.name} (${verifiedRole.id})`);
    }

    // ========== STEP 2: Update Rules Message Button ==========
    console.log('\n=== UPDATING RULES BUTTON ===');

    const rulesChannel = guild.channels.cache.get(RULES_CHANNEL_ID);
    if (!rulesChannel) { console.error('Rules channel not found'); process.exit(1); }

    try {
        const rulesMessage = await rulesChannel.messages.fetch(RULES_MESSAGE_ID);

        // Update button with correct rr_ custom ID
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`rr_${verifiedRole.id}`)
                .setLabel('\uD83D\uDC4D I\'ve Read & Agree to the Rules')
                .setStyle(ButtonStyle.Success)
        );

        await rulesMessage.edit({ components: [row] });
        console.log(`Updated rules button to assign role: ${verifiedRole.name} (rr_${verifiedRole.id})`);
    } catch (err) {
        console.error('Failed to update rules message:', err.message);
    }

    // ========== STEP 3: Create Reaction Role Panel in DB ==========
    console.log('\n=== CREATING REACTION ROLE PANEL ===');

    // Check if panel already exists for this message
    const [existingPanels] = await pool.execute(
        'SELECT id FROM reaction_role_panels WHERE message_id = ?',
        [RULES_MESSAGE_ID]
    );

    let panelId;
    if (existingPanels.length > 0) {
        panelId = existingPanels[0].id;
        console.log(`Panel already exists (${panelId}), updating mappings...`);
        // Clear old mappings
        await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panelId]);
    } else {
        const [result] = await pool.execute(
            `INSERT INTO reaction_role_panels
            (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [GUILD_ID, RULES_CHANNEL_ID, RULES_MESSAGE_ID, 'rules-agree', 'Rules agreement', '#2ecc71', 'button', 'unique']
        );
        panelId = result.insertId;
        console.log(`Created panel: ${panelId}`);
    }

    // Add role mapping
    await pool.execute(
        `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, description)
        VALUES (?, ?, ?, ?, ?)`,
        [panelId, verifiedRole.id, '\uD83D\uDC4D', 'Agree to Rules', 'Accept the rules to access the server']
    );
    console.log(`Mapped button -> ${verifiedRole.name} role`);

    // ========== STEP 4: List All Channels for Reference ==========
    console.log('\n=== GUILD CHANNELS ===');
    const textChannels = guild.channels.cache
        .filter(c => c.type === 0 || c.type === 5) // Text + announcement
        .sort((a, b) => a.rawPosition - b.rawPosition);

    for (const [, ch] of textChannels) {
        const parent = ch.parent ? `[${ch.parent.name}]` : '[no category]';
        console.log(`  ${parent} #${ch.name} (${ch.id})`);
    }

    console.log('\n========================================');
    console.log('SETUP COMPLETE');
    console.log('========================================');
    console.log(`Verified role: ${verifiedRole.name} (${verifiedRole.id})`);
    console.log(`Rules button linked to role on message ${RULES_MESSAGE_ID}`);
    console.log('');
    console.log('Users who click the button in #rules will now receive the Verified role.');
    console.log('You may want to restrict most channels to require the Verified role.');

    client.destroy();
    await pool.end();
    process.exit(0);
}

setup().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});
