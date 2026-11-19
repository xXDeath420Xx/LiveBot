import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import {
    runAudit, loadAudit, latestAudit, compareAudits,
    formatDuration, SEGMENTS, DEFAULT_WINDOW_DAYS,
} from '../../core/activity-audit.js';
import { buildAuditEmbeds } from '../../core/activity-audit-render.js';
import {
    requiresApplication, syncGuild, requestsForUser, fetchJoinSource,
    decidedByText, answerFields,
} from '../../core/join-request-tracker.js';
import { normaliseFilter, describeFilter } from '../../core/activity-audit-filter.js';
import {
    planAction, executeAction, recentActions,
    ACTIONS, MAX_TARGETS, DEFAULT_MIN_MEMBERSHIP_DAYS,
} from '../../core/activity-audit-actions.js';

const n = (x) => Number(x).toLocaleString('en-US');

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('activity')
        .setDescription('Member activity audits — who is actually still here, by messages and voice')
        .addSubcommand(sub =>
            sub.setName('run')
                .setDescription('Sweep every channel and voice log, then store a snapshot')
                .addIntegerOption(o => o.setName('days')
                    .setDescription('Window to measure (default 90)')
                    .setMinValue(7).setMaxValue(365))
                .addChannelOption(o => o.setName('post_to')
                    .setDescription('Also post the report to this channel when it finishes')
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                .addBooleanOption(o => o.setName('compare')
                    .setDescription('Include movement since the previous audit (default true)')))
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('Show a segment of the latest audit')
                .addStringOption(o => o.setName('segment')
                    .setDescription('Which group of members to list')
                    .addChoices(...SEGMENTS.filter(s => s.key !== 'all').slice(0, 25)
                        .map(s => ({ name: s.label, value: s.key }))))
                .addIntegerOption(o => o.setName('audit_id')
                    .setDescription('A specific audit instead of the latest')))
        .addSubcommand(sub =>
            sub.setName('post')
                .setDescription('Post the latest stored audit to a channel')
                .addChannelOption(o => o.setName('channel')
                    .setDescription('Where to post')
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setRequired(true))
                .addIntegerOption(o => o.setName('audit_id')
                    .setDescription('A specific audit instead of the latest')))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Recent audits for this server'))
        .addSubcommand(sub =>
            sub.setName('action')
                .setDescription('Kick or role a filtered group. Previews by default — nothing happens without confirm:true')
                .addStringOption(o => o.setName('segment')
                    .setDescription('Which group to act on')
                    .setRequired(true)
                    .addChoices(...SEGMENTS.filter(s => s.key !== 'all').slice(0, 25)
                        .map(s => ({ name: s.label, value: s.key }))))
                .addStringOption(o => o.setName('do')
                    .setDescription('What to do to them')
                    .setRequired(true)
                    .addChoices(...Object.entries(ACTIONS).map(([k, a]) => ({ name: a.label, value: k }))))
                .addRoleOption(o => o.setName('role')
                    .setDescription('Role to add or remove (required for role actions)'))
                .addBooleanOption(o => o.setName('confirm')
                    .setDescription('Actually do it. Leave off to preview.'))
                .addIntegerOption(o => o.setName('grace_days')
                    .setDescription(`Never kick members who joined within this many days (default ${DEFAULT_MIN_MEMBERSHIP_DAYS})`)
                    .setMinValue(0).setMaxValue(90))
                .addStringOption(o => o.setName('reason')
                    .setDescription('Recorded in the Discord audit log'))
                .addIntegerOption(o => o.setName('audit_id')
                    .setDescription('A specific audit instead of the latest')))
        .addSubcommand(sub =>
            sub.setName('actions')
                .setDescription('History of bulk actions taken from audits'))
        .addSubcommand(sub =>
            sub.setName('joined')
                .setDescription('Who let a member in: application approver, invite used, join method')
                .addUserOption(o => o.setName('user')
                    .setDescription('Member, or a pasted user ID for someone who left or was banned')
                    .setRequired(true)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'run') return handleRun(interaction);
            if (sub === 'view') return handleView(interaction);
            if (sub === 'post') return handlePost(interaction);
            if (sub === 'list') return handleList(interaction);
            if (sub === 'action') return handleAction(interaction);
            if (sub === 'actions') return handleActionHistory(interaction);
            if (sub === 'joined') return handleJoined(interaction);
        } catch (error) {
            logger.error('[Activity] Command error', { error: error.message, stack: error.stack, sub });
            const embed = new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'danger'))
                .setTitle('Audit failed')
                .setDescription(error.message.slice(0, 400));
            if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [embed] });
            else await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    },
};

