/*
 * /voice reader | transcribe | privacy — chat-to-voice and live transcription.
 * The managers do the work (core/voice-reader-manager.js, core/voice-transcription-manager.js);
 * this file is argument handling and the replies people see.
 */

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import logger from '../../utils/logger.js';
import { getVoiceInfo } from '../../utils/piper-tts.js';
import { getReaderConfig, saveReaderConfig, skipReader, getUserVoice, setUserVoice, getUserSpokenName, setUserSpokenName } from '../../core/voice-reader-manager.js';
import { speakableName } from '../../utils/speech-text.js';
import { getGuildQueue } from '../../core/voice-connection-share.js';
import {
    startSession, stopSession, getSession, setOptOut, isOptedOut, canControl, getTranscriptionConfig,
} from '../../core/voice-transcription-manager.js';
import { whisperAvailable } from '../../utils/whisper-stt.js';
import { handleAutocomplete as ttsVoiceAutocomplete } from '../tools/tools-tts-handler.js';

const EPHEMERAL = 64;
const truthy = v => v === 1 || v === true || v === '1';

function idList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(String);
    try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return String(v).split(',').filter(Boolean); }
}

/** A voice that may be picked now (Kokoro voices only while the Kokoro model is installed). */
function usableVoice(voice) {
    const info = getVoiceInfo(voice);
    return !!info && info.installed !== false;
}

/** "Michael (Kokoro, US)" for a Kokoro voice, the id for a Piper one. */
function voiceName(voice) {
    return getVoiceInfo(voice)?.displayName || voice;
}

