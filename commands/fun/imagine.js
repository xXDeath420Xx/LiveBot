import { SlashCommandBuilder, EmbedBuilder, PermissionsBitField, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import { accessibleAttachment } from '../../utils/accessible-attachment.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { generateImage } from '../../utils/image-generation.js';

/* hf-inference no longer serves these models — it answers HTTP 410 "deprecated
   and no longer supported by provider", which is why this command had stopped
   working entirely. fal-ai serves the same weights through the same router.
   Each model now carries its own full endpoint rather than sharing a prefix,
   because the providers differ per model and will keep moving.

   Naming a model is now a preference, not the only route: leave it unset and the
   shared generator picks whatever provider is actually answering today. Ask for
   one by name and you get that one, because someone who typed `sdxl` meant it. */
const MODELS = {
    flux: {
        url: 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell',
        name: 'FLUX.1 Schnell', description: 'Fast, high quality',
    },
    sdxl: {
        url: 'https://router.huggingface.co/fal-ai/fal-ai/fast-sdxl',
        name: 'Stable Diffusion XL', description: 'Detailed, artistic',
    },
};

/* fal-ai does not answer with the image the way hf-inference did.
 *
 * The old provider took { inputs } and replied with the PNG bytes. fal-ai takes
 * { prompt } and replies with JSON naming a URL to fetch — so a command written
 * for the old shape gets a 200 with a body that is not an image, and gives up.
 * Both halves had to change together; only the host had been updated. */
async function generate(url, token, prompt, steps) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, num_inference_steps: steps }),
        signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => '') };

    const body = await res.json().catch(() => null);
    const image = body?.images?.[0];
    if (!image?.url) {
        return { ok: false, status: res.status, text: JSON.stringify(body || {}).slice(0, 200) };
    }
    const file = await fetch(image.url, { signal: AbortSignal.timeout(60_000) });
    if (!file.ok) return { ok: false, status: file.status, text: 'the generated image could not be fetched' };
    return {
        ok: true,
        buffer: Buffer.from(await file.arrayBuffer()),
        contentType: image.content_type || file.headers.get('content-type') || 'image/jpeg',
    };
}

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
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('Imagine Configuration')
            .addFields(
                { name: 'Enabled', value: config ? (config.enabled ? 'Yes' : 'No') : 'Yes (default)', inline: true },
                { name: 'Allowed Channel', value: config?.allowed_channel_id ? `<#${config.allowed_channel_id}>` : 'Anywhere', inline: true },
                { name: 'Cooldown', value: `${config?.cooldown_seconds ?? DEFAULT_COOLDOWN}s`, inline: true },
            )
            .setFooter({ text: 'Use /fun imagine config with options to change settings' });
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
        .setColor(themeColor(interaction.guildId, 'success'))
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
    const chosenModel = interaction.options.getString('model');
    const modelKey = chosenModel || DEFAULT_MODEL;
    const ephemeral = interaction.options.getBoolean('private') || false;
    const model = MODELS[modelKey];
    const token = process.env.HF_API_TOKEN;

    if (!model) {
        return interaction.reply({ content: 'Invalid model. Use `flux` or `sdxl`.', ephemeral: true });
    }

    /* One provider is enough. Refusing because the fal-ai token is missing, while
       a Google key sits right there, is how this command stayed dead. */
    const haveProvider = token || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
    if (!haveProvider || (chosenModel && !token)) {
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
        let result;
        let credit = model.name;
        if (chosenModel) {
            result = await generate(model.url, token, prompt, modelKey === 'flux' ? 4 : 25);
        } else {
            /* Nobody named a model, so take the best provider that answers.
               A spent quota on one of them stops being the user's problem. */
            try {
                const made = await generateImage({ prompt, aspect: 'square', timeout: 90_000 });
                result = { ok: true, buffer: made.buffer, contentType: made.contentType };
                credit = made.model;
            } catch (e) {
                result = { ok: false, status: 0, text: e.message };
            }
        }

        if (!result.ok) {
            let errorMsg = 'Image generation failed.';
            if (result.status === 503) {
                errorMsg = 'Model is loading, please try again in ~30 seconds.';
            } else if (result.status === 429) {
                errorMsg = 'Rate limited — too many requests. Try again in a minute.';
            } else if (result.status === 422) {
                errorMsg = 'Invalid prompt. Try rephrasing your description.';
            } else if (result.status === 402) {
                errorMsg = 'The image generation quota for this month is used up.';
            }

            logger.warn(`[Imagine] API error ${result.status}: ${result.text}`, { userId, prompt, model: modelKey });
            cooldowns.delete(userId);
            return interaction.editReply({ content: errorMsg });
        }

        const buffer = result.buffer;
        const ext = result.contentType.includes('png') ? 'png' : 'jpg';
        const filename = `imagine-${Date.now()}.${ext}`;

        // Generated from the user's own prompt, so the prompt is the best
        // available description of what the image depicts.
        const attachment = accessibleAttachment(buffer, {
            name: filename,
            description: `AI-generated image. Prompt: ${prompt}`,
        });

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setAuthor({ name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL() })
            .setDescription(`**Prompt:** ${prompt}`)
            .setImage(`attachment://${filename}`)
            .setFooter({ text: `${credit} • /imagine` })
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