async function handleRun(interaction) {
    await interaction.deferReply();
    const days = interaction.options.getInteger('days') ?? DEFAULT_WINDOW_DAYS;
    const postTo = interaction.options.getChannel('post_to');
    const compare = interaction.options.getBoolean('compare') ?? true;

    // Captured BEFORE the run so it is the audit this one gets compared against, not itself.
    const previousId = await latestAudit(interaction.guild.id);

    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('Auditing…')
            .setDescription(`Sweeping every channel and thread back ${days} days, then reading the voice log.\nLarge servers take a few minutes.`)],
    });

    // Progress edits are throttled hard: Discord rate-limits message edits per channel, and
    // a per-container update on a 78-container guild would spend the whole budget on
    // progress bars rather than the report.
    let lastEdit = 0;
    const { auditId } = await runAudit(interaction.client, interaction.guild.id, {
        days,
        requestedBy: interaction.user.id,
        source: 'command',
        onProgress: ({ done, total, name }) => {
            const now = Date.now();
            if (now - lastEdit < 8000 && done !== total) return;
            lastEdit = now;
            interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'primary'))
                    .setTitle('Auditing…')
                    .setDescription(`Swept **${done}/${total}** channels and threads.\nLast: ${name ?? '—'}`)],
            }).catch(() => {});
        },
    });

    const loaded = await loadAudit(auditId);
    const diff = compare && previousId ? await compareAudits(auditId, previousId) : null;
    const embeds = buildAuditEmbeds(loaded, { diff, guildName: interaction.guild.name });

    await interaction.editReply({ embeds: embeds.slice(0, 4) });

    if (postTo) {
        const posted = await postEmbeds(postTo, embeds);
        await pool.execute('UPDATE activity_audits SET posted_messages = ? WHERE audit_id = ?',
            [JSON.stringify([{ channelId: postTo.id, messageIds: posted }]), auditId]);
        await interaction.followUp({
            embeds: [new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'success'))
                .setTitle('Posted')
                .setDescription(`Audit \`#${auditId}\` posted to ${postTo} as ${posted.length} message${posted.length === 1 ? '' : 's'}.`)],
            ephemeral: true,
        });
    }
}

