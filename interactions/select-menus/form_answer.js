/**
 * A select answer inside the form stepper — `formq_sel_<sessionId>_<questionId>`.
 *
 * Choice values are positional (`o0`, `o1`) so a choice longer than the 100-character value cap
 * cannot record a truncated answer; the text is looked up from the question row that rendered it.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getSession, saveAnswer, setStep, renderStep, loadForm } from '../../core/form-flow.js';
import { parseOptions, isValidType } from '../../core/form-questions.js';

export async function handleFormAnswer(interaction) {
    try {
        const [, , sessionId, questionId] = interaction.customId.split('_');
        const session = await getSession(sessionId, interaction.user.id);
        if (!session) {
            return interaction.update({
                content: 'That form session has expired — click the panel button to start again.',
                embeds: [], components: []
            });
        }

        const [[question]] = await pool.execute(
            'SELECT * FROM ticket_form_questions WHERE question_id = ?', [questionId]);
        if (!question) {
            return interaction.update({ content: 'That question has been removed.', embeds: [], components: [] });
        }

        const type = isValidType(question.question_type) ? question.question_type : 'text';
        let value;
        if (type === 'select' || type === 'multiselect') {
            const choices = parseOptions(question.question_options);
            const picked = interaction.values.map(v => {
                const m = /^o(\d+)$/.exec(v);
                return m ? (choices[Number(m[1])] ?? v) : v;
            });
            value = type === 'multiselect' ? picked : (picked[0] ?? '');
        } else if (type === 'user') {
            value = interaction.values.map(id => `<@${id}>`).join(', ');
        } else if (type === 'role') {
            value = interaction.values.map(id => `<@&${id}>`).join(', ');
        } else {
            value = interaction.values.map(id => `<#${id}>`).join(', ');
        }

        await saveAnswer(session, question.question_id, value);

        // Answering advances automatically — a picker that needs a separate Next press to register
        // is how somebody submits a form thinking they had answered it.
        const loaded = await loadForm(interaction.guild.id, session.form_id);
        await setStep(session, Math.min(loaded.questions.length, session.step + 1));
        await interaction.update(renderStep({ ...loaded, session, guildId: interaction.guild.id }));
    } catch (error) {
        logger.error('[Form Answer Error]', error);
        await interaction.reply({ content: 'Could not save that answer.', ephemeral: true }).catch(() => {});
    }
}

export default handleFormAnswer;
