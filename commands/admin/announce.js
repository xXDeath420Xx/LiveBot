import {
    SlashCommandBuilder, PermissionFlagsBits, ChannelType,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import crypto from 'node:crypto';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { readAnnouncement, parseHexColor, TEXT_LIMIT } from '../../core/announcement-card.js';
import { publishAnnouncement, MAX_IMAGE_BYTES } from '../../core/announcement-manager.js';

/**
 * /announce post|edit — a one-off announcement with an uploaded picture on top and
 * multi-paragraph text typed into a modal. See core/announcement-card.js for why this is
 * not `/admin announce` (one-line text, no upload, and /admin is at the 8000-char ceiling).
 */

const PENDING_TTL_MS = 15 * 60 * 1000;

// Slash options (attachment, channel, ping) wait here while the modal is open: a modal
// customId is 100 chars and cannot carry an attachment URL.
const pending = new Map();

function stash(data) {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    const key = crypto.randomBytes(6).toString('hex');
    pending.set(key, { ...data, expires: now + PENDING_TTL_MS });
    return key;
}

function imageFromOption(attachment) {
    if (!attachment) return { ok: true, image: null };
    if (!attachment.contentType?.startsWith('image/')) {
        return { ok: false, error: 'The picture has to be an image file (PNG, JPG, GIF or WebP).' };
    }
    if (attachment.size > MAX_IMAGE_BYTES) {
        return { ok: false, error: 'That picture is over 10 MB. Shrink it and try again.' };
    }
    return { ok: true, image: { url: attachment.url, name: attachment.name } };
}

function pingFromRole(role, guildId) {
    if (!role) return null;
    return role.id === guildId ? 'everyone' : role.id;
}

function buildModal(key, heading, prefill = {}) {
    const title = new TextInputBuilder().setCustomId('title').setLabel('Title (optional)')
        .setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(false);
    const body = new TextInputBuilder().setCustomId('body').setLabel('Announcement text')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(TEXT_LIMIT).setRequired(true)
        .setPlaceholder('Line breaks, **bold**, ### headings and emoji all work.');
    const footer = new TextInputBuilder().setCustomId('footer').setLabel('Small print at the bottom (optional)')
        .setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false);
    if (prefill.title) title.setValue(prefill.title);
    if (prefill.body) body.setValue(prefill.body);
    if (prefill.footer) footer.setValue(prefill.footer);

    return new ModalBuilder().setCustomId(`announce_modal:${key}`).setTitle(heading)
        .addComponents(
            new ActionRowBuilder().addComponents(title),
            new ActionRowBuilder().addComponents(body),
            new ActionRowBuilder().addComponents(footer),
        );
}

