const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { synthesize, getAvailableVoices, getVoiceInfo } = require('../utils/piper-tts');
const { db } = require('../utils/db');
const { logger } = require('../utils/logger');
const path = require('path');

module.exports = {
    category: 'Voice & TTS',
    data: new SlashCommandBuilder()
        .setName('tts')
        .setDescription('Text-to-Speech commands using high-quality voices')
        .addSubcommand(subcommand =>
            subcommand
                .setName('say')
                .setDescription('Speak text in your voice channel')
                .addStringOption(option =>
                    option.setName('text')
                        .setDescription('The text to speak (max 500 characters)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('voice')
                        .setDescription('Voice to use')
                        .setRequired(false)
                        .addChoices(
                            { name: '🇺🇸 Ryan (Male, High Quality)', value: 'ryan' },
                            { name: '🇺🇸 Amy (Female)', value: 'amy' },
                            { name: '🇺🇸 Joe (Male)', value: 'joe' },
                            { name: '🇺🇸 Ljspeech (Female, HQ)', value: 'ljspeech' },
                            { name: '🇺🇸 John (Male)', value: 'john' },
                            { name: '🇺🇸 Danny (Male, Fast)', value: 'danny' },
                            { name: '🇺🇸 Kathleen (Female, Fast)', value: 'kathleen' },
                            { name: '🇺🇸 Kristin (Female)', value: 'kristin' },
                            { name: '🇺🇸 Bryce (Male, Deep)', value: 'bryce' },
                            { name: '🇺🇸 Norman (Male, Mature)', value: 'norman' },
                            { name: '🇬🇧 Alan (British Male)', value: 'alan' },
                            { name: '🇬🇧 Alba (British Female)', value: 'alba' },
                            { name: '🇬🇧 Aru (British Young Female)', value: 'aru' },
                            { name: '🇬🇧 Northern English Male', value: 'northern_english_male' },
                            { name: '🇬🇧 Southern English Female', value: 'southern_english_female' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('join')
                .setDescription('Join your voice channel'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('leave')
                .setDescription('Leave the voice channel'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('voices')
                .setDescription('List all available TTS voices'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('setvoice')
                .setDescription('Set your default TTS voice')
                .addStringOption(option =>
                    option.setName('voice')
                        .setDescription('Your preferred voice')
                        .setRequired(true)
                        .addChoices(
                            { name: '🇺🇸 Ryan (Male, HQ)', value: 'ryan' },
                            { name: '🇺🇸 Amy (Female)', value: 'amy' },
                            { name: '🇺🇸 Joe (Male)', value: 'joe' },
                            { name: '🇺🇸 Ljspeech (Female, HQ)', value: 'ljspeech' },
                            { name: '🇺🇸 John (Male)', value: 'john' },
                            { name: '🇺🇸 Danny (Male, Fast)', value: 'danny' },
                            { name: '🇺🇸 Kathleen (Female, Fast)', value: 'kathleen' },
                            { name: '🇺🇸 Kristin (Female)', value: 'kristin' },
                            { name: '🇺🇸 Bryce (Male, Deep)', value: 'bryce' },
                            { name: '🇺🇸 Norman (Male, Mature)', value: 'norman' },
                            { name: '🇬🇧 Alan (British Male)', value: 'alan' },
                            { name: '🇬🇧 Alba (British Female)', value: 'alba' },
                            { name: '🇬🇧 Aru (British Young Female)', value: 'aru' },
                            { name: '🇬🇧 Northern English Male', value: 'northern_english_male' },
                            { name: '🇬🇧 Southern English Female', value: 'southern_english_female' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('config')
                .setDescription('Configure TTS settings for this server (Admin only)')
                .addStringOption(option =>
                    option.setName('setting')
                        .setDescription('Setting to configure')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Enable/Disable TTS', value: 'enabled' },
                            { name: 'Set Cooldown', value: 'cooldown' },
                            { name: 'Set Max Length', value: 'max_length' }
                        ))
                .addStringOption(option =>
                    option.setName('value')
                        .setDescription('New value')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                case 'say':
                    await handleSay(interaction);
                    break;
                case 'join':
                    await handleJoin(interaction);
                    break;
                case 'leave':
                    await handleLeave(interaction);
                    break;
                case 'voices':
                    await handleVoices(interaction);
                    break;
                case 'setvoice':
                    await handleSetVoice(interaction);
                    break;
                case 'config':
                    await handleConfig(interaction);
                    break;
                default:
                    await interaction.reply({ content: 'Unknown subcommand', ephemeral: true });
            }
        } catch (error) {
            logger.error(`[TTS] Error in subcommand ${subcommand}:`, error);
            const errorMsg = { content: `An error occurred: ${error.message}`, ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(errorMsg);
            } else {
                await interaction.reply(errorMsg);
            }
        }
    },
};

// Store active connections
const connections = new Map();

async function handleSay(interaction) {
    await interaction.deferReply();

    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
        return interaction.editReply('❌ You need to be in a voice channel to use TTS!');
    }

    // Check server TTS config
    const [configs] = await db.execute(
        'SELECT * FROM tts_config WHERE guild_id = ?',
        [interaction.guild.id]
    );

    const config = configs[0] || { enabled: true, max_length: 500, cooldown_seconds: 5 };

    if (!config.enabled) {
        return interaction.editReply('❌ TTS is disabled on this server. An admin can enable it with `/tts config`.');
    }

    // Get text and voice
    const text = interaction.options.getString('text');
    let voice = interaction.options.getString('voice');

    if (text.length > config.max_length) {
        return interaction.editReply(`❌ Text is too long! Maximum length is ${config.max_length} characters.`);
    }

    // Check cooldown
    const [recent] = await db.execute(
        'SELECT created_at FROM tts_usage_log WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
        [interaction.guild.id, interaction.user.id]
    );

    if (recent[0]) {
        const timeSince = (Date.now() - new Date(recent[0].created_at).getTime()) / 1000;
        if (timeSince < config.cooldown_seconds) {
            const remaining = Math.ceil(config.cooldown_seconds - timeSince);
            return interaction.editReply(`❌ Cooldown active! Please wait ${remaining} seconds.`);
        }
    }

    // Get user's default voice if none specified
    if (!voice) {
        const [prefs] = await db.execute(
            'SELECT preferred_voice FROM user_tts_preferences WHERE user_id = ?',
            [interaction.user.id]
        );
        voice = prefs[0]?.preferred_voice || 'ryan';
    }

    try {
        // Generate TTS audio
        const audioPath = await synthesize(text, voice);

        // Join voice channel
        let connection = connections.get(interaction.guild.id);

        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
            connections.set(interaction.guild.id, connection);

            // Auto-disconnect after 30 seconds of inactivity
            connection.on(VoiceConnectionStatus.Ready, () => {
                setTimeout(() => {
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                        connection.destroy();
                        connections.delete(interaction.guild.id);
                    }
                }, 30000);
            });
        }

        // Create audio player
        const player = createAudioPlayer();
        const resource = createAudioResource(audioPath);

        player.play(resource);
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
            player.stop();
        });

        player.on('error', (error) => {
            logger.error('[TTS] Player error:', error);
        });

        // Log usage
        await db.execute(
            'INSERT INTO tts_usage_log (guild_id, user_id, voice_used, text_length, channel_id) VALUES (?, ?, ?, ?, ?)',
            [interaction.guild.id, interaction.user.id, voice, text.length, voiceChannel.id]
        );

        const voiceInfo = getVoiceInfo(voice);
        await interaction.editReply(`🔊 Speaking with voice: **${voiceInfo.flag} ${voice}** (${voiceInfo.gender})`);

    } catch (error) {
        logger.error('[TTS] Say error:', error);
        await interaction.editReply(`❌ Failed to generate speech: ${error.message}`);
    }
}

async function handleJoin(interaction) {
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
        return interaction.reply({ content: '❌ You need to be in a voice channel!', ephemeral: true });
    }

    let connection = connections.get(interaction.guild.id);

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        return interaction.reply({ content: '✅ Already connected to a voice channel!', ephemeral: true });
    }

    connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
    });

    connections.set(interaction.guild.id, connection);

    await interaction.reply(`✅ Joined ${voiceChannel.name}! Use \`/tts say\` to speak.`);
}