async function handleView(interaction) {
    await interaction.deferReply();
    const key = interaction.options.getString('segment') ?? 'never_active';
    const auditId = interaction.options.getInteger('audit_id') ?? await latestAudit(interaction.guild.id);
    if (!auditId) return noAudit(interaction);

    const loaded = await loadAudit(auditId);
    if (loaded.audit.guildId !== interaction.guild.id) return noAudit(interaction);

    const seg = SEGMENTS.find(s => s.key === key);
    const members = loaded.members
        .filter(m => seg.predicate(m, loaded.ctx))
        .sort((a, b) => (b.messages - a.messages) || (b.voiceSeconds - a.voiceSeconds));

    const lines = members.slice(0, 60).map((m, i) =>
        `\`${String(i + 1).padStart(3)}\` **${escapeMd(m.displayName)}** — ${n(m.messages)} msg · ` +
        `${formatDuration(m.voiceSeconds)} voice` +
        (m.daysSinceActive === null ? ' · never active' : ` · ${m.daysSinceActive}d ago`));

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, seg.tone === 'bad' ? 'danger' : seg.tone === 'warn' ? 'warning' : 'primary'))
        .setTitle(`${seg.label} — ${members.length} members`)
        .setDescription((seg.describe + '\n\n' + (lines.join('\n') || '_Nobody in this group._')).slice(0, 4000))
        .setFooter({ text: `Audit #${auditId} · ${loaded.audit.windowDays}-day window` +
            (members.length > 60 ? ` · showing 60 of ${members.length}` : '') +
            (loaded.audit.voiceTracked ? '' : ' · voice not tracked for this window') })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handlePost(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    const auditId = interaction.options.getInteger('audit_id') ?? await latestAudit(interaction.guild.id);
    if (!auditId) return noAudit(interaction);

    const loaded = await loadAudit(auditId);
    if (loaded.audit.guildId !== interaction.guild.id) return noAudit(interaction);

    const previousId = await latestAudit(interaction.guild.id, { before: auditId });
    const diff = previousId ? await compareAudits(auditId, previousId) : null;
    const embeds = buildAuditEmbeds(loaded, { diff, guildName: interaction.guild.name });

    const posted = await postEmbeds(channel, embeds);
    await pool.execute('UPDATE activity_audits SET posted_messages = ? WHERE audit_id = ?',
        [JSON.stringify([{ channelId: channel.id, messageIds: posted }]), auditId]);

    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle('Posted')
            .setDescription(`Audit \`#${auditId}\` posted to ${channel} as ${posted.length} message${posted.length === 1 ? '' : 's'}.`)],
    });
}

async function handleList(interaction) {
    await interaction.deferReply();
    const [rows] = await pool.execute(
        `SELECT audit_id, window_days, status, started_at, completed_at, totals, voice_tracked
           FROM activity_audits WHERE guild_id = ? ORDER BY audit_id DESC LIMIT 10`,
        [interaction.guild.id]
    );
    if (!rows.length) return noAudit(interaction);

    const lines = rows.map(r => {
        const t = r.totals ? JSON.parse(r.totals) : null;
        const when = new Date(r.completed_at ?? r.started_at).toISOString().slice(0, 10);
        const state = r.status === 'complete'
            ? `${t ? `${t.posters} posters · ${t.voiceUsers} in voice` : 'no totals'}`
            : `**${r.status}**`;
        return `\`#${String(r.audit_id).padStart(3)}\` ${when} · ${r.window_days}d · ${state}` +
            (r.voice_tracked ? '' : ' · _voice untracked_');
    });

    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('Recent audits')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Use /moderation activity view or /activity post with an audit_id' })],
    });
}

function noAudit(interaction) {
    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'warning'))
            .setTitle('No audit yet')
            .setDescription('Run `/moderation activity run` first — it sweeps every channel and can take a few minutes.')],
    });
}

/** Group embeds under Discord's 10-embed / 6000-character ceiling and send them in order. */
async function postEmbeds(channel, embeds) {
    const size = (e) => (e.data?.title ?? e.title ?? '').length +
        (e.data?.description ?? e.description ?? '').length +
        (e.data?.footer?.text ?? e.footer?.text ?? '').length +
        ((e.data?.fields ?? e.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0));

    const groups = [];
    let cur = [];
    for (const e of embeds) {
        const would = cur.reduce((s, x) => s + size(x), 0) + size(e);
        if (cur.length && (would > 5500 || cur.length >= 10)) { groups.push(cur); cur = []; }
        cur.push(e);
    }
    if (cur.length) groups.push(cur);

    const ids = [];
    for (const g of groups) {
        const msg = await channel.send({ embeds: g, allowedMentions: { parse: [] } });
        ids.push(msg.id);
        if (groups.length > 1) await new Promise(r => setTimeout(r, 900));
    }
    return ids;
}

