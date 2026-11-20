/*
 * `/moderation namefilter` — name filters: phrases and regexes checked against usernames, display names and
 * server nicknames on join and on every rename, plus the generated-username check, curated
 * templates, Auto-Pilot staff-name protection and the review-first cleanse (core/name-filters.js).
 *
 * The dashboard's Name Filters page does all of this and more (the review queue with bulk actions,
 * editing, previews before saving); this command is the in-Discord way to the same functions.
 * Adding a filter previews the current members it would hit, with Save / Save and act / Cancel
 * buttons (interactions/buttons/name_filter.js). `export` sends the server's own filters as a versioned
 * JSON file; `import` previews a file (added / already there / refused by the safety rules) with
 * Import / Cancel buttons.
 */
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { liveConfigAccess } from '../../core/protection-exempt.js';
import nf from '../../core/name-filters.js';
import { FIELD_LABEL, filterLabel } from '../../core/name-filter-logic.js';
import { TEMPLATE_PACKS } from '../../core/name-filter-templates.js';

const EPHEMERAL = { flags: 64 };
const ACTION_CHOICES = [
    { name: 'Log only (default)', value: 'log' },
    { name: 'Flag with a role', value: 'flag' },
    { name: 'Timeout', value: 'timeout' },
    { name: 'Kick', value: 'kick' },
    { name: 'Ban', value: 'ban' },
];
const ACTION_WORD = { log: 'log only', flag: 'flag with a role', timeout: 'timeout', kick: 'kick', ban: 'ban' };
const ACT_LABEL = { flag: 'Flag', timeout: 'Time out', kick: 'Kick', ban: 'Ban' };
const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'], kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'], flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};
const ts = (d) => Math.floor(new Date(d).getTime() / 1000);
const dash = (guildId) => `${(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '')}/manage/${guildId}?page=name-filters`;

/** Can the person running the command carry out `action` themselves? */
export function actorMay(member, guild, action) {
    const need = NEEDS[action];
    return !need || guild.ownerId === member.id || member.permissions.has(need[0]);
}

