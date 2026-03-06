import { EmbedBuilder, ChannelType } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOUNDS_DIR = path.join(__dirname, '..', '..', 'sounds');

function getManager(interaction) {
    const vcSoundManager = interaction.client.vcSoundManager;
    if (!vcSoundManager) {
        interaction.reply({ content: 'VC Sound system is not initialized.', ephemeral: true });
        return null;
    }
    return vcSoundManager;
}

export async function handleEnable(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const mode = interaction.options.getString('mode');
    await mgr.enable(interaction.guild.id, mode);

    const embed = new EmbedBuilder()
        .setTitle('VC Sound Drops Enabled')
        .setDescription(`Sound drops are now **enabled** in **${mode}** mode.`)
        .setColor(0x00ff00)
        .addFields(
            { name: 'Mode', value: mode, inline: true },
            { name: 'Next Steps', value: mode === 'scheduled'
                ? 'Use `/admin vcsounds schedule` to set drop times'
                : 'Use `/admin vcsounds interval` to adjust timing, or add sounds with `/admin vcsounds addsound`'
            }
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

export async function handleDisable(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    await mgr.disable(interaction.guild.id);
    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('VC Sound Drops Disabled')
            .setColor(0xff0000)
            .setTimestamp()
        ]
    });
}

export async function handleStatus(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const guildId = interaction.guild.id;
    const config = await mgr.getConfig(guildId);
    const sounds = await mgr.getSounds(guildId);

    if (!config) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle('VC Sound Drops')
                .setDescription('Not configured. Use `/admin vcsounds enable` to get started.')
                .setColor(0x808080)
            ]
        });
    }

    const embed = new EmbedBuilder()
        .setTitle('VC Sound Drop Configuration')
        .setColor(config.enabled ? 0x00ff00 : 0xff0000)
        .addFields(
            { name: 'Status', value: config.enabled ? 'Enabled' : 'Disabled', inline: true },
            { name: 'Mode', value: config.mode || 'random', inline: true },
            { name: 'Volume', value: `${Math.round((config.volume || 0.5) * 100)}%`, inline: true },
            { name: 'Random Interval', value: `${config.min_interval_minutes}-${config.max_interval_minutes} min`, inline: true },
            { name: 'Min Users', value: `${config.min_users_in_vc || 1}`, inline: true },
            { name: 'Leave After', value: `${config.leave_after_seconds || 5}s`, inline: true },
            { name: 'Sounds', value: `${sounds.length} available`, inline: true },
            { name: 'Scheduled Times', value: config.schedule_times?.length > 0
                ? config.schedule_times.join(', ')
                : 'None set', inline: true
            },
            { name: 'Blacklisted Channels', value: config.blacklisted_channels?.length > 0
                ? config.blacklisted_channels.map(id => `<#${id}>`).join(', ')
                : 'None'
            }
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

export async function handleInterval(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const min = interaction.options.getInteger('min');
    const max = interaction.options.getInteger('max');

    if (min >= max) {
        return interaction.reply({ content: 'Minimum interval must be less than maximum.', ephemeral: true });
    }

    await mgr.updateConfig(interaction.guild.id, {
        min_interval_minutes: min,
        max_interval_minutes: max
    });

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Interval Updated')
            .setDescription(`Random drops will occur every **${min}-${max} minutes** on average.`)
            .setColor(0x00bfff)
            .setTimestamp()
        ]
    });
}

export async function handleSchedule(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const timesStr = interaction.options.getString('times');
    const times = timesStr.split(',').map(t => t.trim());

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const invalid = times.filter(t => !timeRegex.test(t));
    if (invalid.length > 0) {
        return interaction.reply({
            content: `Invalid time format: ${invalid.join(', ')}. Use 24h format like "17:00".`,
            ephemeral: true
        });
    }

    await mgr.updateConfig(interaction.guild.id, { schedule_times: times });

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Schedule Updated')
            .setDescription(`Sound drops scheduled at: **${times.join(', ')}** (server time)`)
            .setColor(0x00bfff)
            .setTimestamp()
        ]
    });
}

export async function handleVolume(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const level = interaction.options.getInteger('level');
    await mgr.updateConfig(interaction.guild.id, { volume: level / 100 });

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Volume Updated')
            .setDescription(`Playback volume set to **${level}%**`)
            .setColor(0x00bfff)
            .setTimestamp()
        ]
    });
}

export async function handleMinusers(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const count = interaction.options.getInteger('count');
    await mgr.updateConfig(interaction.guild.id, { min_users_in_vc: count });

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Minimum Users Updated')
            .setDescription(`Sound drops require at least **${count}** non-bot user(s) in a voice channel.`)
            .setColor(0x00bfff)
            .setTimestamp()
        ]
    });
}

export async function handleBlacklist(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const guildId = interaction.guild.id;
    const channel = interaction.options.getChannel('channel');
    const config = await mgr.getConfig(guildId);
    const blacklist = config?.blacklisted_channels || [];

    if (blacklist.includes(channel.id)) {
        return interaction.reply({ content: `${channel} is already blacklisted.`, ephemeral: true });
    }

    blacklist.push(channel.id);
    await mgr.enable(guildId, config?.mode || 'random');
    await mgr.updateConfig(guildId, { blacklisted_channels: blacklist });
    if (!config?.enabled) await mgr.disable(guildId);

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Channel Blacklisted')
            .setDescription(`${channel} will be excluded from sound drops.`)
            .setColor(0xff8800)
            .setTimestamp()
        ]
    });
}

