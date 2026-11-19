/*
 * /music record (start | stop | status) and /music settings recording — see core/voice-recorder.js
 * for how a recording works and what protects the people being recorded.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../../utils/logger.js';
import {
    startRecording, stopRecording, recordingStatus, getRecordConfig, updateRecordConfig, mayRecord,
} from '../../core/voice-recorder.js';
import { effectiveMaxMinutes, uploadLimitBytes, maxMinutesForLimit, formatDuration, HARD_MAX_MINUTES } from '../../core/voice-recording-mixer.js';

const REC_COLOR = '#E74C3C';

export async function handleRecord(interaction) {
    const action = interaction.options.getString('action') || 'status';
    const guild = interaction.guild;
    const member = interaction.member;

    if (action === 'status') {
        const s = recordingStatus(guild.id);
        if (!s) {
            const cfg = await getRecordConfig(guild.id);
            return interaction.reply({
                content: cfg.enabled
                    ? `Nothing is being recorded. Recordings here can last up to **${effectiveMaxMinutes({ configured: cfg.maxMinutes, premiumTier: guild.premiumTier })} min**; start one with \`/music record action:Start\` from the voice channel you're in.`
                    : 'Nothing is being recorded, and recording is turned off on this server.',
                ephemeral: true,
            });
        }
        const embed = new EmbedBuilder().setColor(REC_COLOR).setTitle('🔴 Recording in progress')
            .addFields(
                { name: 'Channel', value: `${s.channel}`, inline: true },
                { name: 'Started by', value: `${s.starter}`, inline: true },
                { name: 'Elapsed', value: `${formatDuration(s.elapsedMs)} of ${s.maxMinutes} min`, inline: true },
                { name: 'Speakers so far', value: String(s.speakers), inline: true },
                { name: 'File goes to', value: s.outputChannel ? `${s.outputChannel}` : '—', inline: true },
            );
        return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    }

    if (action === 'stop') {
        const s = recordingStatus(guild.id);
        if (!s) return interaction.reply({ content: 'Nothing is being recorded.', ephemeral: true });
        const cfg = await getRecordConfig(guild.id);
        if (s.starter.id !== member.id && !mayRecord(member, cfg)) {
            return interaction.reply({ content: 'Only the person who started the recording, Manage Server, or the roles allowed to record can stop it.', ephemeral: true });
        }
        await interaction.deferReply();
        const result = await stopRecording(guild.id, { reason: 'stopped', stoppedBy: member.id });
        if (!result) return interaction.editReply({ content: 'The recording had already stopped.' });
        return interaction.editReply({
            content: `⏹️ Stopped recording ${s.channel} after ${formatDuration(result.durationMs)}.`
                + (result.delivered ? ' The file has been posted.' : result.speakers ? ' The file could not be posted — see the message above.' : ' Nobody spoke, so there is no file.'),
            allowedMentions: { parse: [] },
        });
    }

    // start
    await interaction.deferReply();
    try {
        const session = await startRecording({
            client: interaction.client,
            starter: member,
            textChannel: interaction.channel,
            minutes: interaction.options.getInteger('minutes'),
        });
        return interaction.editReply({
            content: `🔴 Recording ${session.channel} — up to **${session.maxMinutes} min**. Everyone in the channel has been told. `
                + 'Stop with `/music record action:Stop`; it also stops when the channel empties.',
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        if (!/^(Recording is turned off|Only members|Join the voice|Already recording|I'm |I don't have|Could not check)/.test(err.message)) {
            logger.error(`[Recorder] start failed in ${guild.id}: ${err.message}`, { stack: err.stack });
        }
        return interaction.editReply({ content: `❌ ${err.message}` });
    }
}

export async function handleRecordingSettings(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission to configure voice recording.', ephemeral: true });
    }
    const guild = interaction.guild;
    const enabled = interaction.options.getString('enabled');
    const output = interaction.options.getChannel('output_channel');
    const maxMinutes = interaction.options.getInteger('max_minutes');
    const allowRole = interaction.options.getRole('allow_role');
    const removeRole = interaction.options.getRole('remove_role');
    const clearOutput = interaction.options.getBoolean('clear_output_channel');

    const current = await getRecordConfig(guild.id);
    const changes = {};
    if (enabled) changes.is_enabled = enabled === 'on';
    if (output) {
        if (!output.isTextBased?.()) return interaction.reply({ content: 'The output channel has to be a text channel.', ephemeral: true });
        changes.output_channel_id = output.id;
    } else if (clearOutput) {
        changes.output_channel_id = null;
    }
    if (maxMinutes != null) changes.max_minutes = maxMinutes;
    if (allowRole || removeRole) {
        const roles = new Set(current.allowedRoleIds);
        if (allowRole) roles.add(allowRole.id);
        if (removeRole) roles.delete(removeRole.id);
        changes.allowed_role_ids = [...roles];
    }

    const cfg = Object.keys(changes).length ? await updateRecordConfig(guild.id, changes) : current;
    if (Object.keys(changes).length) logger.info(`[Recorder] settings changed in ${guild.id} by ${interaction.user.id}: ${JSON.stringify(changes)}`);

    const uploadCap = maxMinutesForLimit(uploadLimitBytes(guild.premiumTier));
    const effective = effectiveMaxMinutes({ configured: cfg.maxMinutes, premiumTier: guild.premiumTier });
    const embed = new EmbedBuilder().setColor(cfg.enabled ? REC_COLOR : '#95A5A6').setTitle('Voice recording settings')
        .setDescription(cfg.enabled
            ? 'Recording is **on**. Members below can record the voice channel they are in with `/music record action:Start`; everyone in the channel is told, and the bot shows 🔴 REC while it records.'
            : 'Recording is **off** — nobody can record. Turn it on with `enabled:On`.')
        .addFields(
            { name: 'Who can record', value: ['Members with **Manage Server**', ...cfg.allowedRoleIds.map(id => `<@&${id}>`)].join('\n') },
            { name: 'Recordings are posted to', value: cfg.outputChannelId ? `<#${cfg.outputChannelId}>` : 'the channel the recording was started from', inline: true },
            { name: 'Longest recording', value: `${effective} min${cfg.maxMinutes && cfg.maxMinutes > effective ? ` (set to ${cfg.maxMinutes}, but files over ${uploadCap} min don't fit this server's upload limit; hard cap ${HARD_MAX_MINUTES})` : ''}`, inline: true },
        )
        .setFooter({ text: 'The audio file is deleted from the bot once it is posted. Members who used /voice privacy opt-out are never recorded.' });
    return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}
