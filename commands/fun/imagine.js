import { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, PermissionsBitField, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const HF_API_URL = 'https://router.huggingface.co/hf-inference/models';

const MODELS = {
    flux: { id: 'black-forest-labs/FLUX.1-schnell', name: 'FLUX.1 Schnell', description: 'Fast, high quality' },
    sdxl: { id: 'stabilityai/stable-diffusion-xl-base-1.0', name: 'Stable Diffusion XL', description: 'Detailed, artistic' },
};

const DEFAULT_MODEL = 'flux';
const DEFAULT_COOLDOWN = 15;
const cooldowns = new Map();

// Config cache: guild_id -> { enabled, allowed_channel_id, cooldown_seconds }
const configCache = new Map();
const CACHE_TTL = 60_000;
const cacheTimestamps = new Map();

async function getConfig(guildId) {
    const now = Date.now();
    if (configCache.has(guildId) && now - (cacheTimestamps.get(guildId) || 0) < CACHE_TTL) {
        return configCache.get(guildId);
    }
    const [rows] = await pool.execute('SELECT * FROM imagine_config WHERE guild_id = ?', [guildId]);
    const config = rows[0] || null;
    configCache.set(guildId, config);
    cacheTimestamps.set(guildId, now);
    return config;
}

function invalidateCache(guildId) {
    configCache.delete(guildId);
    cacheTimestamps.delete(guildId);
}

export default {
    category: 'fun',
    data: new SlashCommandBuilder()
        .setName('imagine')
        .setDescription('AI image generation')
        .addSubcommand(sub =>
            sub.setName('generate')
                .setDescription('Generate an image from a text prompt')
                .addStringOption(opt =>
                    opt.setName('prompt')
                        .setDescription('Describe the image you want to generate')
                        .setRequired(true)
                        .setMaxLength(500)
                )
                .addStringOption(opt =>
                    opt.setName('model')
                        .setDescription('AI model to use (default: FLUX)')
                        .setRequired(false)
                        .addChoices(
                            { name: 'FLUX.1 Schnell (fast, high quality)', value: 'flux' },
                            { name: 'Stable Diffusion XL (detailed, artistic)', value: 'sdxl' },
                        )
                )
                .addBooleanOption(opt =>
                    opt.setName('private')
                        .setDescription('Only you can see the result')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('config')
                .setDescription('Configure /imagine settings (Admin only)')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Restrict /imagine to this channel only (leave empty to allow everywhere)')
                        .setRequired(false)
                        .addChannelTypes(ChannelType.GuildText)
                )
                .addBooleanOption(opt =>
                    opt.setName('enabled')
                        .setDescription('Enable or disable /imagine in this server')
                        .setRequired(false)
                )
                .addIntegerOption(opt =>
                    opt.setName('cooldown')
                        .setDescription('Cooldown between uses per user (seconds, default 15)')
                        .setRequired(false)
                        .setMinValue(5)
                        .setMaxValue(300)
                )
                .addBooleanOption(opt =>
                    opt.setName('reset')
                        .setDescription('Remove channel restriction (allow everywhere)')
                        .setRequired(false)
                )
        ),

    async execute(interaction) {
        let sub;
        try {
            sub = interaction.options.getSubcommand();
        } catch {
            // Fallback for stale cached command (no subcommand) — treat as generate
            return handleGenerate(interaction);
        }

        if (sub === 'config') return handleConfig(interaction);
        if (sub === 'generate') return handleGenerate(interaction);
    }
};

async function handleConfig(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'This command requires Administrator permission.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel');
    const enabled = interaction.options.getBoolean('enabled');
    const cooldown = interaction.options.getInteger('cooldown');
    const reset = interaction.options.getBoolean('reset');

    // If no options provided, show current config
    if (channel === null && enabled === null && cooldown === null && !reset) {
        const config = await getConfig(interaction.guildId);
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Imagine Configuration')
            .addFields(
                { name: 'Enabled', value: config ? (config.enabled ? 'Yes' : 'No') : 'Yes (default)', inline: true },
                { name: 'Allowed Channel', value: config?.allowed_channel_id ? `<#${config.allowed_channel_id}>` : 'Anywhere', inline: true },
                { name: 'Cooldown', value: `${config?.cooldown_seconds ?? DEFAULT_COOLDOWN}s`, inline: true },
            )
            .setFooter({ text: 'Use /imagine config with options to change settings' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Build update
    const current = await getConfig(interaction.guildId);
    const newEnabled = enabled !== null ? (enabled ? 1 : 0) : (current?.enabled ?? 1);
    const newChannel = reset ? null : (channel?.id ?? current?.allowed_channel_id ?? null);
    const newCooldown = cooldown ?? current?.cooldown_seconds ?? DEFAULT_COOLDOWN;

    await pool.execute(`
        INSERT INTO imagine_config (guild_id, enabled, allowed_channel_id, cooldown_seconds)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            allowed_channel_id = VALUES(allowed_channel_id),
            cooldown_seconds = VALUES(cooldown_seconds)
    `, [interaction.guildId, newEnabled, newChannel, newCooldown]);

    invalidateCache(interaction.guildId);

    const changes = [];
    if (enabled !== null) changes.push(`**Enabled:** ${enabled ? 'Yes' : 'No'}`);
    if (channel) changes.push(`**Allowed Channel:** <#${channel.id}>`);
    if (reset) changes.push('**Allowed Channel:** Anywhere (restriction removed)');
    if (cooldown !== null) changes.push(`**Cooldown:** ${cooldown}s`);

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('Imagine Config Updated')
        .setDescription(changes.join('\n'));

    return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleGenerate(interaction) {
    const guildId = interaction.guildId;
    const config = await getConfig(guildId);

    // Check if disabled
    if (config && !config.enabled) {
        return interaction.reply({ content: 'Image generation is disabled in this server.', ephemeral: true });
    }

    // Check channel restriction
    if (config?.allowed_channel_id && interaction.channelId !== config.allowed_channel_id) {
        return interaction.reply({
            content: `This command can only be used in <#${config.allowed_channel_id}>.`,
            ephemeral: true
        });
    }

    const prompt = interaction.options.getString('prompt');
    const modelKey = interaction.options.getString('model') || DEFAULT_MODEL;
    const ephemeral = interaction.options.getBoolean('private') || false;
    const model = MODELS[modelKey];
    const token = process.env.HF_API_TOKEN;

    if (!model) {
        return interaction.reply({ content: 'Invalid model. Use `flux` or `sdxl`.', ephemeral: true });
    }

    if (!token) {
        return interaction.reply({ content: 'Image generation is not configured. Missing API token.', ephemeral: true });
    }

    // Cooldown check
    const userId = interaction.user.id;
    const cooldownSec = config?.cooldown_seconds ?? DEFAULT_COOLDOWN;
    const now = Date.now();
    const lastUsed = cooldowns.get(userId) || 0;
    const remaining = cooldownSec - Math.floor((now - lastUsed) / 1000);
    if (remaining > 0) {
        return interaction.reply({ content: `Please wait ${remaining}s before generating another image.`, ephemeral: true });
    }
    cooldowns.set(userId, now);

    await interaction.deferReply({ ephemeral });

    try {
        const response = await fetch(`${HF_API_URL}/${model.id}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: prompt,
                parameters: {
                    num_inference_steps: modelKey === 'flux' ? 4 : 25,
                }
            }),
            signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorMsg = 'Image generation failed.';

            if (response.status === 503) {
                errorMsg = 'Model is loading, please try again in ~30 seconds.';
            } else if (response.status === 429) {
                errorMsg = 'Rate limited — too many requests. Try again in a minute.';
            } else if (response.status === 422) {
                errorMsg = 'Invalid prompt. Try rephrasing your description.';
            }

            logger.warn(`[Imagine] API error ${response.status}: ${errorText}`, { userId, prompt, model: modelKey });
            cooldowns.delete(userId);
            return interaction.editReply({ content: errorMsg });
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('image')) {
            const text = await response.text();
            logger.warn(`[Imagine] Unexpected response type: ${contentType}`, { text: text.substring(0, 200) });
            cooldowns.delete(userId);
            return interaction.editReply({ content: 'Unexpected response from image API. Try again.' });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const filename = `imagine-${Date.now()}.${ext}`;

        const attachment = new AttachmentBuilder(buffer, { name: filename });

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setAuthor({ name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL() })
            .setDescription(`**Prompt:** ${prompt}`)
            .setImage(`attachment://${filename}`)
            .setFooter({ text: `${model.name} • /imagine` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (error) {
        cooldowns.delete(userId);
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            return interaction.editReply({ content: 'Image generation timed out. The model may be busy — try again.' });
        }
        logger.error('[Imagine] Error generating image', { error: error.message, userId, prompt, model: modelKey });
        return interaction.editReply({ content: 'Something went wrong generating the image. Try again later.' });
    }
}