const escapeMd = (s) => String(s ?? '').replace(/([*_~`|\\<>[\]])/g, '\\$1');


/**
 * Preview or perform a bulk action.
 *
 * Preview is the default and confirm:true is a separate deliberate flag, because the
 * difference between "show me who this would kick" and "kick them" must never be a typo.
 * Even with confirm:true the plan is rebuilt and its token re-checked inside executeAction,
 * so the members acted on are exactly the ones the protections just cleared.
 */
async function handleAction(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const segment = interaction.options.getString('segment');
    const actionType = interaction.options.getString('do');
    const role = interaction.options.getRole('role');
    const confirm = interaction.options.getBoolean('confirm') ?? false;
    const graceDays = interaction.options.getInteger('grace_days') ?? DEFAULT_MIN_MEMBERSHIP_DAYS;
    const reason = interaction.options.getString('reason');
    const auditId = interaction.options.getInteger('audit_id') ?? await latestAudit(interaction.guild.id);

    if (!auditId) return noAudit(interaction);
    if (ACTIONS[actionType].needsRole && !role) {
        return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle('That action needs a role')
            .setDescription('Pass `role:` when adding or removing a role.')] });
    }

    const filter = normaliseFilter({ segments: [segment] });
    const spec = {
        auditId, actionType, roleId: role?.id ?? null, filter,
        actorId: interaction.user.id, minMembershipDays: graceDays, reason,
    };

    let plan;
    try {
        plan = await planAction(interaction.client, interaction.guild.id, spec);
    } catch (e) {
        return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle('Cannot plan that')
            .setDescription(e.message)] });
    }

    const blockedBreakdown = {};
    for (const b of plan.blocked) blockedBreakdown[b.reason] = (blockedBreakdown[b.reason] ?? 0) + 1;
    const blockedText = Object.entries(blockedBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([why, count]) => `\`${String(count).padStart(3)}\` ${why}`)
        .join('\n') || '_none_';

    const names = plan.eligible.slice(0, 40).map(e => escapeMd(e.displayName)).join(', ');
    const target = ACTIONS[actionType].label + (role ? ` — ${role.name}` : '');

    if (!confirm) {
        return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'warning'))
            .setTitle(`Preview — nothing has been done`)
            .setDescription(
                `**${target}**\n${plan.filterLabel}\n\n` +
                `**${plan.eligible.length}** member${plan.eligible.length === 1 ? '' : 's'} would be affected` +
                (plan.eligible.length ? `:\n${names}${plan.eligible.length > 40 ? ` +${plan.eligible.length - 40} more` : ''}` : '.'))
            .addFields(
                { name: 'Matched the filter', value: String(plan.counts.selected), inline: true },
                { name: 'Would be affected', value: String(plan.counts.eligible), inline: true },
                { name: 'Protected', value: String(plan.counts.blocked), inline: true },
                { name: 'Why members were protected', value: blockedText.slice(0, 1024) },
                ...(plan.warnings.length ? [{ name: 'Notes', value: plan.warnings.join('\n').slice(0, 1024) }] : []),
            )
            .setFooter({ text: `Audit #${auditId} (${plan.snapshotAgeHours}h old) · re-run with confirm:true to apply` })] });
    }

    try {
        const result = await executeAction(interaction.client, interaction.guild.id, {
            ...spec, token: plan.token, source: 'command',
        });
        return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle(`Done — ${target}`)
            .setDescription(plan.filterLabel)
            .addFields(
                { name: 'Succeeded', value: String(result.done), inline: true },
                { name: 'Skipped', value: String(result.skipped), inline: true },
                { name: 'Failed', value: String(result.failed), inline: true },
            )
            .setFooter({ text: `Action #${result.actionId} · see /activity actions` })] });
    } catch (e) {
        return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle(e.code === 'STALE_PLAN' ? 'Nothing was done — the list changed' : 'Action failed')
            .setDescription(e.message)] });
    }
}