function isManager(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

// ── reader ────────────────────────────────────────────────────────────────────────────

async function readerEnable(interaction) {
    if (!isManager(interaction)) {
        return interaction.reply({ content: 'You need **Manage Server** to set up the chat reader.', flags: EPHEMERAL });
    }
    const guildId = interaction.guild.id;
    const current = await getReaderConfig(guildId);
    const patch = { enabled: 1 };

    const textChannel = interaction.options.getChannel('text_channel');
    const voiceChannel = interaction.options.getChannel('voice_channel');
    const voice = interaction.options.getString('voice');
    const readNames = interaction.options.getBoolean('read_names');
    const followAuthor = interaction.options.getBoolean('follow_author');
    const requireInVoice = interaction.options.getBoolean('require_in_voice');
    const reactions = interaction.options.getBoolean('reactions');

    if (textChannel) {
        const list = idList(current.text_channels);
        if (!list.includes(textChannel.id)) list.push(textChannel.id);
        patch.text_channels = JSON.stringify(list);
    }
    if (voiceChannel) patch.voice_channel_id = voiceChannel.id;
    if (voice) {
        if (!usableVoice(voice)) {
            return interaction.reply({ content: `No voice called **${voice}** — see \`/tools tts voices\`.`, flags: EPHEMERAL });
        }
        patch.voice = voice;
    }
    if (readNames !== null) patch.read_names = readNames ? 1 : 0;
    if (followAuthor !== null) patch.follow_author = followAuthor ? 1 : 0;
    if (requireInVoice !== null) patch.require_in_voice = requireInVoice ? 1 : 0;
    if (reactions !== null) patch.reactions = reactions ? 1 : 0;

    await saveReaderConfig(guildId, patch);
    return interaction.reply({ content: `✅ Chat reader is **on**.\n${await describeReader(interaction.guild)}`, flags: EPHEMERAL });
}

async function readerDisable(interaction) {
    if (!isManager(interaction)) {
        return interaction.reply({ content: 'You need **Manage Server** to change the chat reader.', flags: EPHEMERAL });
    }
    const textChannel = interaction.options.getChannel('text_channel');
    if (textChannel) {
        const current = await getReaderConfig(interaction.guild.id);
        const list = idList(current.text_channels).filter(id => id !== textChannel.id);
        await saveReaderConfig(interaction.guild.id, { text_channels: list.length ? JSON.stringify(list) : null });
        return interaction.reply({ content: `Stopped reading ${textChannel}.\n${await describeReader(interaction.guild)}`, flags: EPHEMERAL });
    }
    await saveReaderConfig(interaction.guild.id, { enabled: 0 });
    skipReader(interaction.guild.id);
    return interaction.reply({ content: '⏹️ Chat reader is **off**.', flags: EPHEMERAL });
}

async function describeReader(guild) {
    const cfg = await getReaderConfig(guild.id);
    const channels = idList(cfg.text_channels);
    const lines = [
        `**Status:** ${truthy(cfg.enabled) ? 'on' : 'off'}`,
        channels.length
            ? `**Reads:** ${channels.map(id => `<#${id}>`).join(', ')}`
            : '**Reads:** each voice channel\'s own chat, into that voice channel',
    ];
    if (channels.length) {
        lines.push(truthy(cfg.follow_author)
            ? `**Speaks in:** the author's voice channel${cfg.voice_channel_id ? `, otherwise <#${cfg.voice_channel_id}>` : ''}`
            : `**Speaks in:** ${cfg.voice_channel_id ? `<#${cfg.voice_channel_id}>` : '⚠️ no voice channel set — add one with `voice_channel`'}`);
    }
    lines.push(`**Voice:** ${cfg.voice ? voiceName(cfg.voice) : 'server default'} (members can pick their own with \`/voice reader my-voice\`) · **Names:** ${truthy(cfg.read_names) ? 'read' : 'not read'} · **Author must be in voice:** ${truthy(cfg.require_in_voice) ? 'yes' : 'no'} · **🗣/🙊 reactions:** ${truthy(cfg.reactions) ? 'on' : 'off'}`);
    lines.push('It stays quiet while music is playing. More options on the dashboard (Voice Chat Reader).');
    return lines.join('\n');
}

async function disconnect(interaction) {
    const guild = interaction.guild;
    const botChannel = guild.members.me?.voice?.channel;
    if (!botChannel) return interaction.reply({ content: 'I\'m not in a voice channel here.', flags: EPHEMERAL });

    const sameRoom = interaction.member?.voice?.channelId === botChannel.id;
    if (!sameRoom && !isManager(interaction)) {
        return interaction.reply({ content: `Join ${botChannel} to disconnect me, or ask someone with **Manage Server**.`, flags: EPHEMERAL });
    }
    const queue = getGuildQueue(interaction.client, guild.id);
    if (queue?.isPlaying() && queue.currentTrack) {
        return interaction.reply({ content: 'Music is playing — stop it with the music controls first.', flags: EPHEMERAL });
    }

    await interaction.deferReply({ flags: EPHEMERAL });
    const hadSession = await stopSession(guild.id, 'disconnected');
    skipReader(guild.id);
    try { queue?.delete(); } catch { guild.members.me?.voice?.disconnect().catch(() => {}); }
    if (!queue) await guild.members.me?.voice?.disconnect().catch(() => {});
    return interaction.editReply(`👋 Disconnected from ${botChannel}.${hadSession ? ' Transcription stopped and the transcript was posted.' : ''}`);
}

async function readerStatus(interaction) {
    return interaction.reply({ content: await describeReader(interaction.guild), flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

async function readerMyVoice(interaction) {
    const voice = interaction.options.getString('voice');
    if (interaction.options.getBoolean('clear') || voice === 'clear') {
        await setUserVoice(interaction.user.id, null);
        return interaction.reply({ content: 'Cleared — your messages use the server\'s reader voice again.', flags: EPHEMERAL });
    }
    if (!voice) {
        const current = await getUserVoice(interaction.user.id);
        return interaction.reply({
            content: current
                ? `Your reader voice is **${voiceName(current)}**. Pick another with \`voice\`, or \`/voice reader my-voice clear:true\` to use the server's.`
                : 'You\'re using the server\'s reader voice. Pick your own with the `voice` option — `/tools tts preview` to hear them.',
            flags: EPHEMERAL,
        });
    }
    if (!usableVoice(voice)) {
        return interaction.reply({ content: `No voice called **${voice}** — see \`/tools tts voices\`.`, flags: EPHEMERAL });
    }
    await setUserVoice(interaction.user.id, voice);
    return interaction.reply({ content: `🗣️ Your messages will be read as **${voiceName(voice)}**, in every server with the reader on.`, flags: EPHEMERAL });
}

async function readerMyName(interaction) {
    const name = interaction.options.getString('name');
    if (interaction.options.getBoolean('clear')) {
        await setUserSpokenName(interaction.user.id, null);
        return interaction.reply({ content: 'Cleared. The reader says your display name again.', flags: EPHEMERAL });
    }
    const auto = speakableName(interaction.member?.displayName || interaction.user.username) || 'Someone';
    if (!name) {
        const current = await getUserSpokenName(interaction.user.id);
        return interaction.reply({
            content: current
                ? `The reader calls you **${current}** in every server. Change it with \`name\`, or \`clear:true\` to go back to **${auto}**.`
                : `The reader calls you **${auto}** here. If that comes out wrong, spell it how it sounds with \`name\` (e.g. \`Kay-oss\`).`,
            flags: EPHEMERAL,
        });
    }
    const spoken = name.replace(/[<>@#*_`~|\n]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/[\p{L}]/u.test(spoken)) {
        return interaction.reply({ content: 'That needs at least one letter. Spell your name the way it sounds.', flags: EPHEMERAL });
    }
    await setUserSpokenName(interaction.user.id, spoken);
    return interaction.reply({ content: `🗣️ The reader will call you **${spoken}**, in every server with the reader on.`, flags: EPHEMERAL });
}

async function readerSkip(interaction) {
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionFlagsBits.ManageGuild) && !perms?.has(PermissionFlagsBits.MuteMembers)) {
        return interaction.reply({ content: 'You need **Mute Members** to skip the reader.', flags: EPHEMERAL });
    }
    skipReader(interaction.guild.id);
    return interaction.reply({ content: '⏭️ Skipped — anything queued was cleared.', flags: EPHEMERAL });
}

// ── transcribe ────────────────────────────────────────────────────────────────────────

async function transcribeStart(interaction) {
    if (!(await canControl(interaction.member))) {
        return interaction.reply({ content: 'Only staff can start transcription (**Manage Server**, or the server\'s transcription role).', flags: EPHEMERAL });
    }
    const channel = interaction.options.getChannel('channel') ?? interaction.member?.voice?.channel;
    if (!channel?.isVoiceBased?.()) {
        return interaction.reply({ content: 'Join a voice channel first, or pick one with `channel`.', flags: EPHEMERAL });
    }
    const captionOption = interaction.options.getChannel('captions');
    const captionChannel = captionOption ?? (interaction.channel?.isTextBased?.() ? interaction.channel : null);

    await interaction.deferReply({ flags: EPHEMERAL });
    try {
        // Resolve through the client that owns this guild so the voice adapter is the right bot's.
        const session = await startSession({
            client: interaction.client,
            channel,
            starter: interaction.member,
            captionChannel,
        });
        const where = session.captionChannel ? ` Captions → ${session.captionChannel}.` : '';
        return interaction.editReply(`🔴 Transcribing ${channel}.${where} Everyone in the channel has been told, and \`/voice transcribe stop\` ends it.`);
    } catch (err) {
        logger.warn(`[Transcribe] Start failed in ${interaction.guild.id}: ${err.message}`);
        return interaction.editReply(`❌ ${err.message}`);
    }
}

async function transcribeStop(interaction) {
    const session = getSession(interaction.guild.id);
    if (!session) return interaction.reply({ content: 'Nothing is being transcribed in this server.', flags: EPHEMERAL });
    // The person who started it can always stop it, as can staff.
    if (session.starter.id !== interaction.user.id && !(await canControl(interaction.member))) {
        return interaction.reply({ content: 'Only staff or the person who started it can stop transcription.', flags: EPHEMERAL });
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    await stopSession(interaction.guild.id, 'stopped');
    return interaction.editReply('⏹️ Transcription stopped. The transcript has been posted.');
}

async function transcribeStatus(interaction) {
    const session = getSession(interaction.guild.id);
    const cfg = await getTranscriptionConfig(interaction.guild.id);
    const model = cfg.model === 'accurate' ? 'accurate' : 'fast';
    const online = await whisperAvailable(model);
    const lines = [];
    if (session) {
        const mins = Math.round((Date.now() - session.startedAt) / 60000);
        lines.push(`🔴 Transcribing ${session.channel} for ${mins} min — ${session.segments.length} phrase(s) so far.`);
        if (await canControl(interaction.member)) lines.push(`-# Pipeline: ${session.diagnostics()}`);
    } else {
        lines.push('Not transcribing right now.');
    }
    lines.push(`**Allowed here:** ${truthy(cfg.enabled) ? 'yes' : 'no (turned off on the dashboard)'}`);
    lines.push(`**Speech model:** ${model} (${online ? 'online' : '⚠️ offline'})`);
    lines.push(`**Captions:** ${cfg.caption_channel_id ? `<#${cfg.caption_channel_id}>` : 'the channel you start it from'}`);
    lines.push(`**Transcripts kept:** ${cfg.retention_days} days`);
    return interaction.reply({ content: lines.join('\n'), flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

// ── privacy ───────────────────────────────────────────────────────────────────────────

async function privacy(interaction, sub) {
    if (sub === 'status') {
        return interaction.reply({
            content: isOptedOut(interaction.user.id)
                ? '🔕 You are **opted out** — your voice is never transcribed and your messages are never read aloud, in any server.'
                : '🔔 You can be transcribed when staff start a session in a channel you\'re in, and the chat reader may read your messages aloud. `/voice privacy opt-out` stops both, everywhere.',
            flags: EPHEMERAL,
        });
    }
    const out = sub === 'opt-out';
    await setOptOut(interaction.user.id, out);
    return interaction.reply({
        content: out
            ? '🔕 Opted out. Your voice won\'t be transcribed and your messages won\'t be read aloud, in any server — this already applies right now.'
            : '🔔 Opted back in. You may be transcribed when staff start a session, and the chat reader may read your messages aloud.',
        flags: EPHEMERAL,
    });
}

/** @returns {Promise<boolean>} whether this interaction was a voice-tools subcommand */
export async function handleVoiceTools(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (!group && sub === 'disconnect') {
        await disconnect(interaction);
        return true;
    }
    if (!['reader', 'transcribe', 'privacy'].includes(group)) return false;

    if (group === 'reader') {
        if (sub === 'enable') await readerEnable(interaction);
        else if (sub === 'disable') await readerDisable(interaction);
        else if (sub === 'skip') await readerSkip(interaction);
        else if (sub === 'my-voice') await readerMyVoice(interaction);
        else if (sub === 'my-name') await readerMyName(interaction);
        else await readerStatus(interaction);
    } else if (group === 'transcribe') {
        if (sub === 'start') await transcribeStart(interaction);
        else if (sub === 'stop') await transcribeStop(interaction);
        else await transcribeStatus(interaction);
    } else {
        await privacy(interaction, sub);
    }
    return true;
}

/** Adds the reader/transcribe/privacy groups to the /voice builder. */
export function addVoiceToolGroups(builder) {
    const voiceTypes = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
    const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice];
    return builder
        .addSubcommand(s => s.setName('disconnect').setDescription('Make the bot leave voice (stops the reader and any transcription).'))
        .addSubcommandGroup(g => g
            .setName('reader').setDescription('Read a text channel aloud in voice.')
            .addSubcommand(s => s
                .setName('enable').setDescription('Turn the chat reader on, optionally adding a channel to read.')
                .addChannelOption(o => o.setName('text_channel').setDescription('A text channel to read (default: each voice channel\'s own chat).').addChannelTypes(...textTypes))
                .addChannelOption(o => o.setName('voice_channel').setDescription('Where to speak when the author isn\'t in voice.').addChannelTypes(...voiceTypes))
                .addStringOption(o => o.setName('voice').setDescription('Voice to read with (Piper, or the more natural Kokoro voices).').setAutocomplete(true))
                .addBooleanOption(o => o.setName('read_names').setDescription('Say who wrote each message.'))
                .addBooleanOption(o => o.setName('follow_author').setDescription('Speak in the voice channel the author is in.'))
                .addBooleanOption(o => o.setName('require_in_voice').setDescription('Only read people who are in that voice channel.'))
                .addBooleanOption(o => o.setName('reactions').setDescription('React 🗣️ while reading and 🙊 when done.')))
            .addSubcommand(s => s
                .setName('disable').setDescription('Turn the reader off, or stop reading one channel.')
                .addChannelOption(o => o.setName('text_channel').setDescription('Stop reading just this channel.').addChannelTypes(...textTypes)))
            .addSubcommand(s => s.setName('skip').setDescription('Stop the message being read and clear the queue.'))
            .addSubcommand(s => s
                .setName('my-voice').setDescription('Pick the voice your own messages are read in (every server).')
                .addStringOption(o => o.setName('voice').setDescription('Voice name — leave empty to see your current one.').setAutocomplete(true))
                .addBooleanOption(o => o.setName('clear').setDescription('Go back to the server\'s voice.')))
            .addSubcommand(s => s
                .setName('my-name').setDescription('How the reader says your name (every server).')
                .addStringOption(o => o.setName('name').setDescription('Spell it how it sounds, e.g. Kay-oss. Empty shows the current one.').setMaxLength(64))
                .addBooleanOption(o => o.setName('clear').setDescription('Go back to your display name.')))
            .addSubcommand(s => s.setName('status').setDescription('Show how the reader is set up.')))
        .addSubcommandGroup(g => g
            .setName('transcribe').setDescription('Live captions and a transcript of a voice channel.')
            .addSubcommand(s => s
                .setName('start').setDescription('Start transcribing a voice channel (staff).')
                .addChannelOption(o => o.setName('channel').setDescription('Voice channel (default: the one you\'re in).').addChannelTypes(...voiceTypes))
                .addChannelOption(o => o.setName('captions').setDescription('Where live captions go (default: here).').addChannelTypes(...textTypes)))
            .addSubcommand(s => s.setName('stop').setDescription('Stop transcribing and post the transcript.'))
            .addSubcommand(s => s.setName('status').setDescription('Is anything being transcribed?')))
        .addSubcommandGroup(g => g
            .setName('privacy').setDescription('Keep yourself out of transcription and the chat reader.')
            .addSubcommand(s => s.setName('opt-out').setDescription('Never transcribe me or read my messages aloud, in any server.'))
            .addSubcommand(s => s.setName('opt-in').setDescription('Allow transcription and the chat reader for me again.'))
            .addSubcommand(s => s.setName('status').setDescription('Am I opted out?')));
}

export async function voiceToolsAutocomplete(interaction) {
    return ttsVoiceAutocomplete(interaction);
}