const actionOpt = (o, desc = 'What to do on a match') => o.setName('action').setDescription(desc).addChoices(...ACTION_CHOICES);

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('namefilter')
        .setDescription('Block impersonator and scam names: filters, templates, cleanse, Auto-Pilot')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(s => s.setName('add').setDescription('Add a filter (shows who it would hit first)')
            .addStringOption(o => o.setName('type').setDescription('How to match').setRequired(true).addChoices(
                { name: 'Phrase (name contains it)', value: 'phrase' },
                { name: 'Regex', value: 'regex' },
                { name: 'Exact name', value: 'exact' }))
            .addStringOption(o => o.setName('pattern').setDescription('Text or regex').setRequired(true).setMaxLength(200))
            .addStringOption(o => actionOpt(o))
            .addBooleanOption(o => o.setName('case_sensitive').setDescription('Match case exactly (default: no)'))
            .addStringOption(o => o.setName('note').setDescription('Note for staff').setMaxLength(200)))
        .addSubcommand(s => s.setName('edit').setDescription('Change a filter\'s action, note or on/off')
            .addIntegerOption(o => o.setName('id').setDescription('Filter #').setRequired(true).setMinValue(1))
            .addStringOption(o => actionOpt(o, 'New action'))
            .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
            .addStringOption(o => o.setName('note').setDescription('New note').setMaxLength(200)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a filter')
            .addIntegerOption(o => o.setName('id').setDescription('Filter #').setRequired(true).setMinValue(1)))
        .addSubcommand(s => s.setName('list').setDescription('List the filters')
            .addStringOption(o => o.setName('show').setDescription('Which filters').addChoices(
                { name: 'Mine', value: 'manual' }, { name: 'Templates', value: 'template' },
                { name: 'Auto-Pilot', value: 'auto' }, { name: 'All', value: 'all' })))
        .addSubcommand(s => s.setName('test').setDescription('Test a name or a member against every filter')
            .addStringOption(o => o.setName('name').setDescription('A name to try').setMaxLength(100))
            .addUserOption(o => o.setName('user').setDescription('A member to check')))
        .addSubcommand(s => s.setName('cleanse').setDescription('Scan every member against the filters')
            .addStringOption(o => o.setName('mode').setDescription('Review first (default) or act now').addChoices(
                { name: 'Review first: queue matches on the dashboard', value: 'review' },
                { name: 'Force: act now with each filter\'s action', value: 'force' })))
        .addSubcommand(s => s.setName('review').setDescription('Members waiting in the cleanse review queue'))
        .addSubcommand(s => s.setName('decide').setDescription('Decide a queued member')
            .addUserOption(o => o.setName('user').setDescription('Member in the queue').setRequired(true))
            .addStringOption(o => o.setName('decision').setDescription('What to do').setRequired(true).addChoices(
                { name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' },
                { name: 'Mark safe', value: 'safe' }, { name: 'Skip', value: 'skip' })))
        .addSubcommand(s => s.setName('safe').setDescription('Mark a member safe for their current names')
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
            .addBooleanOption(o => o.setName('undo').setDescription('Take the safe mark off instead')))
        .addSubcommand(s => s.setName('template').setDescription('Curated filter packs, kept up to date centrally')
            .addStringOption(o => o.setName('pack').setDescription('Which pack').setRequired(true).addChoices(
                ...TEMPLATE_PACKS.map(p => ({ name: p.title, value: p.id }))))
            .addStringOption(o => o.setName('do').setDescription('Apply, remove or show (default: show)').addChoices(
                { name: 'Show', value: 'show' }, { name: 'Apply', value: 'apply' }, { name: 'Remove', value: 'remove' }))
            .addStringOption(o => actionOpt(o, 'Action for the pack\'s filters (apply)')))
        .addSubcommand(s => s.setName('settings').setDescription('Switch name checks on and set how they act')
            .addBooleanOption(o => o.setName('enabled').setDescription('Check names on join and on every rename'))
            .addBooleanOption(o => o.setName('fuzzy').setDescription('Fold lookalike letters, zalgo and leetspeak (default on)'))
            .addBooleanOption(o => o.setName('collapse').setDescription('Also ignore separators and repeated letters'))
            .addRoleOption(o => o.setName('flag_role').setDescription('Role for the flag action'))
            .addIntegerOption(o => o.setName('timeout_minutes').setDescription('Timeout length').setMinValue(1).setMaxValue(40320))
            .addBooleanOption(o => o.setName('dm').setDescription('Tell removed / timed-out members why')))
        .addSubcommand(s => s.setName('generated').setDescription('Generated scam usernames like fluffy_panda_4821')
            .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
            .addStringOption(o => actionOpt(o)))
        .addSubcommand(s => s.setName('autopilot').setDescription('Protect staff names from impersonators automatically')
            .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
            .addStringOption(o => actionOpt(o, 'Action against impersonators'))
            .addBooleanOption(o => o.setName('include_managers').setDescription('Cover bot managers and allowlisted members'))
            .addRoleOption(o => o.setName('add_role').setDescription('Also protect this staff role'))
            .addRoleOption(o => o.setName('remove_role').setDescription('Stop covering this role'))
            .addBooleanOption(o => o.setName('sync').setDescription('Refresh the protected names now')))
        .addSubcommand(s => s.setName('status').setDescription('What name filters are doing in this server'))
        .addSubcommand(s => s.setName('hits').setDescription('Recent name-filter hits'))
        .addSubcommand(s => s.setName('export').setDescription('Download this server\'s own filters as a JSON file'))
        .addSubcommand(s => s.setName('import').setDescription('Import filters from an export file (previewed first)')
            .addAttachmentOption(o => o.setName('file').setDescription('A /namefilter export JSON file').setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guild = interaction.guild;
        try {
            const access = await liveConfigAccess(guild, interaction.user.id);
            if (!access.ok) {
                return interaction.reply({ content: 'You need Manage Server, Administrator or a bot-manager role to use this.', ...EPHEMERAL });
            }
            return await HANDLERS[sub](interaction, guild, access.member);
        } catch (error) {
            logger.error('[NameFilter Command] Error:', { error: error.message, sub, stack: error.stack });
            const reply = { content: `Error: ${error.message}`, ...EPHEMERAL };
            if (interaction.deferred || interaction.replied) return interaction.editReply(reply);
            return interaction.reply(reply);
        }
    },
};

function hitLines(hits, limit = 15) {
    return hits.slice(0, limit).map(h => `<@${h.id}> · ${h.fieldLabel} \`${h.text.replace(/`/g, "'").slice(0, 40)}\``).join('\n');
}