async function handleActionHistory(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const rows = await recentActions(interaction.guild.id, 12);
    if (!rows.length) {
        return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('No bulk actions yet')
            .setDescription('Nothing has been kicked or roled from an audit in this server.')] });
    }
    const lines = rows.map(r =>
        `\`#${String(r.id).padStart(3)}\` ${new Date(r.createdAt).toISOString().slice(0, 10)} · ` +
        `**${ACTIONS[r.actionType]?.label ?? r.actionType}** · ` +
        `${r.counts.done} done / ${r.counts.skipped} skipped / ${r.counts.failed} failed · ` +
        `<@${r.requestedBy}>\n${r.filterLabel ?? ''}`);
    await interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('Bulk action history')
        .setDescription(lines.join('\n\n').slice(0, 4000))] });
}

async function handleJoined(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    const user = interaction.options.getUser('user');
    const ts = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:f>`;

    // Pull anything decided since the last sync so a just-approved member shows up.
    if (requiresApplication(guild)) {
        await syncGuild(guild).catch(err => logger.warn(`[Activity] join-request sync failed: ${err.message}`));
    }

    const [requests, member, ban, [invites]] = await Promise.all([
        requestsForUser(guild.id, user.id),
        guild.members.fetch(user.id).catch(() => null),
        guild.bans.fetch(user.id).catch(() => null),
        pool.execute(
            `SELECT inviter_id, invite_code, timestamp FROM invite_tracker_logs
              WHERE guild_id = ? AND user_id = ? ORDER BY timestamp DESC LIMIT 5`,
            [guild.id, user.id]
        ),
    ]);
    const source = member ? await fetchJoinSource(guild, user.id) : null;

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, ban ? 'danger' : 'primary'))
        .setTitle(`How ${user.username} got in`)
        .setDescription(`<@${user.id}> (${user.id})`)
        .setThumbnail(user.displayAvatarURL());

    const status = member
        ? `Member since ${ts(member.joinedAt)}`
        : ban ? `**Banned**${ban.reason ? ` — ${ban.reason.slice(0, 200)}` : ''}` : 'Not in the server';
    embed.addFields({ name: 'Status', value: status });

    if (source) {
        let how = source.label;
        if (source.inviteCode) how += `\nInvite \`${source.inviteCode}\`${source.inviterId ? ` created by <@${source.inviterId}>` : ''}`;
        embed.addFields({ name: 'Join Method (Discord)', value: how });
    }

    if (requests.length) {
        const latest = requests[0];
        embed.addFields({
            name: latest.status === 'APPROVED' ? 'Application Approved By' : 'Application Rejected By',
            value: `${decidedByText(latest)}\nApplied ${ts(latest.applied_at)} · decided ${ts(latest.reviewed_at)}`,
        });
        embed.addFields(...answerFields(latest));
        if (requests.length > 1) {
            embed.addFields({
                name: `Earlier Applications (${requests.length - 1})`,
                value: requests.slice(1, 6).map(r =>
                    `${r.status === 'APPROVED' ? '✅' : '⛔'} ${ts(r.reviewed_at)} by ${r.actioned_by_id ? `<@${r.actioned_by_id}>` : 'unknown'}`
                ).join('\n'),
            });
        }
    } else if (requiresApplication(guild)) {
        embed.addFields({
            name: 'Application',
            value: 'No decided application on record. Either they joined before apply-to-join was switched on, '
                + 'or they got in another way (integration, bot, or an application Discord no longer lists).',
        });
    }

    if (invites.length && !source?.inviteCode) {
        embed.addFields({
            name: 'Invite (bot log)',
            value: invites.map(i => `\`${i.invite_code}\` by <@${i.inviter_id}> — ${ts(i.timestamp)}`).join('\n'),
        });
    }

    await interaction.editReply({ embeds: [embed] });
}
