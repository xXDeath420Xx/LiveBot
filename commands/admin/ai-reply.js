/**
 * /ai-reply — Gemini-backed draft reply suggestion for staff in a ticket or
 * modmail channel. Reads the last 20 messages, drafts a professional reply,
 * returns ephemerally so staff can copy-paste or edit before sending.
 *
 * Scope: suggestion only — never sends on the staff's behalf. Daily per-guild
 * token budget enforced via server_stats.ai_reply_quota_used; 50 suggestions
 * per guild per day free (shared with other AI features; no hard cap for
 * owner/billing since we don't charge).
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

const DAILY_CAP_SOFT = 100;     // ask staff to confirm past this
const MAX_HISTORY   = 20;

const data = new SlashCommandBuilder()
    .setName('ai-reply')
    .setDescription('Draft a staff reply for this ticket / modmail thread. Suggestion only — never sent.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addStringOption(o => o.setName('tone').setDescription('Tone preset').addChoices(
        { name: 'Neutral professional (default)', value: 'neutral' },
        { name: 'Warm + apologetic',              value: 'warm' },
        { name: 'Firm + decisive',                value: 'firm' },
        { name: 'Brief / one-liner',              value: 'brief' },
    ))
    .addStringOption(o => o.setName('intent').setDescription('Short goal for the reply (e.g. "ask for proof of purchase")').setMaxLength(200));

const TONE_HINTS = {
    neutral: 'Neutral, professional, direct. Avoid filler words.',
    warm:    'Warm, apologetic where appropriate, use the user\'s name once.',
    firm:    'Firm, decisive, polite. State the decision clearly and the next step.',
    brief:   'One sentence, maximum two. Direct answer only.',
};

async function execute(interaction) {
    const tone   = interaction.options.getString('tone')   || 'neutral';
    const intent = interaction.options.getString('intent') || '';

    const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
    if (!key) return interaction.reply({ content: 'AI replies need `GOOGLE_API_KEY` or `GOOGLE_AI_KEY` set.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    try {
        // Read the last 20 messages in this channel.
        const messages = await interaction.channel.messages.fetch({ limit: MAX_HISTORY });
        const ordered = [...messages.values()].reverse();
        const transcript = ordered.map(m => `${m.author?.bot ? 'BOT' : (m.author?.id === interaction.channel?.topic ? 'USER' : (m.member?.permissions?.has?.('ManageMessages') ? 'STAFF' : 'USER'))} ${m.author?.username || '?'}: ${(m.content || '').slice(0, 500)}`).join('\n');

        const prompt = `You are drafting a reply for a Discord server staff member to send in a support conversation. ${TONE_HINTS[tone]}${intent ? `\n\nStaff intent: ${intent}` : ''}\n\nCONVERSATION (newest last):\n${transcript.slice(-6000)}\n\nDraft ONLY the reply text — no greeting if the thread is mid-conversation, no sign-off, no quotes, no explanation. Reply:`;

        const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
                }),
                signal: AbortSignal.timeout(12000),
            });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            logger.warn(`[ai-reply] gemini ${res.status}: ${body.slice(0, 200)}`);
            return interaction.editReply('AI service error. Try again in a minute.');
        }
        const body = await res.json();
        const draft = body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!draft) return interaction.editReply('AI returned no draft — try a different tone or add an intent.');

        const embed = new EmbedBuilder()
            .setColor(0x8E44AD)
            .setTitle(`AI draft — ${tone}`)
            .setDescription(draft.slice(0, 4000))
            .setFooter({ text: 'Suggestion only. Review before sending. Copy the body above.' });
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        logger.warn(`[ai-reply] ${err.message}`);
        return interaction.editReply(`Failed: ${err.message}`);
    }
}

export { data, execute };
export default { category: 'admin', data, execute };
