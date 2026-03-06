/**
 * Setup script for VognarFam bot in guild 902393911958470717
 * Posts rules embed, creates reaction role, configures logging & support tracking
 *
 * Usage: node scripts/setup-vognarfam.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const RULES_CHANNEL_ID = '903149773987667979';

// Channel IDs
const CHANNELS = {
    rules: '903149773987667979',
    raidTracking: '1318141825009319936',       // who-I-raided
    supportTracking: '1416534252547473459',     // who-we-supported
    autoShoutout: '902709348139167784',         // auto shoutout channel
    affiliateLinks: '902709263712018483',        // affiliate live links
    nonAffiliateLinks: '902718842176933938'      // non-affiliate live links
};

async function setup() {
    // Get bot token
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // Create client and login
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions
        ]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.error('Guild not found'); process.exit(1); }

    // ========== STEP 1: Post Rules Embed ==========
    console.log('\n=== POSTING RULES EMBED ===');
    const rulesChannel = guild.channels.cache.get(RULES_CHANNEL_ID);
    if (!rulesChannel) { console.error('Rules channel not found'); process.exit(1); }

    const rulesEmbed = new EmbedBuilder()
        .setColor(0x9146FF) // Twitch purple for a streaming community
        .setTitle('\uD83D\uDCDC Community Rules')
        .setDescription('Welcome to the community! Please read and follow these rules to ensure a positive experience for everyone.')
        .addFields(
            {
                name: '1. Have Fun!',
                value: 'If you\'re not having fun, why the hell are you here?'
            },
            {
                name: '2. Don\'t Be a Dick',
                value: 'If someone\'s in a VC, don\'t go in being loud and obnoxious. Don\'t invite the music bot without asking. Don\'t talk over others, especially if they\'re streaming. Use common sense and have courtesy for your fellow streamer.'
            },
            {
                name: '3. No NSFW Content',
                value: 'Keep it out of non-specified channels. We all have families and this is a community server. **You get 1 warning and ONLY 1.**'
            },
            {
                name: '4. No Harassment',
                value: 'Including sexual harassment or encouraging of harassment. This includes excessive messages and unwarranted DMs. If you feel harassed, alert a Moderator immediately and we will handle it anonymously.'
            },
            {
                name: '5. Use Appropriate Channels',
                value: 'Twitch links are only permitted in specified channels. Self-advertising in unapproved channels will result in a warning and link deletion.'
            },
            {
                name: '6. No Self or User Bots',
                value: 'These are in some cases against the Discord TOS. If you need a bot for something, use one of the bots already in the server.'
            },
            {
                name: '7. Language',
                value: 'Swearing? What swearing? If it offends you, message a mod. **Racial and homophobic slurs will result in an auto-ban.**'
            },
            {
                name: '8. Moderator Discretion',
                value: 'There may be situations not covered by the rules. Moderators are trusted to handle situations appropriately. If you have a complaint about staff, submit it directly to the server owner.'
            },
            {
                name: '9. No Drama / No Toxicity',
                value: '**WILL NOT BE TOLERATED. YOU WILL BE BANNED IMMEDIATELY.**'
            },
            {
                name: '10. Be Respectful',
                value: '**Disrespect of mods or any other member WILL result in a ban with no chance for unbanning.**'
            },
            {
                name: '11. Support Logs',
                value: 'Please make sure to edit your support logs each day. If you forget, that\'s ok, but please go back and edit it. This helps us track your support, apply correct points, and ensure proper users are added to the auto-shout system!'
            },
            {
                name: '12. Friend Requests',
                value: 'Don\'t send anyone friend requests without their permission! Please ask in general chat first.'
            },
            {
                name: '13. Direct Messages',
                value: 'Don\'t message anyone without their permission first. Same applies \u2014 please ask in general chat and get their permission first.'
            }
        )
        .setFooter({ text: 'Failure to follow these rules will result in warnings. Too many warnings = kick/ban.' })
        .setTimestamp();

    // Find or determine the verified role FIRST (needed for button custom ID)
    const verifiedRole = guild.roles.cache.find(r =>
        r.name.toLowerCase().includes('verified') ||
        r.name.toLowerCase().includes('member') ||
        r.name.toLowerCase().includes('accepted')
    );

    // Build the button - uses rr_<roleId> format so the reaction role manager handles it
    const buttonComponents = [];
    if (verifiedRole) {
        buttonComponents.push(
            new ButtonBuilder()
                .setCustomId(`rr_${verifiedRole.id}`)
                .setLabel('\uD83D\uDC4D I\'ve Read & Agree to the Rules')
                .setStyle(ButtonStyle.Success)
        );
    } else {
        // Placeholder button that won't do anything yet
        buttonComponents.push(
            new ButtonBuilder()
                .setCustomId('rules_agree_placeholder')
                .setLabel('\uD83D\uDC4D I\'ve Read & Agree to the Rules')
                .setStyle(ButtonStyle.Success)
        );
    }

    const row = new ActionRowBuilder().addComponents(buttonComponents);
    const rulesMessage = await rulesChannel.send({ embeds: [rulesEmbed], components: [row] });
    console.log(`Rules embed posted: ${rulesMessage.id}`);

    if (verifiedRole) {
        // Create reaction role panel
        const [panelResult] = await pool.execute(
            `INSERT INTO reaction_role_panels
            (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [GUILD_ID, RULES_CHANNEL_ID, rulesMessage.id, 'rules-agree', 'Rules agreement', '#00ff00', 'button', 'unique']
        );

        const panelId = panelResult.insertId;

        // Create role mapping
        await pool.execute(
            `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, description)
            VALUES (?, ?, ?, ?, ?)`,
            [panelId, verifiedRole.id, '\uD83D\uDC4D', 'Agree to Rules', 'Click to accept the rules and gain access']
        );

        console.log(`Reaction role panel created: ${panelId} -> role ${verifiedRole.name} (${verifiedRole.id})`);
    } else {
        console.log('WARNING: No verified/member/accepted role found. Please create one and set up the reaction role manually.');
        console.log('Use: /admin reaction-role panel create');
    }

    // ========== STEP 2: Configure Logging ==========
    console.log('\n=== CONFIGURING LOGGING ===');

    // Try to find existing log channels
    const logChannel = guild.channels.cache.find(c =>
        c.name.toLowerCase().includes('bot-log') ||
        c.name.toLowerCase().includes('mod-log') ||
        c.name.toLowerCase().includes('audit-log') ||
        c.name.toLowerCase().includes('server-log')
    );

    if (logChannel) {
        // Insert logging config
        await pool.execute(
            `INSERT INTO logging_config (guild_id, log_channel_id, enabled_events)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE log_channel_id = ?, enabled_events = ?`,
            [
                GUILD_ID,
                logChannel.id,
                JSON.stringify([
                    'messageDelete', 'messageUpdate', 'messageDeleteBulk',
                    'memberJoin', 'memberLeave', 'memberUpdate',
                    'roleCreate', 'roleUpdate', 'roleDelete',
                    'channelCreate', 'channelUpdate', 'channelDelete',
                    'guildBanAdd', 'guildBanRemove',
                    'inviteCreate', 'inviteDelete'
                ]),
                logChannel.id,
                JSON.stringify([
                    'messageDelete', 'messageUpdate', 'messageDeleteBulk',
                    'memberJoin', 'memberLeave', 'memberUpdate',
                    'roleCreate', 'roleUpdate', 'roleDelete',
                    'channelCreate', 'channelUpdate', 'channelDelete',
                    'guildBanAdd', 'guildBanRemove',
                    'inviteCreate', 'inviteDelete'
                ])
            ]
        );
        console.log(`Logging configured -> #${logChannel.name} (${logChannel.id})`);
    } else {
        console.log('WARNING: No log channel found. Please set one up via the dashboard or /admin logging command.');
        console.log('Looked for channels with: bot-log, mod-log, audit-log, server-log');
    }

    // ========== STEP 3: Configure Community Support Tracking ==========
    console.log('\n=== CONFIGURING COMMUNITY SUPPORT TRACKING ===');

    await pool.execute(
        `INSERT INTO community_support_config
        (guild_id, raid_channel_id, support_channel_id, shoutout_channel_id,
         affiliate_link_channel_id, non_affiliate_link_channel_id,
         raid_affiliate_points, raid_non_affiliate_points, support_points, enabled)
        VALUES (?, ?, ?, ?, ?, ?, 5, 10, 3, 1)
        ON DUPLICATE KEY UPDATE
            raid_channel_id = VALUES(raid_channel_id),
            support_channel_id = VALUES(support_channel_id),
            shoutout_channel_id = VALUES(shoutout_channel_id),
            affiliate_link_channel_id = VALUES(affiliate_link_channel_id),
            non_affiliate_link_channel_id = VALUES(non_affiliate_link_channel_id),
            enabled = 1`,
        [
            GUILD_ID,
            CHANNELS.raidTracking,
            CHANNELS.supportTracking,
            CHANNELS.autoShoutout,
            CHANNELS.affiliateLinks,
            CHANNELS.nonAffiliateLinks
        ]
    );

    console.log('Community support tracking configured:');
    console.log(`  Raid channel: ${CHANNELS.raidTracking}`);
    console.log(`  Support channel: ${CHANNELS.supportTracking}`);
    console.log(`  Auto-shoutout channel: ${CHANNELS.autoShoutout}`);
    console.log(`  Points: Raid Affiliate=5, Raid Non-Affiliate=10, Support=3`);

    // ========== STEP 4: Insert Guild Config ==========
    console.log('\n=== CONFIGURING GUILD ===');

    await pool.execute(
        `INSERT INTO guilds (guild_id, announcement_channel_id)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id)`,
        [GUILD_ID, CHANNELS.autoShoutout]
    );
    console.log(`Guild config set with announcement channel: ${CHANNELS.autoShoutout}`);

    // ========== SUMMARY ==========
    console.log('\n========================================');
    console.log('SETUP COMPLETE');
    console.log('========================================');
    console.log('');
    console.log('What was configured:');
    console.log('  [x] Rules embed posted with agreement button');
    console.log(`  [${verifiedRole ? 'x' : ' '}] Reaction role panel for rules agreement`);
    console.log(`  [${logChannel ? 'x' : ' '}] Mod logging to #${logChannel?.name || 'NOT FOUND'}`);
    console.log('  [x] Community support tracking (raid + support channels)');
    console.log('  [x] Monthly auto-rotation to shoutout channel');
    console.log('');
    if (!verifiedRole) {
        console.log('ACTION NEEDED: Create a "Verified" or "Member" role and set up reaction role manually');
    }
    if (!logChannel) {
        console.log('ACTION NEEDED: Create a log channel and configure via /admin logging');
    }
    console.log('');
    console.log('To restart the bot and apply all changes:');
    console.log('  pm2 restart CertiFriedUtility');

    client.destroy();
    await pool.end();
    process.exit(0);
}

setup().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});
