/*
 * Right-click a message → Apps → Forward Message.
 *
 * Opens a channel-select modal; forwarding uses Discord's native
 * `message_reference` with `type: MessageReferenceType.Forward`, which
 * reproduces the forwarded content as a message_snapshot on the destination.
 * Our automod reads snapshots via `utils/message-effective-content.js`, so
 * forwarded content is still subject to the same filters when it lands.
 *
 * Guild-only; staff-only via Manage Messages. The forwarded message retains
 * who forwarded it in Discord's own metadata — we don't log a separate record.
 */
import {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    PermissionFlagsBits,
    MessageFlags,
    MessageReferenceType,
    ChannelType,
    ActionRowBuilder,
    ChannelSelectMenuBuilder,
} from 'discord.js';
import logger from '../../utils/logger.js';

const FORWARD_SELECT_ID = 'forward-msg:dst';

export default {
    category: 'context',
    data: new ContextMenuCommandBuilder()
        .setName('Forward Message')
        .setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .setContexts(0), // 0 = Guild only (InteractionContextType.Guild)

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: 'Forward is a server-only action.', flags: MessageFlags.Ephemeral });
        }
        const message = interaction.targetMessage;
        if (!message) {
            return interaction.reply({ content: 'That message is no longer available.', flags: MessageFlags.Ephemeral });
        }

        const row = new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`${FORWARD_SELECT_ID}:${message.channelId}:${message.id}`)
                .setPlaceholder('Pick the channel to forward to')
                .addChannelTypes(
                    ChannelType.GuildText,
                    ChannelType.GuildAnnouncement,
                    ChannelType.GuildForum,
                    ChannelType.PublicThread,
                    ChannelType.PrivateThread,
                    ChannelType.AnnouncementThread,
                )
                .setMinValues(1)
                .setMaxValues(1),
        );

        return interaction.reply({
            content: `Where should I forward [this message](${message.url})?`,
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
    },

    /**
     * Dispatched from events/interactionCreate.js when a ChannelSelectMenu with
     * our custom id resolves. Not a standard command hook — exported so the
     * interaction router can call it; see events/interactionCreate.js for the
     * matching `startsWith(FORWARD_SELECT_ID)` branch.
     */
    async onChannelSelect(interaction) {
        try {
            // custom id: "forward-msg:dst:<sourceChannelId>:<sourceMessageId>"
            const parts = interaction.customId.split(':');
            const sourceChannelId = parts[2];
            const sourceMessageId = parts[3];
            const [destChannelId] = interaction.values;

            const destChannel = await interaction.guild.channels.fetch(destChannelId).catch(() => null);
            if (!destChannel?.isTextBased?.()) {
                return interaction.update({ content: 'That channel can\'t receive messages.', components: [] });
            }
            const me = interaction.guild.members.me;
            if (!destChannel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
                return interaction.update({ content: `I can't post in ${destChannel}.`, components: [] });
            }

            await destChannel.send({
                messageReference: {
                    type: MessageReferenceType.Forward,
                    messageId: sourceMessageId,
                    channelId: sourceChannelId,
                    guildId: interaction.guild.id,
                },
            });

            logger.info('[forward-message] forwarded', {
                by: interaction.user.id, from: `${sourceChannelId}/${sourceMessageId}`, to: destChannelId,
            });

            return interaction.update({
                content: `Forwarded to ${destChannel}.`,
                components: [],
            });
        } catch (err) {
            logger.error('[forward-message] failed', { err: err.message });
            return interaction.update({ content: `Forward failed: ${err.message}`, components: [] });
        }
    },

    forwardSelectIdPrefix: FORWARD_SELECT_ID,
};
