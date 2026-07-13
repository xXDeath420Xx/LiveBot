/**
 * Setup the six "Available to Set Up" systems in Flickster's House:
 *   🎫 Ticketing System
 *   🌐 Global Ban Network
 *   💡 Suggestions
 *   🎂 Birthday Celebrations
 *   🎵 Music Playback
 *   📤 Auto Publisher
 *
 * Idempotent — channels are findOrCreate, DB rows use ON DUPLICATE KEY UPDATE.
 *
 * Stop PM2 before running:  pm2 stop CertiFriedUtility
 */
import dotenv from 'dotenv';
dotenv.config();
import {
    Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';

// Pre-existing roles
const OWNER_ROLE = '1502751525728948366'; // House Master
const ADMIN_ROLE = '1502737822245978253'; // House Keeper's
// Created in earlier setup
const VERIFIED_ROLE  = '1502814371502624858';
const MODERATOR_ROLE = '1502814369439027370';

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
    console.log(`Connected to ${guild.name}\n`);

    const log = (m) => console.log(`[Extras] ${m}`);
    const everyoneId = guild.id;
    const botId = client.user.id;

    // Locate existing infrastructure
    const catCommunity = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === '💬 Community');
    const catLogs = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === '📜 Logs');
    const chModLogs = guild.channels.cache.find(c => c.name === 'mod-logs');
    const chBirthdays = guild.channels.cache.find(c => c.name === 'birthdays');
    if (!catCommunity || !catLogs || !chModLogs) {
        console.error('Missing baseline categories/channels — re-run the main setup script first');
        process.exit(1);
    }

    const VERIFIED_OW = [
        { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
        { id: VERIFIED_ROLE, allow: [PermissionFlagsBits.ViewChannel] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ];

    async function findOrCreateCategory(name, overwrites) {
        let c = guild.channels.cache.find(x => x.type === ChannelType.GuildCategory && x.name === name);
        if (c) { log(`  ✓ Category "${name}" exists`); return c; }
        c = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
        log(`  + Created category "${name}"`);
        return c;
    }
    async function findOrCreateChannel(name, type, parent, overwrites = null) {
        let c = guild.channels.cache.find(x => x.type === type && x.name === name && x.parentId === parent.id);
        if (c) { log(`  ✓ Channel "${name}" exists`); return c; }
        const opts = { name, type, parent: parent.id };
        if (overwrites) opts.permissionOverwrites = overwrites;
        c = await guild.channels.create(opts);
        log(`  + Created channel "${name}"`);
        return c;
    }

    // ═══ 1. Channels ═══
    log('Step 1: Channels');

    // Ticket category — staff-and-bot only at category level. Per-ticket overrides add the requester.
    const catTickets = await findOrCreateCategory('🎫 Tickets', [
        { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
        { id: MODERATOR_ROLE, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
        { id: ADMIN_ROLE, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] },
        { id: OWNER_ROLE, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
    ]);
    // Public-facing ticket panel channel — Verified can see and click the button
    const chSupport = await findOrCreateChannel('support', ChannelType.GuildText, catCommunity, [
        { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
        { id: VERIFIED_ROLE, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: MODERATOR_ROLE, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ]);

    const chSuggestions = await findOrCreateChannel('suggestions', ChannelType.GuildText, catCommunity, VERIFIED_OW);
    const chBirthdaysFinal = chBirthdays || await findOrCreateChannel('birthdays', ChannelType.GuildText, catCommunity, VERIFIED_OW);
    const chMusic = await findOrCreateChannel('music', ChannelType.GuildText, catCommunity, VERIFIED_OW);

    // ═══ 2. Tickets ═══
    log('\nStep 2: 🎫 Tickets');
    await pool.execute(
        `INSERT INTO ticket_config (guild_id, panel_channel_id, ticket_category_id, support_role_id, log_channel_id, auto_close_hours, use_threads)
         VALUES (?, ?, ?, ?, ?, 72, 0)
         ON DUPLICATE KEY UPDATE panel_channel_id = VALUES(panel_channel_id), ticket_category_id = VALUES(ticket_category_id),
            support_role_id = VALUES(support_role_id), log_channel_id = VALUES(log_channel_id)`,
        [GUILD_ID, chSupport.id, catTickets.id, MODERATOR_ROLE, chModLogs.id]
    );
    log('  ✓ ticket_config seeded');

    // ticket_panels — primary
    const [existingPanels] = await pool.execute(
        'SELECT panel_id FROM ticket_panels WHERE guild_id = ? AND panel_channel_id = ?',
        [GUILD_ID, chSupport.id]
    );
    let ticketPanelId;
    if (existingPanels.length) {
        ticketPanelId = existingPanels[0].panel_id;
        await pool.execute(
            `UPDATE ticket_panels SET embed_title = ?, embed_description = ?, button_text = ?, button_emoji = ?,
                ticket_category_id = ?, support_role_id = ?, log_channel_id = ?, alert_channel_id = ?, is_active = 1
             WHERE panel_id = ?`,
            ['🎫 Support Tickets',
             'Need help, want to report something, or have a question only staff should see?\nClick below to open a private ticket — only you and the staff team will see it.',
             'Open a ticket', '🎫', catTickets.id, MODERATOR_ROLE, chModLogs.id, chModLogs.id, ticketPanelId]
        );
        log(`  ✓ ticket_panels row updated (panel_id=${ticketPanelId})`);
    } else {
        const [ins] = await pool.execute(
            `INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color,
                button_text, button_emoji, ticket_category_id, support_role_id, ticket_name_format,
                save_transcripts, log_channel_id, alert_channel_id, is_active)
             VALUES (?, 'Support', ?, ?, ?, '#5865F2', 'Open a ticket', '🎫', ?, ?, 'ticket-{user}', 1, ?, ?, 1)`,
            [GUILD_ID, chSupport.id, '🎫 Support Tickets',
             'Need help, want to report something, or have a question only staff should see?\nClick below to open a private ticket — only you and the staff team will see it.',
             catTickets.id, MODERATOR_ROLE, chModLogs.id, chModLogs.id]
        );
        ticketPanelId = ins.insertId;
        log(`  + ticket_panels row inserted (panel_id=${ticketPanelId})`);
    }

    // Post panel embed (clean prior bot messages so re-runs don't duplicate)
    try {
        const recent = await chSupport.messages.fetch({ limit: 50 });
        const mine = recent.filter(m => m.author?.id === botId);
        if (mine.size) await chSupport.bulkDelete(mine, true).catch(async () => {
            for (const m of mine.values()) await m.delete().catch(() => {});
        });
    } catch {}
    const ticketEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎫 Support Tickets')
        .setDescription(['Need help, want to report something, or have a question only staff should see?', '', 'Click **Open a ticket** below and a private channel will be created for you and the staff team.'].join('\n'));
    const ticketRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_create_panel_${ticketPanelId}`).setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
    );
    const ticketMsg = await chSupport.send({ embeds: [ticketEmbed], components: [ticketRow] });
    await pool.execute('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [ticketMsg.id, ticketPanelId]);
    log(`  ✓ ticket panel posted (${ticketMsg.id})`);

    // ═══ 3. Global Ban Network ═══
    log('\nStep 3: 🌐 Global Ban Network');
    await pool.execute(
        `INSERT INTO global_ban_config
            (guild_id, enabled, action_critical, action_high, action_medium, action_low, alert_channel_id, log_actions, check_on_join, check_on_message, auto_aggregate_opt_in)
         VALUES (?, 1, 'ban', 'ban', 'kick', 'alert', ?, 1, 1, 0, 1)
         ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id), check_on_join = 1, check_on_message = 1`,
        [GUILD_ID, chModLogs.id]
    );
    log('  ✓ global_ban_config: critical/high → ban, medium → kick, low → alert; checks on join + message');

    // ═══ 4. Suggestions ═══
    log('\nStep 4: 💡 Suggestions');
    await pool.execute(
        `INSERT INTO suggestion_config (guild_id, suggestions_channel_id, staff_review_channel_id, min_votes_for_approval, allow_anonymous, require_approval, enabled)
         VALUES (?, ?, ?, 10, 0, 0, 1)
         ON DUPLICATE KEY UPDATE suggestions_channel_id = VALUES(suggestions_channel_id),
            staff_review_channel_id = VALUES(staff_review_channel_id), enabled = 1`,
        [GUILD_ID, chSuggestions.id, chModLogs.id]
    );
    log(`  ✓ suggestion_config: posts in #${chSuggestions.name}, staff review in #mod-logs, 10-vote auto-approval`);

    // ═══ 5. Birthday ═══
    log('\nStep 5: 🎂 Birthday Celebrations');
    await pool.execute(
        `INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled, message_template, cards_enabled, default_card_type)
         VALUES (?, ?, 1, '🎉 Happy birthday, {mention}! Have a great one from everyone in Flickster''s House. 🎂', 1, 'classic')
         ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), enabled = 1,
            message_template = VALUES(message_template), cards_enabled = 1`,
        [GUILD_ID, chBirthdaysFinal.id]
    );
    log(`  ✓ birthday_config: announcements in #${chBirthdaysFinal.name}, classic cards enabled`);

    // ═══ 6. Music ═══
    log('\nStep 6: 🎵 Music Playback');
    await pool.execute(
        `INSERT INTO music_config (guild_id, is_enabled, enabled, request_channel_id, default_volume, vote_skip_enabled, vote_skip_percentage)
         VALUES (?, 1, 1, ?, 80, 1, 50)
         ON DUPLICATE KEY UPDATE is_enabled = 1, enabled = 1, request_channel_id = VALUES(request_channel_id)`,
        [GUILD_ID, chMusic.id]
    );

    // Music panel — placeholder embed; live music-panel manager takes over once /play is used
    try {
        const recent = await chMusic.messages.fetch({ limit: 50 });
        const mine = recent.filter(m => m.author?.id === botId);
        if (mine.size) await chMusic.bulkDelete(mine, true).catch(async () => {
            for (const m of mine.values()) await m.delete().catch(() => {});
        });
    } catch {}

    const musicEmbed = new EmbedBuilder()
        .setColor(0x1ABC9C)
        .setAuthor({ name: 'Live Music Player' })
        .setTitle('The queue is empty')
        .setDescription([
            'Use `/play <song or URL>` to start. The panel updates as tracks play.',
            '',
            '**Tips:**',
            '• Join a voice channel first.',
            '• Supports YouTube, Spotify, SoundCloud, direct links, and free-text search.',
            '• Vote-skip is on (50% of listeners).',
        ].join('\n'))
        .setThumbnail(client.user.displayAvatarURL());

    const musicPlaybackRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music-play-pause').setLabel('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('music-skip').setLabel('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('music-stop').setLabel('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true),
        new ButtonBuilder().setCustomId('music-clear').setLabel('🗑️').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
    const musicSelectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('music-add-song')
            .setPlaceholder('Add a song or start a DJ')
            .addOptions([
                { label: 'Add song/playlist by name or URL', description: 'Add a song, YouTube playlist, or Spotify playlist', value: 'add_song_modal' },
                { label: 'Start an AI DJ session', description: 'AI-generated playlist or play from a playlist link', value: 'start_dj_modal' },
            ]),
    );
    const musicMsg = await chMusic.send({ embeds: [musicEmbed], components: [musicPlaybackRow, musicSelectRow] });

    await pool.execute(
        `INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message_id = VALUES(message_id)`,
        [GUILD_ID, chMusic.id, musicMsg.id]
    );
    log(`  ✓ music_config + music_panels: panel posted (${musicMsg.id})`);

    // ═══ 7. Auto Publisher ═══
    log('\nStep 7: 📤 Auto Publisher');
    await pool.execute(
        `INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE is_enabled = 1`,
        [GUILD_ID]
    );
    log('  ✓ auto_publisher_config enabled (Discord Announcement-type channels will auto-publish)');

    // ═══ Summary ═══
    console.log('\n' + '═'.repeat(60));
    console.log('EXTRAS SETUP COMPLETE');
    console.log('═'.repeat(60));
    console.log(`  🎫 Tickets:        panel in #${chSupport.name}, category 🎫 Tickets, staff = Moderator+`);
    console.log(`  🌐 Global Ban:     enabled, alerts in #${chModLogs.name}`);
    console.log(`  💡 Suggestions:    posts in #${chSuggestions.name}, staff review in #${chModLogs.name}`);
    console.log(`  🎂 Birthdays:      announces in #${chBirthdaysFinal.name}`);
    console.log(`  🎵 Music:          panel in #${chMusic.name}, /play available`);
    console.log(`  📤 Auto Publisher: enabled (set channels to Announcement type to auto-publish)`);
    console.log('');
    console.log('Manual TODOs:');
    console.log('  1. To use Auto Publisher: convert text channels (e.g. #announcements, #live-streamers) to "Announcement" type via Discord channel settings → "Edit Channel" → "Channel Type" → Announcement');
    console.log('  2. pm2 restart CertiFriedUtility (to flush 60s config cache)');
    console.log('  3. Test: click "Open a ticket" button in #support; submit /suggest in #suggestions');
    console.log('═'.repeat(60));

    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
