/*
 * /privacy — a member's own data, self-service. Works in servers and in DMs; every reply is
 * ephemeral. The logic lives in core/privacy-manager.js; the confirmation button for `delete`
 * is interactions/buttons/privacy_delete.js (custom id `privdel:<yes|no>:<userId>:<issuedAt>`).
 *
 *   /privacy status            what is switched on, last export/delete
 *   /privacy export            JSON file of everything held about you, by DM (once a day)
 *   /privacy delete            delete your data (confirmation button; once an hour)
 *   /privacy opt-out what:…    message logging / leaderboards / both
 *   /privacy opt-in  what:…    undo
 */

import {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
} from 'discord.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import {
    getStatus, buildExport, setOptOut, secondsSinceLast, KEPT_CATEGORIES, OPT_TARGETS,
    EXPORT_COOLDOWN_SECONDS, DELETE_COOLDOWN_SECONDS,
} from '../../core/privacy-manager.js';

const WHAT_CHOICES = [
    { name: 'Message logging — the bot keeps no copies of your messages', value: 'message-logging' },
    { name: 'Leaderboards — hide me from level, economy and emoji leaderboards', value: 'leaderboards' },
    { name: 'Both', value: 'all' },
];

const POLICY_URL = `${(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '')}/privacy`;

const relative = (secondsAgo) => `<t:${Math.floor(Date.now() / 1000 - secondsAgo)}:R>`;
const waitText = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m} minute(s)`;
};

export default {
    category: 'tools',
    data: new SlashCommandBuilder()
        .setName('privacy')
        .setDescription('See, export or delete the data this bot holds about you')
        .setDMPermission(true)
        .addSubcommand(s => s.setName('status').setDescription('Your privacy settings and what they mean'))
        .addSubcommand(s => s.setName('export').setDescription('Get a copy of your data as a JSON file (sent by DM)'))
        .addSubcommand(s => s.setName('delete').setDescription('Delete your data from this bot (asks you to confirm)'))
        .addSubcommand(s => s.setName('opt-out').setDescription('Stop a kind of data use')
            .addStringOption(o => o.setName('what').setDescription('What to opt out of').setRequired(true).addChoices(...WHAT_CHOICES)))
        .addSubcommand(s => s.setName('opt-in').setDescription('Undo an opt-out')
            .addStringOption(o => o.setName('what').setDescription('What to opt back in to').setRequired(true).addChoices(...WHAT_CHOICES))),

    cooldown: 5,

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            switch (sub) {
                case 'status': return await handleStatus(interaction);
                case 'export': return await handleExport(interaction);
                case 'delete': return await handleDelete(interaction);
                case 'opt-out': return await handleOpt(interaction, true);
                case 'opt-in': return await handleOpt(interaction, false);
            }
        } catch (error) {
            logger.error('[Privacy] Command failed', { sub, userId: interaction.user.id, error: error.message, stack: error.stack });
            const reply = { content: 'Something went wrong handling your privacy request. Nothing further was changed; please try again later.', ephemeral: true };
            if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
            else await interaction.reply(reply).catch(() => {});
        }
    },
};

async function handleStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const { settings, lastExport, lastDelete } = await getStatus(interaction.user.id);
    const msgOff = !!settings.opt_out_message_logging;
    const lbOff = !!settings.opt_out_leaderboards;

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('🔒 Your privacy settings')
        .setDescription('These apply in every server this bot is in.')
        .addFields(
            {
                name: `Message logging: ${msgOff ? '🚫 opted out' : '✅ on'}`,
                value: msgOff
                    ? 'The bot stores no copies of your messages or images. A server\'s delete/edit log can still show a message the bot saw while online, but nothing is kept.'
                    : 'Servers that use delete/edit logs keep a short-lived copy of your recent messages (at most 90 days) so moderators can see what was removed.',
            },
            {
                name: `Leaderboards: ${lbOff ? '🚫 hidden' : '✅ shown'}`,
                value: lbOff
                    ? 'You are left out of public level, economy and emoji leaderboards. Your progress is still counted.'
                    : 'You appear on level, economy and emoji leaderboards in servers that use them.',
            },
            { name: 'Last export', value: lastExport === null ? 'Never' : relative(lastExport), inline: true },
            { name: 'Last deletion', value: lastDelete === null ? 'Never' : relative(lastDelete), inline: true },
            {
                name: 'Commands',
                value: '`/privacy export` · `/privacy delete` · `/privacy opt-out` · `/privacy opt-in`\nVoice transcription and the chat reader have their own switch: `/voice privacy opt-out`.',
            },
        )
        .setFooter({ text: `Full policy: ${POLICY_URL}` });
    return interaction.editReply({ embeds: [embed] });
}

async function handleExport(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.user.id;

    const ago = await secondsSinceLast(userId, 'export');
    if (ago !== null && ago < EXPORT_COOLDOWN_SECONDS) {
        return interaction.editReply({
            content: `You can request one export a day. Your last one was ${relative(ago)}; try again in ${waitText(EXPORT_COOLDOWN_SECONDS - ago)}.`,
        });
    }

    await interaction.editReply({ content: '⏳ Gathering your data… this can take a minute.' });
    const { buffer, summary } = await buildExport(userId);
    const file = new AttachmentBuilder(buffer, { name: `certifried-data-${userId}.json` });
    const note = [
        `Your data: ${summary.rows} row(s) from ${summary.tables} table(s).`,
        summary.withheld ? `${summary.withheld} moderation/safety record(s) exist but are not included (counts are in the file).` : null,
        summary.truncated.length ? `Some tables were shortened to fit Discord's file limit: ${summary.truncated.slice(0, 10).join(', ')}.` : null,
    ].filter(Boolean).join('\n');

    try {
        await interaction.user.send({ content: `🔒 **Your CertiFried data export**\n${note}`, files: [file] });
        return interaction.editReply({ content: `✅ Sent to your DMs.\n${note}` });
    } catch (error) {
        // DMs closed: an ephemeral reply is just as private — only you can see it.
        logger.info('[Privacy] Export DM failed, replying ephemerally', { userId, error: error.message });
        return interaction.editReply({
            content: `Your DMs are closed, so here is the file (only you can see this message).\n${note}`,
            files: [new AttachmentBuilder(buffer, { name: `certifried-data-${userId}.json` })],
        });
    }
}