export async function handleUnblacklist(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const guildId = interaction.guild.id;
    const channel = interaction.options.getChannel('channel');
    const config = await mgr.getConfig(guildId);
    const blacklist = config?.blacklisted_channels || [];
    const idx = blacklist.indexOf(channel.id);

    if (idx === -1) {
        return interaction.reply({ content: `${channel} is not blacklisted.`, ephemeral: true });
    }

    blacklist.splice(idx, 1);
    await mgr.updateConfig(guildId, { blacklisted_channels: blacklist });

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Channel Unblacklisted')
            .setDescription(`${channel} is now eligible for sound drops again.`)
            .setColor(0x00ff00)
            .setTimestamp()
        ]
    });
}

export async function handleAddsound(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    await interaction.deferReply();

    const guildId = interaction.guild.id;
    const name = interaction.options.getString('name').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const attachment = interaction.options.getAttachment('file');

    const ext = path.extname(attachment.name).toLowerCase();
    if (!['.mp3', '.wav', '.ogg', '.flac'].includes(ext)) {
        return interaction.editReply('Invalid file type. Supported: .mp3, .wav, .ogg, .flac');
    }

    if (attachment.size > 5 * 1024 * 1024) {
        return interaction.editReply('File too large. Maximum size is 5MB.');
    }

    const guildSoundsDir = path.join(SOUNDS_DIR, guildId);
    if (!fs.existsSync(guildSoundsDir)) {
        fs.mkdirSync(guildSoundsDir, { recursive: true });
    }

    const filePath = path.join(guildSoundsDir, `${name}${ext}`);
    try {
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
    } catch (error) {
        return interaction.editReply('Failed to download the file. Please try again.');
    }

    await mgr.addSound(guildId, name, filePath, interaction.user.id);

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setTitle('Sound Added')
            .setDescription(`Sound **${name}** has been added successfully.`)
            .addFields(
                { name: 'File', value: attachment.name, inline: true },
                { name: 'Size', value: `${(attachment.size / 1024).toFixed(1)} KB`, inline: true }
            )
            .setColor(0x00ff00)
            .setTimestamp()
        ]
    });
}

export async function handleRemovesound(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const guildId = interaction.guild.id;
    const name = interaction.options.getString('name').toLowerCase();
    const removed = await mgr.removeSound(guildId, name);

    if (!removed) {
        return interaction.reply({ content: `Sound "${name}" not found.`, ephemeral: true });
    }

    const guildSoundsDir = path.join(SOUNDS_DIR, guildId);
    for (const ext of ['.mp3', '.wav', '.ogg', '.flac']) {
        const filePath = path.join(guildSoundsDir, `${name}${ext}`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Sound Removed')
            .setDescription(`Sound **${name}** has been removed.`)
            .setColor(0xff0000)
            .setTimestamp()
        ]
    });
}

export async function handleListsounds(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const sounds = await mgr.getSounds(interaction.guild.id);

    if (sounds.length === 0) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle('Available Sounds')
                .setDescription('No sounds configured. Use `/admin vcsounds addsound` to add some!')
                .setColor(0x808080)
            ]
        });
    }

    const soundList = sounds.map(s => {
        const source = s.guild_id === 'default' ? ' (default)' : '';
        return `**${s.name}**${source} - played ${s.play_count}x`;
    }).join('\n');

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Available Sounds')
            .setDescription(soundList)
            .setColor(0x00bfff)
            .setFooter({ text: `${sounds.length} sound(s) total` })
            .setTimestamp()
        ]
    });
}

export async function handleTest(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel) {
        return interaction.reply({ content: 'You need to be in a voice channel to test.', ephemeral: true });
    }

    const player = interaction.client.player;
    if (!player) {
        return interaction.reply({ content: 'Music player is not available.', ephemeral: true });
    }

    const guildId = interaction.guild.id;
    const soundName = interaction.options.getString('sound')?.toLowerCase();
    let sound;

    if (soundName) {
        const sounds = await mgr.getSounds(guildId);
        sound = sounds.find(s => s.name === soundName);
        if (!sound) {
            return interaction.reply({ content: `Sound "${soundName}" not found.`, ephemeral: true });
        }
    } else {
        sound = await mgr.getRandomSound(guildId);
        if (!sound) {
            return interaction.reply({ content: 'No sounds available. Add some with `/admin vcsounds addsound`.', ephemeral: true });
        }
    }

    if (!fs.existsSync(sound.file_path)) {
        return interaction.reply({ content: `Sound file not found on disk: ${sound.name}`, ephemeral: true });
    }

    await interaction.deferReply();

    try {
        await player.play(voiceChannel, sound.file_path, {
            nodeOptions: {
                metadata: {
                    channelId: interaction.channelId,
                    isVCSoundDrop: true
                },
                leaveOnEnd: true,
                leaveOnEmpty: true,
                leaveOnEndCooldown: 5000
            }
        });

        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setTitle('Test Sound Drop')
                .setDescription(`Playing **${sound.name}** in ${voiceChannel}`)
                .setColor(0x00ff00)
                .setTimestamp()
            ]
        });
    } catch (error) {
        return interaction.editReply(`Failed to play sound: ${error.message}`);
    }
}

export async function handleLog(interaction) {
    const mgr = getManager(interaction);
    if (!mgr) return;

    const logs = await mgr.getDropLog(interaction.guild.id, 15);

    if (logs.length === 0) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle('Sound Drop History')
                .setDescription('No sound drops recorded yet.')
                .setColor(0x808080)
            ]
        });
    }

    const logText = logs.map(l => {
        const time = new Date(l.played_at).toLocaleString();
        return `**${l.sound_name}** in <#${l.channel_id}> (${l.users_present} users) - ${time}`;
    }).join('\n');

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setTitle('Sound Drop History')
            .setDescription(logText)
            .setColor(0x00bfff)
            .setFooter({ text: `Last ${logs.length} drops` })
            .setTimestamp()
        ]
    });
}
