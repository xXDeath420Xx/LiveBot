/*
 * Verification buttons. The logic lives in core/verification.js; these are the registry's entry points.
 *
 *   verify_accept        the panel's button ("I agree" or "Verify me", by mode)
 *   verify_member        the same, on panels posted by the old `/admin verification setup`
 *   vcap:<guild>:<key>   the CAPTCHA keypad (digits, back, clear, submit, type it, new image)
 *   vcapm:<guild>        the "type it" modal
 *   vwiz_ok:<token> / vwiz_no:<token>   `/systems verification setup` preview: apply / cancel
 */
import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import {
    handleVerifyButton, handleKeypad, handleAnswerModal, wizardApply, wizardProgress, VerificationError,
} from '../../core/verification.js';
import { takeWizardPreview, peekWizardPreview, wizardResultEmbed } from '../../commands/admin/systems-verify-handler.js';

const EPHEMERAL = { flags: 64 };

export async function handleVerifyAccept(interaction) {
    return handleVerifyButton(interaction);
}

export async function handleVerifyKeypad(interaction) {
    return handleKeypad(interaction);
}

export async function handleVerifyModal(interaction) {
    return handleAnswerModal(interaction);
}

/** `vwiz_ok:<token>` — run the previewed setup. */
export async function handleVerifyWizardConfirm(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = peekWizardPreview(token);
    if (!entry || entry.guildId !== interaction.guildId) {
        return interaction.update({ content: 'This preview has expired. Run `/systems verification setup` again.', embeds: [], components: [] });
    }
    if (entry.actorId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the person who ran the setup can confirm it.', ...EPHEMERAL });
    }
    takeWizardPreview(token);
    await interaction.update({ content: 'Setting verification up…', embeds: [], components: [] });
    try {
        await wizardApply(interaction.guild, entry.input, interaction.user);
        // Wait for the background job (it reports progress for the dashboard; here we just wait).
        for (let i = 0; i < 390; i++) {           // ~13 minutes: inside the 15-minute interaction token
            const p = wizardProgress(interaction.guildId);
            if (!p?.running) break;
            await new Promise(r => setTimeout(r, 2000));
        }
        const p = wizardProgress(interaction.guildId);
        if (p?.running) return interaction.editReply({ content: 'Still working — check the dashboard Verification page for progress.' });
        return interaction.editReply({ content: '', embeds: [wizardResultEmbed(p)] });
    } catch (err) {
        if (!(err instanceof VerificationError)) logger.error(`[Verification] wizard from command failed: ${err.message}`);
        return interaction.editReply({ content: '', embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('Setup did not run').setDescription(err.message)] });
    }
}

/** `vwiz_no:<token>` */
export async function handleVerifyWizardCancel(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = peekWizardPreview(token);
    if (entry && entry.actorId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the person who ran the setup can cancel it.', ...EPHEMERAL });
    }
    takeWizardPreview(token);
    return interaction.update({ content: 'Setup cancelled — nothing was changed.', embeds: [], components: [] });
}

export default handleVerifyAccept;
