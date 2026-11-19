/**
 * /alerts clips — manage Twitch clip feeds (jobs/twitch-clip-checker.js).
 *
 * All the rules live in core/twitch-clip-feeds.js so the dashboard page behaves the
 * same way. The one users notice: a feed only ever posts clips made AFTER it was
 * switched on, so turning it on right after uploading a batch posts none of the batch.
 */

import { EmbedBuilder } from 'discord.js';
import logger from '../../../utils/logger.js';
import {
    createFeed, listFeeds, updateFeed, deleteFeed, previewFeed, ClipFeedError,
} from '../../../core/twitch-clip-feeds.js';

const TWITCH_PURPLE = 0x9146FF;

const ts = d => d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : 'never';
const filterLabel = f => f === 'broadcaster_only' ? 'streamer\'s own clips' : 'anyone\'s clips';

export async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    try {
        switch (sub) {
            case 'add':     return await add(interaction);
            case 'list':    return await list(interaction);
            case 'edit':    return await edit(interaction);
            case 'toggle':  return await toggle(interaction);
            case 'remove':  return await remove(interaction);
            case 'preview': return await preview(interaction);
            default:        return interaction.editReply(`Unknown subcommand \`${sub}\``);
        }
    } catch (err) {
        if (err instanceof ClipFeedError) return interaction.editReply(err.message);
        logger.error('[Alerts clips] Error:', { sub, error: err.message, stack: err.stack });
        return interaction.editReply(`Something went wrong: ${err.message}`);
    }
}

async function add(interaction) {
    const channel = interaction.options.getChannel('channel');
    const feed = await createFeed({
        guildId: interaction.guild.id,
        channelId: channel.id,
        streamer: interaction.options.getString('streamer'),
        creatorsFilter: interaction.options.getString('who') || 'anyone',
        minViews: interaction.options.getInteger('min-views') || 0,
        client: interaction.client,
    });

    const embed = new EmbedBuilder()
        .setColor(TWITCH_PURPLE)
        .setTitle(`Posting ${feed.display_name}'s clips`)
        .setURL(`https://twitch.tv/${feed.login}`)
        .setDescription(
            `New clips will post to ${channel}, checked every 10 minutes.\n\n` +
            'Only clips made **from now on** are posted. Clips that already exist are skipped.'
        )
        .addFields({ name: 'Feed ID', value: `\`${feed.id}\``, inline: true })
        .setFooter({ text: 'Manage feeds here or on the dashboard: Twitch Clips' });
    return interaction.editReply({ embeds: [embed] });
}

async function list(interaction) {
    const feeds = await listFeeds(interaction.guild.id);
    if (!feeds.length) {
        return interaction.editReply('No clip feeds yet. Add one with `/alerts clips add streamer: channel:`.');
    }
    const lines = feeds.map(f =>
        `\`${String(f.id).padStart(3)}\` **${f.username}** → <#${f.channel_id}> · ${f.enabled ? 'on' : '**paused**'}` +
        ` · ${filterLabel(f.creators_filter)}${f.min_views ? ` · ≥${f.min_views} views` : ''}` +
        `\n  ${f.posted_count} posted · last ${ts(f.last_posted)} · counting from ${ts(f.posted_from)}`
    );
    const embed = new EmbedBuilder()
        .setColor(TWITCH_PURPLE)
        .setTitle(`Twitch clip feeds: ${feeds.length}`)
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: 'Use the feed ID with edit / toggle / remove / preview' });
    return interaction.editReply({ embeds: [embed] });
}

async function edit(interaction) {
    const id = interaction.options.getInteger('id');
    const changes = {};
    const channel = interaction.options.getChannel('channel');
    if (channel) changes.channelId = channel.id;
    const streamer = interaction.options.getString('streamer');
    if (streamer) changes.streamer = streamer;
    const who = interaction.options.getString('who');
    if (who) changes.creatorsFilter = who;
    const minViews = interaction.options.getInteger('min-views');
    if (minViews !== null) changes.minViews = minViews;

    if (!Object.keys(changes).length) {
        return interaction.editReply('Nothing to change. Pass at least one of `channel`, `streamer`, `who` or `min-views`.');
    }
    const { row, watermarkMoved } = await updateFeed(interaction.guild.id, id, changes, { client: interaction.client });
    return interaction.editReply(
        `Feed \`${id}\` updated: **${row.username}** → <#${row.channel_id}>, ${filterLabel(row.creators_filter)}` +
        `${row.min_views ? `, at least ${row.min_views} views` : ''}.` +
        (watermarkMoved ? '\nNew streamer, so it counts from now. Their existing clips will not be posted.' : '')
    );
}

async function toggle(interaction) {
    const id = interaction.options.getInteger('id');
    const enabled = interaction.options.getBoolean('enabled');
    const { row, watermarkMoved } = await updateFeed(interaction.guild.id, id, { enabled });
    return interaction.editReply(
        `Feed \`${id}\` (**${row.username}**) is now **${enabled ? 'on' : 'paused'}**.` +
        (watermarkMoved ? '\nClips made while it was paused will not be posted. It counts from now.' : '')
    );
}

async function remove(interaction) {
    const id = interaction.options.getInteger('id');
    await deleteFeed(interaction.guild.id, id);
    return interaction.editReply(`Feed \`${id}\` removed. It stops posting right away.`);
}

async function preview(interaction) {
    const id = interaction.options.getInteger('id');
    const p = await previewFeed(interaction.guild.id, id);
    const fmt = c => `• [${(c.title || 'Untitled').slice(0, 80)}](${c.url}) · ${c.views} views · by ${c.creator}`;

    const embed = new EmbedBuilder()
        .setColor(TWITCH_PURPLE)
        .setTitle(`${p.feed.username}: ${p.total} clip(s) since ${new Date(p.since).toISOString().slice(0, 10)}`)
        .setFooter({ text: 'Nothing was posted. Waiting clips go out on the next 10-minute check.' });
    if (p.waiting.length) embed.addFields({ name: `Waiting (${p.waiting.length})`, value: p.waiting.slice(0, 8).map(fmt).join('\n').slice(0, 1024) });
    if (p.posted.length) embed.addFields({ name: `Already posted (${p.posted.length})`, value: p.posted.slice(-5).map(fmt).join('\n').slice(0, 1024) });
    if (p.filtered_out) embed.addFields({ name: 'Skipped by your filters', value: String(p.filtered_out) });
    if (!p.total) embed.setDescription('No clips have been made since this feed started counting.');
    return interaction.editReply({ embeds: [embed] });
}

export default { execute };