function parseMessageRef(input, fallbackChannelId) {
    const link = /channels\/\d+\/(\d+)\/(\d+)/.exec(input);
    if (link) return { channelId: link[1], messageId: link[2] };
    const id = /^\d{17,20}$/.exec(input.trim());
    return id ? { channelId: fallbackChannelId, messageId: id[0] } : null;
}

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Post an announcement with a picture on top')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(sub => sub.setName('post').setDescription('Write and post a new announcement')
            .addChannelOption(o => o.setName('channel').setDescription('Where to post it').setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
            .addAttachmentOption(o => o.setName('picture').setDescription('Image shown at the top'))
            .addRoleOption(o => o.setName('ping').setDescription('Role to ping (pick @everyone to ping everyone)'))
            .addStringOption(o => o.setName('color').setDescription('Side stripe colour, hex like #FF7518')))
        .addSubcommand(sub => sub.setName('edit').setDescription('Change an announcement the bot already posted')
            .addStringOption(o => o.setName('message').setDescription('Message link (right-click the post → Copy Message Link)').setRequired(true))
            .addAttachmentOption(o => o.setName('picture').setDescription('Replace the picture'))
            .addBooleanOption(o => o.setName('remove-picture').setDescription('Take the picture off'))
            .addStringOption(o => o.setName('color').setDescription('New side stripe colour, hex like #FF7518'))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const colorInput = interaction.options.getString('color');
        const color = parseHexColor(colorInput);
        if (colorInput && color == null) {
            return interaction.reply({ content: `\`${colorInput}\` isn't a hex colour. Use six digits, like \`#FF7518\`.`, ephemeral: true });
        }
        const img = imageFromOption(interaction.options.getAttachment('picture'));
        if (!img.ok) return interaction.reply({ content: img.error, ephemeral: true });

        if (sub === 'post') {
            const channel = interaction.options.getChannel('channel');
            const key = stash({
                mode: 'post',
                userId: interaction.user.id,
                channelId: channel.id,
                image: img.image,
                pingRoleId: pingFromRole(interaction.options.getRole('ping'), interaction.guildId),
                color: color ?? themeColor(interaction.guildId, 'primary'),
            });
            return interaction.showModal(buildModal(key, 'New announcement'));
        }

        // edit
        const ref = parseMessageRef(interaction.options.getString('message'), interaction.channelId);
        if (!ref) return interaction.reply({ content: 'Paste the message link (right-click the post → Copy Message Link).', ephemeral: true });

        let message;
        try {
            const channel = await interaction.guild.channels.fetch(ref.channelId);
            message = await channel.messages.fetch(ref.messageId);
        } catch {
            return interaction.reply({ content: "I can't find that message. Check the link, and that I can see that channel.", ephemeral: true });
        }
        const current = message.author.id === interaction.client.user.id ? readAnnouncement(message) : null;
        if (!current) {
            return interaction.reply({ content: 'That message isn\'t an announcement I posted with `/manage announce`, so I can\'t edit it.', ephemeral: true });
        }

        const keep = current.imageUrl && !interaction.options.getBoolean('remove-picture');
        const image = img.image
            ?? (keep ? { url: current.imageUrl, name: new URL(current.imageUrl).pathname.split('/').pop() } : null);

        const key = stash({
            mode: 'edit',
            userId: interaction.user.id,
            channelId: ref.channelId,
            messageId: ref.messageId,
            image,
            pingRoleId: current.pingRoleId,
            color: color ?? current.color,
        });
        return interaction.showModal(buildModal(key, 'Edit announcement', current));
    },
};

export async function handleAnnounceModal(interaction) {
    const key = interaction.customId.slice('announce_modal:'.length);
    const job = pending.get(key);
    if (!job || job.userId !== interaction.user.id) {
        return interaction.reply({ content: 'That form expired. Run `/manage announce` again. Your text is below so you can copy it.\n\n' + interaction.fields.getTextInputValue('body').slice(0, 1800), ephemeral: true });
    }

    const title = interaction.fields.getTextInputValue('title').trim();
    const body = interaction.fields.getTextInputValue('body').trim();
    const footer = interaction.fields.getTextInputValue('footer').trim();

    await interaction.deferReply({ ephemeral: true });

    try {
        const channel = await interaction.guild.channels.fetch(job.channelId);
        const msg = await publishAnnouncement({
            channel,
            messageId: job.mode === 'edit' ? job.messageId : undefined,
            fields: { title, body, footer, color: job.color, pingRoleId: job.pingRoleId },
            image: job.image,
            userId: interaction.user.id,
            source: 'command',
        });
        pending.delete(key);

        logger.info(`[Announce] ${job.mode} ${msg.id} in #${channel.name}`, { guildId: interaction.guildId, userId: interaction.user.id });
        return interaction.editReply(`${job.mode === 'edit' ? 'Updated' : 'Posted'}: ${msg.url}`);
    } catch (error) {
        logger.error('[Announce] Failed to post', { guildId: interaction.guildId, error: error.message });
        const hint = error.code === 50013 || error.code === 50001
            ? "I don't have permission to post there. I need View Channel, Send Messages and Attach Files in that channel."
            : error.message;
        // Hand the text back so a failed post never costs her the writing.
        return interaction.editReply(`Not posted: ${hint}\n\nYour text, so you don't lose it:\n\`\`\`\n${body.slice(0, 1700)}\n\`\`\``);
    }
}
