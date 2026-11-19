/*
 * Right-click a user → Apps → Report DM spam.
 *
 * USER context menu — a separate type from chat-input slash commands. User context menus have a
 * 5-slot quota per application (0/5 used before this), so this deploys independently of the
 * ~113-command chat-input cap we're currently sitting at.
 *
 * The flow is: pick the user → modal asks for the DM content → submit routes to createReport in
 * core/dm-spam-reports.js, same pipeline as the slash command sibling.
 */
import {
  ContextMenuCommandBuilder, ApplicationCommandType,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder,
} from 'discord.js';

const EPHEMERAL = { flags: 64 };

const data = new ContextMenuCommandBuilder()
    .setName('Report DM spam')
    .setType(ApplicationCommandType.User)
    .setDMPermission(false);

async function execute(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'Use this inside the server where you received the DM.', ...EPHEMERAL });
    }
    const target = interaction.targetUser;
    if (target.id === interaction.user.id) {
        return interaction.reply({ content: "You can't report yourself.", ...EPHEMERAL });
    }
    if (target.bot) {
        return interaction.reply({ content: "That account is a bot — bots don't DM users unprompted the way commission spammers do.", ...EPHEMERAL });
    }

    const modal = new ModalBuilder()
        .setCustomId(`dmreport:${target.id}`)
        .setTitle('Report DM spam');

    const content = new TextInputBuilder()
        .setCustomId('content')
        .setLabel('What did they DM you?')
        .setPlaceholder('Paste the DM text, or a brief description if the message was mostly images.')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(5)
        .setMaxLength(2000)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(content));
    await interaction.showModal(modal);
}

/** Modal submit handler. Registered under the `dmreport:` prefix in interactions/handlerRegistry.js. */
export async function handleDmReportModal(interaction) {
    const [prefix, targetId] = (interaction.customId || '').split(':');
    if (prefix !== 'dmreport') return;
    if (!interaction.guild) {
        return interaction.reply({ content: 'Server only.', ...EPHEMERAL });
    }
    const target = await interaction.client.users.fetch(targetId).catch(() => null);
    if (!target) {
        return interaction.reply({ content: 'Could not find that user to attach to the report.', ...EPHEMERAL });
    }
    const content = interaction.fields.getTextInputValue('content') || '';

    const { createReport } = await import('../../core/dm-spam-reports.js');
    const res = await createReport({
        reporter: interaction.user,
        reported: target,
        guildId: interaction.guild.id,
        content,
        attachments: null,
        client: interaction.client,
    });

    if (!res.ok) {
        const msg = {
            self_report: "You can't report yourself.",
            bot_target: "That account is a bot.",
            missing_fields: "Missing information in the report.",
            db_error: "Something went wrong recording the report. Please tell staff.",
        }[res.reason] || 'Could not file the report.';
        return interaction.reply({ content: msg, ...EPHEMERAL });
    }

    const embed = new EmbedBuilder()
        .setTitle('Report filed')
        .setColor(res.blacklist?.tripped ? 0xC13E3E : 0x5865F2)
        .setDescription([
            `Report #${res.reportId} filed against <@${target.id}>.`,
            '',
            res.blacklist?.tripped
                ? `**Threshold tripped.** This user is now on the network blacklist (${res.blacklist.distinctGuilds} guild(s), ${res.blacklist.reportIds?.length || 0} report(s)).`
                : res.blacklist?.distinctGuilds
                    ? `Progress toward blacklist: **${res.blacklist.distinctGuilds} / ${res.blacklist.threshold}** distinct guilds in the last ${res.blacklist.windowHours}h.`
                    : 'Thanks — staff will review.',
        ].join('\n'))
        .setFooter({ text: 'If a staff member marks this a false positive, it won\'t count toward the blacklist.' });

    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

export { data, execute };
export default { category: 'context', data, execute };
