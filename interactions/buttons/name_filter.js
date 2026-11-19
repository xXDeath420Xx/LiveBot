/*
 * `/namefilter add` and `/namefilter cleanse mode:force` — the buttons under the preview.
 * The pending filter (and the members it previewed) live in core/name-filters.js (rememberPending)
 * for 15 minutes; only the person who ran the command can press them, and every member is
 * re-checked against the filter before anything happens.
 *
 *   namefilter_save:<token>   save the filter
 *   namefilter_act:<token>    save it and act on the previewed members (log-only: queue them for review)
 *   namefilter_force:<token>  run a force cleanse
 *   namefilter_import:<token> carry out a previewed `/namefilter import`
 *   namefilter_no:<token>     cancel
 */
import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import nf from '../../core/name-filters.js';
import { actorMay } from '../../commands/admin/namefilter.js';

const EPHEMERAL = { flags: 64 };
const DONE_WORD = { flag: 'flagged', timeout: 'timed out', kick: 'kicked', ban: 'banned', log: 'queued' };

function own(interaction, entry) {
    if (!entry || entry.guildId !== interaction.guildId) return 'expired';
    if (entry.actorId !== interaction.user.id) return 'not-yours';
    return null;
}

async function refuse(interaction, why) {
    if (why === 'expired') return interaction.update({ content: 'This has expired. Run the command again.', embeds: [], components: [] });
    return interaction.reply({ content: 'Only the person who ran the command can use these buttons.', ...EPHEMERAL });
}

/** `namefilter_save:` and `namefilter_act:` */
export async function handleNameFilterSave(interaction) {
    const [kind, token] = interaction.customId.split(':');
    const entry = nf.peekPending(token);
    const why = own(interaction, entry);
    if (why) return refuse(interaction, why);
    const act = kind === 'namefilter_act';
    const { filter, userIds } = entry;
    if (act && filter.action !== 'log' && !actorMay(interaction.member, interaction.guild, filter.action)) {
        return interaction.reply({ content: `Acting on them needs a permission you do not have for "${filter.action}". Press Save instead.`, ...EPHEMERAL });
    }
    nf.takePending(token);
    await interaction.update({ content: 'Saving…', components: [] });
    try {
        const saved = await nf.addFilter(interaction.guild, filter, interaction.user.id);
        if (!saved.ok) return interaction.editReply({ content: saved.error, embeds: [] });
        if (!act || !userIds.length) {
            return interaction.editReply({ content: `Saved as filter #${saved.id}.`, embeds: [] });
        }
        await interaction.editReply({ content: `Saved as filter #${saved.id}. Working through ${userIds.length} member(s)…`, embeds: [] });
        const out = await nf.actOnPreview(interaction.guild, saved.id, userIds, interaction.user.id);
        const failed = out.failed.slice(0, 10).map(f => (f.id === '*' ? f.problem : `<@${f.id}> — ${f.problem}`));
        return interaction.editReply({
            content: '',
            embeds: [new EmbedBuilder()
                .setColor(out.failed.length ? 0xE67E22 : 0x2ECC71)
                .setTitle(`Filter #${saved.id} saved: ${out.action === 'log' ? out.queued : out.done} ${DONE_WORD[out.action] ?? 'done'}`)
                .setDescription([
                    out.action === 'log' && out.queued ? 'They are in the review queue (dashboard, or `/namefilter review`).' : null,
                    out.skipped ? `${out.skipped} skipped (gone, staff, exempt, already done, or no longer matching).` : null,
                    failed.length ? `**${out.failed.length} failed:**\n${failed.join('\n')}` : null,
                ].filter(Boolean).join('\n\n') || 'All done.')],
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        logger.error(`[NameFilters] save from preview failed in ${interaction.guildId}: ${err.message}`);
        return interaction.editReply({ content: `Stopped part-way: ${err.message}`, embeds: [] });
    }
}

/** `namefilter_force:` */
export async function handleNameFilterForce(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = nf.peekPending(token);
    const why = own(interaction, entry);
    if (why) return refuse(interaction, why);
    nf.takePending(token);
    const out = nf.startCleanse(interaction.guild, { mode: 'force' }, interaction.user.id);
    return interaction.update({
        content: out.ok ? 'Force cleanse started. The result is posted to the server log and shown on the dashboard\'s Name Filters page.' : out.error,
        components: [],
    });
}

/** `namefilter_import:` — the file is validated again as it is imported. */
export async function handleNameFilterImport(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = nf.peekPending(token);
    const why = own(interaction, entry);
    if (why) return refuse(interaction, why);
    nf.takePending(token);
    await interaction.update({ content: 'Importing…', components: [] });
    try {
        const out = await nf.importFilters(interaction.guild, entry.text, { apply: true }, interaction.user.id);
        if (!out.ok) return interaction.editReply({ content: out.error, embeds: [] });
        return interaction.editReply({
            content: `Imported ${out.added} filter(s).${out.duplicates.length ? ` ${out.duplicates.length} already there.` : ''}`
                + `${out.rejected.length ? ` ${out.rejected.length} refused.` : ''}${out.overCap.length ? ` ${out.overCap.length} over the limit.` : ''}`,
            embeds: [],
        });
    } catch (err) {
        logger.error(`[NameFilters] import failed in ${interaction.guildId}: ${err.message}`);
        return interaction.editReply({ content: `Stopped part-way: ${err.message}`, embeds: [] });
    }
}

/** `namefilter_no:` */
export async function handleNameFilterCancel(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = nf.peekPending(token);
    if (entry && entry.actorId !== interaction.user.id) return refuse(interaction, 'not-yours');
    nf.takePending(token);
    return interaction.update({ content: 'Cancelled. Nothing was saved and nobody was touched.', embeds: [], components: [] });
}