async function handleLeave(interaction) {
    const connection = connections.get(interaction.guild.id);

    if (!connection) {
        return interaction.reply({ content: '❌ Not connected to a voice channel!', ephemeral: true });
    }

    connection.destroy();
    connections.delete(interaction.guild.id);

    await interaction.reply('👋 Left the voice channel.');
}

async function handleVoices(interaction) {
    const voices = getAvailableVoices();

    // Group by locale
    const usVoices = voices.filter(v => v.locale === 'en_US');
    const gbVoices = voices.filter(v => v.locale === 'en_GB');

    const embed = new EmbedBuilder()
        .setTitle('🎙️ Available TTS Voices')
        .setDescription('Use `/tts say` with any of these voices!')
        .setColor('#5865F2')
        .addFields(
            {
                name: '🇺🇸 US English Voices',
                value: usVoices.map(v => `**${v.name}** - ${v.description} (${v.quality})`).join('\n') || 'None',
                inline: false
            },
            {
                name: '🇬🇧 British English Voices',
                value: gbVoices.map(v => `**${v.name}** - ${v.description} (${v.quality})`).join('\n') || 'None',
                inline: false
            }
        )
        .setFooter({ text: `${voices.length} voices available | 100% FREE` });

    await interaction.reply({ embeds: [embed] });
}