async function handleDelete(interaction) {
    const userId = interaction.user.id;
    const ago = await secondsSinceLast(userId, 'delete');
    if (ago !== null && ago < DELETE_COOLDOWN_SECONDS) {
        return interaction.reply({
            content: `Your data was deleted ${relative(ago)}. You can run this again in ${waitText(DELETE_COOLDOWN_SECONDS - ago)}.`,
            ephemeral: true,
        });
    }

    const issued = Math.floor(Date.now() / 1000);
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'danger'))
        .setTitle('⚠️ Delete your data?')
        .setDescription([
            'This removes, in **every** server this bot is in:',
            '• cached copies of your messages and images, activity, message, voice and emoji statistics, voice transcripts',
            '• levels/XP, economy balances and history, achievements, game progress and inventories',
            '• your birthday, timezone, AI-assistant memory, mood/productivity entries and other preferences',
            '• links to Steam, Spotify, Last.fm, Twitch and similar accounts',
            '• your Greenhouse Tycoon save, including the Twitch and Kick sign-ins linked to it, and anything left from the old CertiFried Tycoon game',
            'Songs you requested stay in music history without your name.',
            '',
            '**This cannot be undone.** Level roles or perks tied to your progress may be lost, and servers that prune inactive members may then see you as inactive.',
        ].join('\n'))
        .addFields({ name: 'Kept', value: KEPT_CATEGORIES.map(k => `• ${k}`).join('\n').slice(0, 1024) })
        .setFooter({ text: 'Want a copy first? Cancel and run /privacy export. This prompt expires in 10 minutes.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`privdel:yes:${userId}:${issued}`).setLabel('Delete my data').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`privdel:no:${userId}:${issued}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleOpt(interaction, optOut) {
    await interaction.deferReply({ ephemeral: true });
    const what = interaction.options.getString('what', true);
    const { purgedMessages, targets } = await setOptOut(interaction.user.id, what, optOut);
    const labels = targets.map(t => OPT_TARGETS[t].label).join(' and ');

    const lines = [optOut ? `🚫 Opted out of **${labels}**.` : `✅ Opted back in to **${labels}**.`];
    if (optOut && targets.includes('message-logging')) {
        lines.push(`The bot will no longer store copies of your messages or images. ${purgedMessages} cached message(s) were removed now.`);
        lines.push('Copies of messages that were already deleted and logged by a server are moderation records and expire with that server\'s log retention.');
    }
    if (optOut && targets.includes('leaderboards')) {
        lines.push('You are hidden from public level, economy and emoji leaderboards. Your progress still counts.');
    }
    if (!optOut && targets.includes('message-logging')) {
        lines.push('Servers\' delete/edit logs can show your recent messages again (kept at most 90 days).');
    }
    return interaction.editReply({ content: lines.join('\n') });
}
