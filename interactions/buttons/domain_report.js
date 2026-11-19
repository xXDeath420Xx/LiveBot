/*
 * `/tools checkurl` — the "Report as phishing" / "Dispute this block" buttons under the result, and the modal
 * that asks why (core/domain-reports.js files it; the bot owner reviews it on the dashboard's Domain Reports
 * page and the reporter is told the outcome by DM). The checked host rides in a 30-minute token
 * (core/domain-reports.js rememberCheck); only the person who ran the check can use the buttons.
 *
 *   domrep_report:<token>     open the "why is this phishing?" modal
 *   domrep_dispute:<token>    open the "why is this block wrong?" modal
 *   domrep_modal:<kind>:<token>  the modal's submit
 */
import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import logger from '../../utils/logger.js';
import reports from '../../core/domain-reports.js';
import { MIN_REASON, MAX_REASON } from '../../core/domain-report-logic.js';

const EPHEMERAL = { flags: 64 };

/** `domrep_report:` and `domrep_dispute:` */
export async function handleDomainReportButton(interaction) {
    const [prefix, token] = interaction.customId.split(':');
    const kind = prefix === 'domrep_dispute' ? 'dispute' : 'report';
    const check = reports.peekCheck(token);
    if (!check) return interaction.reply({ content: 'This has expired. Run `/tools checkurl` again.', ...EPHEMERAL });
    if (check.userId !== interaction.user.id) return interaction.reply({ content: 'Only the person who ran the check can use these buttons.', ...EPHEMERAL });
    const modal = new ModalBuilder()
        .setCustomId(`domrep_modal:${kind}:${token}`)
        .setTitle((kind === 'dispute' ? `Dispute the block on ${check.host}` : `Report ${check.host}`).slice(0, 45))
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
            .setCustomId('reason')
            .setLabel(kind === 'dispute' ? 'Why is this domain safe?' : 'Why do you think it is phishing?')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(MIN_REASON)
            .setMaxLength(MAX_REASON)
            .setPlaceholder(kind === 'dispute' ? 'What the site is, who runs it, how you use it' : 'What it pretends to be, where you saw it, what it asks for')
            .setRequired(true)));
    return interaction.showModal(modal);
}

/** `domrep_modal:` */
export async function handleDomainReportModal(interaction) {
    const [, kind, token] = interaction.customId.split(':');
    const check = reports.peekCheck(token);
    if (!check || check.userId !== interaction.user.id) {
        return interaction.reply({ content: 'This has expired. Run `/tools checkurl` again.', ...EPHEMERAL });
    }
    if (!interaction.guild) return interaction.reply({ content: 'Reports can only be sent from a server.', ...EPHEMERAL });
    try {
        const out = await reports.submit({
            guild: interaction.guild, user: interaction.user, kind: kind === 'dispute' ? 'dispute' : 'report',
            url: check.host, reason: interaction.fields.getTextInputValue('reason'), source: 'command',
        });
        if (!out.ok) return interaction.reply({ content: out.error, ...EPHEMERAL });
        return interaction.reply({
            content: `Thanks: ${kind === 'dispute' ? 'dispute' : 'report'} #${out.id} for **${out.host}** went to the bot's reviewers. `
                + 'You will get a DM with the outcome (keep DMs from this server open).',
            ...EPHEMERAL,
        });
    } catch (err) {
        logger.error(`[DomainReports] submit from /tools checkurl failed in ${interaction.guildId}: ${err.message}`);
        return interaction.reply({ content: 'Could not send that right now. Try again in a moment.', ...EPHEMERAL });
    }
}
