/**
 * VognarFam guild setup:
 * 1. Configure welcome system (take over from Dyno, no channel cleaning)
 * 2. Clean roles channel & create self-assignable role panels
 * 3. Set up auto-shoutout streamer subscriptions
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const WELCOME_CHANNEL_ID = '903154005620953109';
const ROLES_CHANNEL_ID = '903160651462107146';
const SHOUTOUT_CHANNEL_ID = '902709348139167784';

// Existing roles
const ROLES = {
    affiliate: '903146908988612618',
    nonAffiliate: '903146909751996446',
    verified: '1476143521365884984'
};

// Streamers to subscribe for auto-shoutouts
// custom_message vars: {username}, {streamer}, {platform}, {url}, {title}, {game}
const STREAMERS = [
    { username: 'AditGamenstein', message: 'Our top supporter of the month is live go show him love and support' },
    { username: 'ArkhamAsylum666', message: 'Our lovely top supporter of the month is live lets go show her the love and support ❤️ 💙' },
    { username: 'awesomea1ex444_', message: 'Top supporter of the month lets go show them love' },
    { username: 'furyandalan', message: 'Our top supporter of month go show him love support' },
    { username: 'gamerbeautyxo', message: 'Our lovely top supporter of the month is live lets go show her love and support ❤️ ❤️❤️' },
    { username: 'mrvognar', message: 'Hey @everyone, come chill with godvognar and some {game} over at {url}' },
    { username: 'GtStunna', message: 'Lets go our top supporter of the month is live lets go show him love and support' },
    { username: 'lordtyphonttv', message: 'Top supporter of the month lets go show them love' },
    { username: 'OutlawPegasus01', message: 'Top supporter of the month lets go show them love' },
    { username: 'RC_Jev', message: 'Lets go!!! Top supporter of the month is live lets go show him love and support' },
    { username: 'rwsmerca84', message: 'Come chill hangout with my son who also top supporter of the month lets go show him the love' },
    { username: 'sussykitsune', message: 'Lets go!!! Top supporter of the month is live lets go show him the love and support' },
    { username: 'TTVd1braeden1', message: "It's our son; he's live; lets go show him the love and support ❤️ 💙 ♥️" },
    { username: 'vognardaughter', message: 'Our lovely daughter is live lets go show her love and support ❤️' },
    { username: 'Voltorge', message: 'Lets go show my son support and love' },
    { username: 'zenni_barbatos', message: "He's a good buddy of ours; let's go show him love and support let's go!!!" },
    { username: 'zErO_vengeful0915', message: "Let's go show my nephew love and support; he's live" },
    { username: 'zyniza', message: 'Our lovely top supporter of month is live go show her the love and support ❤️ ❤️❤️' }
];

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.MessageContent
        ]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = client.guilds.cache.get(GUILD_ID);

    // ================================================================
    // STEP 1: Verify platform roles exist (already created)
    // ================================================================
    console.log('=== VERIFYING PLATFORM & NOTIFICATION ROLES ===');

    const roleNames = ['PlayStation', 'Xbox', 'PC', 'Content Creator', 'Event Notifications'];
    const createdRoles = {};
    for (const name of roleNames) {
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());
        if (role) {
            console.log(`  Found: ${role.name} (${role.id})`);
            createdRoles[name] = role;
        } else {
            console.error(`  MISSING: ${name} — run role creation first`);
            process.exit(1);
        }
    }

    // ================================================================
    // STEP 2: Configure Welcome System (DB only, no channel cleaning)
    // ================================================================
    console.log('\n=== CONFIGURING WELCOME SYSTEM ===');

    const welcomeMessage = `Hey {mention}, welcome to **{server}**! We're glad you're here.\n\nMake yourself at home and check out <#903149773987667979> to get started. Don't forget to grab your roles in <#903160651462107146>!\n\nWe're now **{memberCount}** strong!`;

    await pool.execute(`
        INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, auto_role_id)
        VALUES (?, ?, ?, 1, ?)
        ON DUPLICATE KEY UPDATE
            channel_id = VALUES(channel_id),
            message = VALUES(message),
            banner_enabled = 1,
            auto_role_id = VALUES(auto_role_id)
    `, [
        GUILD_ID,
        WELCOME_CHANNEL_ID,
        welcomeMessage,
        ROLES.verified
    ]);

    console.log('  Welcome settings configured (taking over from Dyno going forward)');
    console.log(`  Channel: #welcome (${WELCOME_CHANNEL_ID})`);
    console.log(`  Auto-role: Verified (${ROLES.verified})`);
    console.log('  Banner: enabled');

    // ================================================================
    // STEP 3: Clean Roles Channel & Create New Panels
    // ================================================================
    console.log('\n=== SETTING UP ROLES CHANNEL ===');
    const rolesCh = guild.channels.cache.get(ROLES_CHANNEL_ID);

    if (rolesCh) {
        // Delete all existing messages in roles channel
        let deletedRoles = 0;
        let hasMore = true;
        let lastId = null;

        while (hasMore) {
            const options = { limit: 100 };
            if (lastId) options.before = lastId;

            const messages = await rolesCh.messages.fetch(options);
            if (messages.size === 0) { hasMore = false; break; }

            for (const [msgId, msg] of messages) {
                lastId = msgId;
                try {
                    await msg.delete();
                    deletedRoles++;
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) {
                    console.log(`  Skip: ${msgId} - ${e.message}`);
                }
            }

            if (messages.size < 100) hasMore = false;
        }
        console.log(`  Deleted ${deletedRoles} messages from #roles`);

        // ---- Panel 1: Streamer Status ----
        console.log('\n  Creating Streamer Status panel...');

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

        const [panel1Result] = await pool.execute(
            `INSERT INTO reaction_role_panels
            (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [GUILD_ID, ROLES_CHANNEL_ID, streamerMsg.id, 'streamer-status', 'Affiliate or Non-Affiliate', '#9146FF', 'button', 'unique']
        );
        const panel1Id = panel1Result.insertId;

        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [panel1Id, ROLES.affiliate, '\uD83D\uDFE3']);
        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [panel1Id, ROLES.nonAffiliate, '\u26AA']);

        console.log(`  Streamer panel created (${streamerMsg.id})`);

        // ---- Panel 2: Gaming Platform ----
        console.log('  Creating Gaming Platform panel...');

        const platformEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('\uD83D\uDD79\uFE0F Gaming Platform')
            .setDescription(
                'What do you game on? Pick your platform(s) to connect with others!\n\n' +
                '\uD83D\uDD35 **PlayStation**\n' +
                '\uD83D\uDFE2 **Xbox**\n' +
                '\uD83D\uDFE3 **PC**\n\n' +
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
                .setStyle(ButtonStyle.Secondary)
        );

        const platformMsg = await rolesCh.send({ embeds: [platformEmbed], components: [platformRow] });

        const [panel2Result] = await pool.execute(
            `INSERT INTO reaction_role_panels
            (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [GUILD_ID, ROLES_CHANNEL_ID, platformMsg.id, 'gaming-platform', 'Gaming platform selection', '#5865F2', 'button', 'normal']
        );
        const panel2Id = panel2Result.insertId;

        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [panel2Id, createdRoles['PlayStation'].id, '\uD83D\uDD35']);
        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [panel2Id, createdRoles['Xbox'].id, '\uD83D\uDFE2']);
        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [panel2Id, createdRoles['PC'].id, '\uD83D\uDFE3']);

        console.log(`  Platform panel created (${platformMsg.id})`);

        // ---- Panel 3: Notifications & Extras ----
        console.log('  Creating Notifications panel...');

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

        const [panel3Result] = await pool.execute(
            `INSERT INTO reaction_role_panels
            (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [GUILD_ID, ROLES_CHANNEL_ID, notifMsg.id, 'notifications', 'Notification preferences', '#FEE75C', 'button', 'normal']
        );
        const panel3Id = panel3Result.insertId;

        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [panel3Id, createdRoles['Content Creator'].id, '\uD83C\uDFA5']);
        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [panel3Id, createdRoles['Event Notifications'].id, '\uD83D\uDD14']);

        console.log(`  Notifications panel created (${notifMsg.id})`);
    }

    // ================================================================
    // STEP 4: Set Up Auto-Shoutout Streamer Subscriptions
    // ================================================================
    console.log('\n=== SETTING UP STREAMER SHOUTOUTS ===');

    const { getTwitchUser } = await import('../utils/platforms/twitch-api.js');
    let addedCount = 0;
    let failedCount = 0;

    for (const streamer of STREAMERS) {
        try {
            // Resolve Twitch user
            const twitchUser = await getTwitchUser(streamer.username);
            if (!twitchUser) {
                console.log(`  SKIP: ${streamer.username} - not found on Twitch`);
                failedCount++;
                continue;
            }

            // Check if streamer exists in DB
            const [existing] = await pool.execute(
                'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
                ['twitch', twitchUser.id]
            );

            let streamerId;
            if (existing.length > 0) {
                streamerId = existing[0].streamer_id;
                console.log(`  EXISTS: ${twitchUser.login} (streamer_id: ${streamerId})`);
            } else {
                const [result] = await pool.execute(
                    `INSERT INTO streamers (platform, platform_user_id, username, profile_image_url)
                     VALUES ('twitch', ?, ?, ?)`,
                    [twitchUser.id, twitchUser.login, twitchUser.profile_image_url || null]
                );
                streamerId = result.insertId;
                console.log(`  ADDED: ${twitchUser.login} (streamer_id: ${streamerId})`);
            }

            // Check if subscription exists
            const [existingSub] = await pool.execute(
                'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                [GUILD_ID, streamerId]
            );

            if (existingSub.length === 0) {
                await pool.execute(
                    `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, delete_on_end)
                     VALUES (?, ?, ?, ?, 0)`,
                    [GUILD_ID, streamerId, SHOUTOUT_CHANNEL_ID, streamer.message]
                );
                console.log(`    -> Subscribed to channel ${SHOUTOUT_CHANNEL_ID}`);
            } else {
                // Update custom message and channel
                await pool.execute(
                    'UPDATE subscriptions SET announcement_channel_id = ?, custom_message = ? WHERE guild_id = ? AND streamer_id = ?',
                    [SHOUTOUT_CHANNEL_ID, streamer.message, GUILD_ID, streamerId]
                );
                console.log(`    -> Updated existing subscription`);
            }

            addedCount++;

            // Small delay to avoid Twitch API rate limits
            await new Promise(r => setTimeout(r, 300));

        } catch (error) {
            console.log(`  ERROR: ${streamer.username} - ${error.message}`);
            failedCount++;
        }
    }

    // ================================================================
    // SUMMARY
    // ================================================================
    console.log('\n========================================');
    console.log('SETUP COMPLETE');
    console.log('========================================');
    console.log('');
    console.log('Welcome System:');
    console.log(`  Channel: #welcome (${WELCOME_CHANNEL_ID})`);
    console.log('  Banner: enabled');
    console.log('  Auto-role: Verified on join');
    console.log('  Mode: taking over from Dyno (no old messages deleted)');
    console.log('');
    console.log('Self-Assignable Roles (3 panels in #roles):');
    console.log('  1. Streamer Status: Affiliate / Non-Affiliate (unique - pick one)');
    console.log('  2. Gaming Platform: PlayStation / Xbox / PC (multi-select)');
    console.log('  3. Notifications: Content Creator / Event Notifications (multi-select)');
    console.log('');
    console.log(`Auto-Shoutouts (channel ${SHOUTOUT_CHANNEL_ID}):`);
    console.log(`  Added: ${addedCount} streamers`);
    console.log(`  Failed: ${failedCount} streamers`);

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
