// Follow-ups — music panel with live controls, stream-signup auto-track (button removed),
// #suggestions → forum channel.
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GUILD_ID, createPool, connectClient, getGuild, log, CHANNELS_EXISTING } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'pac-state.json'), 'utf8'));

// ── Music panel (mirrors MusicPanel.buildEmbed/Components with null queue = empty state) ──
function buildEmptyMusicPanel(client) {
    const embed = new EmbedBuilder()
        .setColor('#2B2D31')
        .setAuthor({ name: 'Live Music Player' })
        .setTitle('The queue is empty')
        .setDescription('Add a song using the dropdown menu below to get started.')
        .setThumbnail(client.user.displayAvatarURL())
        .setFooter({ text: 'Use the controls below to manage the music.' });

    const playbackRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music-play-pause').setLabel('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('music-skip').setLabel('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('music-stop').setLabel('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true),
        new ButtonBuilder().setCustomId('music-shuffle').setLabel('🔀').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('music-loop').setLabel('🔁').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
    const extrasRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music-vol-down').setLabel('🔉').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('music-vol-up').setLabel('🔊').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('music-queue').setLabel('📋 Queue').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('music-clear').setLabel('🗑️').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
    const songRequestRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('music-add-song')
            .setPlaceholder('Add a song or start a DJ')
            .addOptions([
                { label: 'Add song/playlist by name or URL', description: 'Add a song, YouTube playlist, or Spotify playlist', value: 'add_song_modal' },
                { label: 'Start an AI DJ session', description: 'AI-generated playlist or play from a playlist link', value: 'start_dj_modal' },
            ]),
    );
    return { embed, components: [playbackRow, extrasRow, songRequestRow] };
}

async function fixMusicPanel(ctx) {
    log('music', 'Rebuilding music panel with live controls');
    const ch = await ctx.guild.channels.fetch(state.channels.music);

    // Remove existing bot messages (the placeholder)
    const recent = await ch.messages.fetch({ limit: 50 });
    const mine = recent.filter(m => m.author.id === ctx.client.user.id);
    for (const m of mine.values()) await m.delete().catch(() => {});

    const { embed, components } = buildEmptyMusicPanel(ctx.client);
    const sent = await ch.send({ embeds: [embed], components });

    await ctx.pool.execute(`
        INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message_id = VALUES(message_id)
    `, [GUILD_ID, state.channels.music, sent.id]);
    log('music', `panel posted with live controls (msg=${sent.id})`);
}

async function fixStreamSignup(ctx) {
    log('signup', 'Rewiring stream-signup to auto-track mode');
    const ch = await ctx.guild.channels.fetch(state.channels.streamSignup);

    // Clear prior bot messages (the button embed)
    const recent = await ch.messages.fetch({ limit: 50 });
    const mine = recent.filter(m => m.author.id === ctx.client.user.id);
    for (const m of mine.values()) await m.delete().catch(() => {});

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('📡 Post your stream link to join the auto-shoutout rotation')
        .setDescription([
            '**How this works:** Paste your stream URL in this channel and the bot will auto-sign you up. When you go live, the shoutout drops in <#' + state.channels.liveStreams + '> automatically.',
            '',
            '**Requirements**',
            '• Reach **level 3** in the server — you\'ll get the **Shoutout Eligible** role automatically at lvl 3',
            '• Post a single supported link per message',
            '',
            '**Supported platforms:** Twitch, Kick, YouTube, TikTok, Trovo, Facebook.',
            '',
            '**Rules**',
            '• Non-link messages are removed automatically',
            '• If you\'re below level 3, your post will be removed and you\'ll get a DM',
            '• If XP resets on the 1st of the month and you drop below level 3, your shoutouts pause until you re-earn the role',
        ].join('\n'));

    const sent = await ch.send({ embeds: [embed] });
    await ctx.pool.execute(
        'UPDATE stream_signup_config SET stream_signup_message_id = ? WHERE guild_id = ?',
        [sent.id, GUILD_ID]
    );
    log('signup', `instructional embed posted (msg=${sent.id}); events/streamSignupTracker.js now handles auto-subscribe`);
}

async function convertSuggestionsToForum(ctx) {
    log('sugg', 'Converting #suggestions to a forum channel');
    const old = ctx.guild.channels.cache.get(CHANNELS_EXISTING.suggestions);
    if (!old) {
        log('sugg', 'original #suggestions not found, creating fresh forum channel');
    }
    const parentId = old?.parentId || CHANNELS_EXISTING.communityCategory;
    const oldPos = old?.rawPosition ?? undefined;
    const oldTopic = old?.topic || 'Post ideas for the server. Each suggestion gets its own thread — upvote 👍 or 👎 to weigh in.';

    // Forum channels need a guidelines/topic. We'll also ship two sensible tags and a default reaction.
    const forum = await ctx.guild.channels.create({
        name: 'suggestions',
        type: ChannelType.GuildForum,
        parent: parentId,
        position: oldPos,
        topic: oldTopic,
        defaultReactionEmoji: { id: null, name: '👍' },
        availableTags: [
            { name: 'New',      moderated: false, emoji: { id: null, name: '✨' } },
            { name: 'Discussing', moderated: false, emoji: { id: null, name: '💬' } },
            { name: 'Accepted', moderated: true,  emoji: { id: null, name: '✅' } },
            { name: 'Rejected', moderated: true,  emoji: { id: null, name: '❌' } },
            { name: 'Implemented', moderated: true, emoji: { id: null, name: '🚀' } },
        ],
        defaultAutoArchiveDuration: 10080, // 7 days
        reason: 'Pac migration: convert #suggestions to a forum channel',
    });

    log('sugg', `created forum channel ${forum.name} (${forum.id})`);

    // Apply the lockdown pattern to the new channel: @everyone deny, Verified allow
    const everyone = ctx.guild.roles.everyone;
    const verifiedRole = ctx.guild.roles.cache.get('1457183768186982485');
    await forum.permissionOverwrites.edit(everyone,     { ViewChannel: false }, { reason: 'Pac lockdown baseline' });
    await forum.permissionOverwrites.edit(verifiedRole, { ViewChannel: true  }, { reason: 'Pac lockdown baseline' });

    // Delete the old text channel
    if (old) {
        await old.delete('Pac migration: replaced by forum channel').catch(e => log('sugg', `  old channel delete failed: ${e.message}`));
    }
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };
    log('main', `logged in as ${client.user.tag}`);

    const tasks = process.argv.slice(2).length ? process.argv.slice(2) : ['music', 'signup', 'suggestions'];
    try {
        for (const t of tasks) {
            switch (t) {
                case 'music':       await fixMusicPanel(ctx); break;
                case 'signup':      await fixStreamSignup(ctx); break;
                case 'suggestions': await convertSuggestionsToForum(ctx); break;
                default: log('main', `unknown task: ${t}`);
            }
        }
    } finally {
        try { await client.destroy(); } catch (_) {}
        try { await pool.end(); } catch (_) {}
    }
}

main().catch(err => { console.error('FATAL', err?.stack || err); process.exit(1); });
