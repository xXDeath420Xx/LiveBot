/**
 * A typed answer from the stepper's one-field modal — `formq_mod_<sessionId>_<questionId>`.
 *
 * The modal carried a single input with a short generic heading, because the question it answers
 * was displayed in full in the message behind it.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getSession, saveAnswer, setStep, renderStep, loadForm } from '../../core/form-flow.js';

export async function handleFormTextAnswer(interaction) {
    try {
        const [, , sessionId, questionId] = interaction.customId.split('_');
        const session = await getSession(sessionId, interaction.user.id);
        if (!session) {
            return interaction.reply({
                content: 'That form session has expired — click the panel button to start again.',
                ephemeral: true
            });
        }

        const [[question]] = await pool.execute(
            'SELECT * FROM ticket_form_questions WHERE question_id = ?', [questionId]);
        if (!question) {
            return interaction.reply({ content: 'That question has been removed.', ephemeral: true });
        }

        const value = interaction.fields.getTextInputValue('answer') ?? '';

        // Discord has no numeric input, so 'number' is checked here rather than pretended at.
        if (question.question_type === 'number' && value.trim() && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
            return interaction.reply({
                content: `**${question.question_text}** must be a number — press the button again and re-enter it.`,
                ephemeral: true
            });
        }

        await saveAnswer(session, question.question_id, value.trim());

        const loaded = await loadForm(interaction.guild.id, session.form_id);
        await setStep(session, Math.min(loaded.questions.length, session.step + 1));
        await interaction.update(renderStep({ ...loaded, session, guildId: interaction.guild.id }));
    } catch (error) {
        logger.error('[Form Text Answer Error]', error);
        await interaction.reply({ content: 'Could not save that answer.', ephemeral: true }).catch(() => {});
    }
}

export default handleFormTextAnswer;