const HANDLERS = {
    async add(interaction, guild, member) {
        const type = interaction.options.getString('type');
        const pattern = interaction.options.getString('pattern');
        const action = interaction.options.getString('action') || 'log';
        const caseSensitive = !!interaction.options.getBoolean('case_sensitive');
        const note = interaction.options.getString('note');
        await interaction.deferReply(EPHEMERAL);
        const preview = await nf.previewFilter(guild, { type, pattern, caseSensitive });
        if (!preview.ok) return interaction.editReply({ content: preview.error });
        const token = nf.rememberPending({
            kind: 'add', guildId: guild.id, actorId: interaction.user.id,
            filter: { type, pattern: preview.value, action, caseSensitive, note }, userIds: preview.hits.map(h => h.id),
        });
        const embed = new EmbedBuilder()
            .setColor(preview.count ? 0xE67E22 : 0x2ECC71)
            .setTitle(`New filter: ${filterLabel({ type, value: preview.value })}`)
            .setDescription(preview.count
                ? `It would match **${preview.count}** current member(s):\n${hitLines(preview.hits)}${preview.count > 15 ? `\n…and ${preview.count - 15} more (full list on the dashboard)` : ''}`
                : 'It matches nobody in the server right now.')
            .addFields(
                { name: 'Action', value: ACTION_WORD[action], inline: true },
                { name: 'Checked', value: `${preview.total} members${preview.complete ? '' : ' (list incomplete)'}`, inline: true },
                ...(preview.skipped.staff || preview.skipped.exempt
                    ? [{ name: 'Left alone', value: `${preview.skipped.staff} staff · ${preview.skipped.exempt} exempt`, inline: true }] : []))
            .setFooter({ text: 'Nothing is saved until you press a button. Expires in 15 minutes.' });
        const buttons = [new ButtonBuilder().setCustomId(`namefilter_save:${token}`).setLabel('Save').setStyle(ButtonStyle.Primary)];
        if (preview.count) {
            buttons.push(new ButtonBuilder().setCustomId(`namefilter_act:${token}`)
                .setLabel(action === 'log' ? `Save and queue these ${preview.count} for review` : `Save and ${ACT_LABEL[action].toLowerCase()} these ${preview.count}`)
                .setStyle(action === 'log' ? ButtonStyle.Secondary : ButtonStyle.Danger));
        }
        buttons.push(new ButtonBuilder().setCustomId(`namefilter_no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        return interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(...buttons)], allowedMentions: { parse: [] } });
    },

    async edit(interaction, guild) {
        const id = interaction.options.getInteger('id');
        const patch = {};
        const action = interaction.options.getString('action');
        const enabled = interaction.options.getBoolean('enabled');
        const note = interaction.options.getString('note');
        if (action) patch.action = action;
        if (enabled !== null) patch.enabled = enabled;
        if (note !== null) patch.note = note;
        if (!Object.keys(patch).length) return interaction.reply({ content: 'Give something to change: action, enabled or note.', ...EPHEMERAL });
        const out = await nf.updateFilter(guild, id, patch, interaction.user.id);
        return interaction.reply({ content: out.ok ? `Filter #${id} updated.` : out.error, ...EPHEMERAL });
    },

    async remove(interaction, guild) {
        const id = interaction.options.getInteger('id');
        const ok = await nf.removeFilter(guild, id, interaction.user.id);
        return interaction.reply({ content: ok ? `Filter #${id} removed.` : `There is no name filter #${id} here.`, ...EPHEMERAL });
    },

    async list(interaction, guild) {
        const show = interaction.options.getString('show') || 'all';
        const rows = (await nf.listFilters(guild.id)).filter(r => !r.removed && (show === 'all' || r.origin === show));
        const lines = rows.slice(0, 30).map(r => `\`#${r.id}\` ${r.enabled ? '' : '~~'}${filterLabel({ type: r.type, value: r.pattern })}${r.enabled ? '' : '~~'}`
            + ` · ${ACTION_WORD[r.action]}${r.origin !== 'manual' ? ` · ${r.origin === 'auto' ? `Auto-Pilot <@${r.autoUserId}>` : r.pack}` : ''}`
            + ` · ${r.hits} hit(s)${r.lastHitAt ? `, last <t:${ts(r.lastHitAt)}:R>` : ''}`);
        const text = lines.length ? lines.join('\n') : 'No filters yet. `/moderation namefilter add` or apply a `/moderation namefilter template`.';
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle(`Name filters (${rows.length})`).setDescription(text.slice(0, 4000)
                + (rows.length > 30 ? `\n…${rows.length - 30} more on the dashboard` : ''))
                .setFooter({ text: 'Edit, preview and review on the dashboard: Name Filters page' })],
            allowedMentions: { parse: [] }, ...EPHEMERAL,
        });
    },

    async test(interaction, guild) {
        const name = interaction.options.getString('name');
        const user = interaction.options.getUser('user');
        if (!name && !user) return interaction.reply({ content: 'Give a `name` to try or a `user` to check.', ...EPHEMERAL });
        await interaction.deferReply(EPHEMERAL);
        const member = user ? await guild.members.fetch(user.id).catch(() => null) : null;
        if (user && !member) return interaction.editReply({ content: 'They are not in this server.' });
        const r = await nf.testNames(guild, member ? { member } : { text: name });
        const embed = new EmbedBuilder().setColor(r.top ? 0xC0392B : 0x2ECC71)
            .setTitle(r.top ? `Matches ${r.matches.length} filter(s)` : 'No filter matches');
        for (const f of r.fields) {
            embed.addFields({ name: f.fieldLabel, value: `\`${f.text.replace(/`/g, "'")}\` → folded \`${f.forms.skeleton.replace(/`/g, "'") || ' '}\``.slice(0, 1024) });
        }
        if (r.matches.length) {
            embed.addFields({ name: 'Matches', value: r.matches.slice(0, 10).map(m => `${m.filterId ? `#${m.filterId} ` : ''}${m.label} · ${ACTION_WORD[m.action] ?? ''} · ${m.fieldLabel} (${m.formLabel})`).join('\n').slice(0, 1024) });
        }
        if (r.generated) embed.addFields({ name: 'Generated username', value: `\`${r.generated.first}\` + \`${r.generated.second}\` + digits · check is ${r.generated.enabled ? `on (${ACTION_WORD[r.generated.action]})` : 'off'}` });
        if (r.notes.length) embed.addFields({ name: 'Notes', value: r.notes.join('\n') });
        if (!r.settings.enabled) embed.setFooter({ text: 'Name checks are switched off: /moderation namefilter settings enabled:true' });
        return interaction.editReply({ embeds: [embed] });
    },

    async cleanse(interaction, guild, member) {
        const mode = interaction.options.getString('mode') || 'review';
        if (mode === 'force') {
            if (!actorMay(member, guild, 'ban')) {
                return interaction.reply({ content: 'A force cleanse can ban, so it needs the Ban Members permission. Use review mode instead.', ...EPHEMERAL });
            }
            const token = nf.rememberPending({ kind: 'cleanse', guildId: guild.id, actorId: interaction.user.id });
            return interaction.reply({
                content: '**Force cleanse:** every member whose name matches a filter is acted on now with that filter\'s own action '
                    + '(log-only filters still go to the review queue). Staff, exempt and marked-safe members are left alone. Continue?',
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`namefilter_force:${token}`).setLabel('Run force cleanse').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`namefilter_no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
                ...EPHEMERAL,
            });
        }
        const out = nf.startCleanse(guild, { mode: 'review' }, interaction.user.id);
        return interaction.reply({
            content: out.ok
                ? `Cleanse started. Matches go to the review queue (Ban / Kick / Mark safe / Skip): ${dash(guild.id)}\n\`/moderation namefilter review\` shows the queue here too.`
                : out.error,
            ...EPHEMERAL,
        });
    },

    async review(interaction, guild) {
        const rows = await nf.listReviews(guild.id, { status: 'pending', limit: 20 });
        const status = nf.cleanseStatus(guild.id);
        const lines = rows.map(r => `<@${r.user_id}> · ${FIELD_LABEL[r.field] ?? 'name'} · ${r.filter_label ?? ''}`.slice(0, 180));
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle(`Review queue${rows.length ? ` (${rows.length}${rows.length === 20 ? '+' : ''})` : ''}`)
                .setDescription((lines.join('\n') || 'Nothing waiting.') + `\n\nDecide in bulk on the dashboard: ${dash(guild.id)}\nOr one at a time: \`/moderation namefilter decide\``)
                .setFooter({ text: status.running ? `A cleanse is running: ${status.checked ?? 0}/${status.total ?? '?'} checked` : 'Run /moderation namefilter cleanse to scan again' })],
            allowedMentions: { parse: [] }, ...EPHEMERAL,
        });
    },

    async decide(interaction, guild, member) {
        const user = interaction.options.getUser('user');
        const decision = interaction.options.getString('decision');
        if ((decision === 'ban' || decision === 'kick') && !actorMay(member, guild, decision)) {
            return interaction.reply({ content: `You need the ${NEEDS[decision][1]} permission for that.`, ...EPHEMERAL });
        }
        await interaction.deferReply(EPHEMERAL);
        const out = await nf.decideReviews(guild, [user.id], decision, interaction.user.id);
        const failed = out.failed.map(f => f.problem).join('; ');
        return interaction.editReply({ content: out.done ? `Done: ${decision} <@${user.id}>.` : (failed || 'They are not in the review queue (or were skipped: left, staff or exempt).'), allowedMentions: { parse: [] } });
    },

    async safe(interaction, guild) {
        const user = interaction.options.getUser('user');
        if (interaction.options.getBoolean('undo')) {
            const ok = await nf.unmarkSafe(guild, user.id, interaction.user.id);
            return interaction.reply({ content: ok ? `<@${user.id}> is no longer marked safe.` : 'They were not marked safe.', allowedMentions: { parse: [] }, ...EPHEMERAL });
        }
        const out = await nf.markSafe(guild, user.id, interaction.user.id);
        return interaction.reply({
            content: out.ok ? `<@${user.id}> is marked safe while their names stay as they are (a rename is checked again).` : out.error,
            allowedMentions: { parse: [] }, ...EPHEMERAL,
        });
    },

    async template(interaction, guild) {
        const packId = interaction.options.getString('pack');
        const what = interaction.options.getString('do') || 'show';
        if (what === 'apply') {
            const out = await nf.applyTemplate(guild, packId, interaction.options.getString('action') || 'log', interaction.user.id);
            return interaction.reply({ content: out.ok ? `Applied: ${out.count} filter(s). New entries arrive automatically when the pack is updated.` : out.error, ...EPHEMERAL });
        }
        if (what === 'remove') {
            const out = await nf.removeTemplate(guild, packId, interaction.user.id);
            return interaction.reply({ content: out.ok ? `Removed the pack (${out.removed} filter(s)).` : out.error, ...EPHEMERAL });
        }
        const pack = (await nf.listTemplates(guild.id)).find(p => p.id === packId);
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle(pack.title).setDescription(`${pack.description}\n\n`
                + pack.entries.map(e => `• ${filterLabel({ type: e.type, value: e.value })}`).join('\n').slice(0, 3500))
                .setFooter({ text: pack.applied ? `Applied here (${ACTION_WORD[pack.action]}): ${pack.active} active, ${pack.removed} removed` : 'Not applied here' })],
            ...EPHEMERAL,
        });
    },

    async settings(interaction, guild) {
        const o = interaction.options;
        const patch = {};
        if (o.getBoolean('enabled') !== null) patch.enabled = o.getBoolean('enabled');
        if (o.getBoolean('fuzzy') !== null) patch.fuzzy = o.getBoolean('fuzzy');
        if (o.getBoolean('collapse') !== null) patch.collapse = o.getBoolean('collapse');
        if (o.getRole('flag_role')) patch.flagRoleId = o.getRole('flag_role').id;
        if (o.getInteger('timeout_minutes') !== null) patch.timeoutMinutes = o.getInteger('timeout_minutes');
        if (o.getBoolean('dm') !== null) patch.dm = o.getBoolean('dm');
        const s = await nf.saveSettings(guild, patch, interaction.user.id);
        return interaction.reply({ content: `${Object.keys(patch).length ? 'Saved. ' : ''}${describe(s)}`, ...EPHEMERAL });
    },

    async generated(interaction, guild) {
        const patch = { generated: {} };
        if (interaction.options.getBoolean('enabled') !== null) patch.generated.enabled = interaction.options.getBoolean('enabled');
        if (interaction.options.getString('action')) patch.generated.action = interaction.options.getString('action');
        const s = await nf.saveSettings(guild, patch, interaction.user.id);
        return interaction.reply({
            content: `Generated-username check is **${s.generated.enabled ? 'on' : 'off'}** (${ACTION_WORD[s.generated.action]}). `
                + 'It only fires when both words are in the scam generators\' vocabulary, so names like john_smith_1234 pass. Start with log only.',
            ...EPHEMERAL,
        });
    },

    async autopilot(interaction, guild) {
        const o = interaction.options;
        const s0 = await nf.getSettings(guild.id);
        const a = {};
        if (o.getBoolean('enabled') !== null) a.enabled = o.getBoolean('enabled');
        if (o.getString('action')) a.action = o.getString('action');
        if (o.getBoolean('include_managers') !== null) a.managers = o.getBoolean('include_managers');
        if (o.getRole('add_role') || o.getRole('remove_role')) {
            const roles = new Set(s0.autopilot.roles);
            if (o.getRole('add_role')) roles.add(o.getRole('add_role').id);
            if (o.getRole('remove_role')) roles.delete(o.getRole('remove_role').id);
            a.roles = [...roles];
        }
        const s = Object.keys(a).length ? await nf.saveSettings(guild, { autopilot: a }, interaction.user.id) : s0;
        let synced = '';
        if (o.getBoolean('sync') && s.autopilot.enabled) {
            await interaction.deferReply(EPHEMERAL);
            const r = await nf.syncAutoPilot(guild, { fetch: true });
            synced = `\nSynced: ${r.protected} protected member(s), ${r.created} filter(s) added, ${r.retired} retired.`;
        }
        const text = `Auto-Pilot is **${s.autopilot.enabled ? 'on' : 'off'}** (${ACTION_WORD[s.autopilot.action]}). Covers: `
            + [s.autopilot.managers && 'bot managers and allowlisted members', ...s.autopilot.roles.map(r => `<@&${r}>`)].filter(Boolean).join(', ')
            + '. Names under 4 letters and names someone else already uses are skipped; deleting an Auto-Pilot filter is remembered.' + synced;
        return interaction.deferred ? interaction.editReply({ content: text, allowedMentions: { parse: [] } })
            : interaction.reply({ content: text, allowedMentions: { parse: [] }, ...EPHEMERAL });
    },

    async status(interaction, guild) {
        const o = await nf.overview(guild);
        const f = o.filters;
        const n = (k) => f[k]?.active ?? 0;
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle('Name filters').setDescription(describe(o.settings))
                .addFields(
                    { name: 'Filters', value: `${n('manual')} yours · ${n('template')} from templates · ${n('auto')} Auto-Pilot`, inline: false },
                    { name: 'Hits (30 days)', value: `${o.hits30d}${o.lastHitAt ? `, last <t:${ts(o.lastHitAt)}:R>` : ''}`, inline: true },
                    { name: 'Review queue', value: String(o.reviews.pending ?? 0), inline: true },
                    { name: 'Marked safe', value: String(o.reviews.safe ?? 0), inline: true })
                .setFooter({ text: 'Dashboard: Name Filters page' })],
            ...EPHEMERAL,
        });
    },

    async export(interaction, guild) {
        await interaction.deferReply(EPHEMERAL);
        const data = await nf.exportFilters(guild);
        const file = new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2), 'utf8'), { name: `name-filters-${guild.id}.json` });
        return interaction.editReply({
            content: `${data.filters.length} filter(s) exported (templates and Auto-Pilot entries are not included). Import it with \`/moderation namefilter import\` or on the dashboard.`,
            files: [file],
        });
    },

    async import(interaction, guild) {
        const att = interaction.options.getAttachment('file');
        if (!att || att.size > 2 * 1024 * 1024) return interaction.reply({ content: 'Attach an export file of at most 2 MB.', ...EPHEMERAL });
        await interaction.deferReply(EPHEMERAL);
        let text;
        try {
            const res = await fetch(att.url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            text = await res.text();
        } catch (err) {
            return interaction.editReply({ content: `Could not read that file (${err.message}).` });
        }
        const plan = await nf.importFilters(guild, text, { apply: false });
        if (!plan.ok) return interaction.editReply({ content: plan.error });
        const line = (f) => `${f.type} \`${String(f.pattern).replace(/`/g, "'").slice(0, 50)}\``;
        const embed = new EmbedBuilder()
            .setColor(plan.add.length ? 0x3498DB : 0x95A5A6)
            .setTitle(`Import preview: ${plan.add.length} to add`)
            .setDescription([
                plan.add.length ? `**Will be added:**\n${plan.add.slice(0, 10).map(line).join('\n')}${plan.add.length > 10 ? `\n…and ${plan.add.length - 10} more` : ''}` : 'Nothing new to add.',
                plan.duplicates.length ? `**Already there (skipped):** ${plan.duplicates.length}` : null,
                plan.rejected.length ? `**Refused:**\n${plan.rejected.slice(0, 5).map(r => `${line(r)}: ${r.why}`).join('\n')}${plan.rejected.length > 5 ? `\n…and ${plan.rejected.length - 5} more` : ''}` : null,
                plan.overCap.length ? `**Over the limit (not added):** ${plan.overCap.length}` : null,
            ].filter(Boolean).join('\n\n').slice(0, 4000))
            .setFooter({ text: 'Nothing is saved until you press Import. Expires in 15 minutes.' });
        if (!plan.add.length) return interaction.editReply({ embeds: [embed] });
        const token = nf.rememberPending({ kind: 'import', guildId: guild.id, actorId: interaction.user.id, text });
        return interaction.editReply({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`namefilter_import:${token}`).setLabel(`Import ${plan.add.length}`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`namefilter_no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
        });
    },

    async hits(interaction, guild) {
        const rows = await nf.recentHits(guild.id, 20);
        const word = { name_banned: 'banned', name_kicked: 'kicked', name_timeout: 'timed out', name_flagged: 'flagged', name_logged: 'logged', failed: 'could not act' };
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle('Recent name-filter hits')
                .setDescription(rows.map(r => `<t:${ts(r.created_at)}:R> <@${r.user_id}> · ${word[r.action] ?? r.action} · ${String(r.detail ?? '').slice(0, 90)}`).join('\n').slice(0, 4000) || 'None yet.')],
            allowedMentions: { parse: [] }, ...EPHEMERAL,
        });
    },
};

function describe(s) {
    return [
        `Name checks are **${s.enabled ? 'on' : 'off'}** (join and every rename).`,
        `Fuzzy matching ${s.fuzzy ? 'on' : 'off'}${s.collapse ? ', separators and repeats ignored' : ''}.`,
        `Flag role: ${s.flagRoleId ? `<@&${s.flagRoleId}>` : `"${nf.FLAG_ROLE_NAME}" (made when first needed)`} · timeout ${s.timeoutMinutes} min · DM ${s.dm ? 'on' : 'off'}.`,
        `Generated usernames: ${s.generated.enabled ? ACTION_WORD[s.generated.action] : 'off'} · Auto-Pilot: ${s.autopilot.enabled ? ACTION_WORD[s.autopilot.action] : 'off'}.`,
    ].join('\n');
}