async function handleSetVoice(interaction) {
    const voice = interaction.options.getString('voice');

    const voiceInfo = getVoiceInfo(voice);
    if (!voiceInfo) {
        return interaction.reply({ content: '❌ Invalid voice!', ephemeral: true });
    }

    // Upsert user preference
    await db.execute(
        `INSERT INTO user_tts_preferences (user_id, preferred_voice)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE preferred_voice = ?`,
        [interaction.user.id, voice, voice]
    );

    await interaction.reply({
        content: `✅ Your default voice is now: **${voiceInfo.flag} ${voice}** (${voiceInfo.description})`,
        ephemeral: true
    });
}

async function handleConfig(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ You need **Manage Server** permission to configure TTS.', ephemeral: true });
    }

    const setting = interaction.options.getString('setting');
    const value = interaction.options.getString('value');

    // Ensure config exists
    await db.execute(
        `INSERT IGNORE INTO tts_config (guild_id) VALUES (?)`,
        [interaction.guild.id]
    );

    switch (setting) {
        case 'enabled':
            const enabled = value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes';
            await db.execute(
                'UPDATE tts_config SET enabled = ? WHERE guild_id = ?',
                [enabled, interaction.guild.id]
            );
            await interaction.reply(`✅ TTS ${enabled ? 'enabled' : 'disabled'} for this server.`);
            break;

        case 'cooldown':
            const cooldown = parseInt(value);
            if (isNaN(cooldown) || cooldown < 0 || cooldown > 60) {
                return interaction.reply({ content: '❌ Cooldown must be between 0 and 60 seconds.', ephemeral: true });
            }
            await db.execute(
                'UPDATE tts_config SET cooldown_seconds = ? WHERE guild_id = ?',
                [cooldown, interaction.guild.id]
            );
            await interaction.reply(`✅ TTS cooldown set to ${cooldown} seconds.`);
            break;

        case 'max_length':
            const maxLength = parseInt(value);
            if (isNaN(maxLength) || maxLength < 50 || maxLength > 1000) {
                return interaction.reply({ content: '❌ Max length must be between 50 and 1000 characters.', ephemeral: true });
            }
            await db.execute(
                'UPDATE tts_config SET max_length = ? WHERE guild_id = ?',
                [maxLength, interaction.guild.id]
            );
            await interaction.reply(`✅ TTS max length set to ${maxLength} characters.`);
            break;

        default:
            await interaction.reply({ content: '❌ Unknown setting!', ephemeral: true });
    }
}
