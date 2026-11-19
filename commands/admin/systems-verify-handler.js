/*
 * `/systems verification` and `/systems auto-prune` — the slash-command side of core/verification.js,
 * core/auto-prune.js and core/inactivity-prune.js (`inactive`, `inactive-exempt`, `inactive-preview`). Everything here is also on the dashboard's Verification page; this is the
 * secondary interface. Kept in /systems because /admin and /protection have no room left.
 *
 * The setup wizard previews first (what it would create, which channels it would lock) and only runs
 * after Confirm (interactions/buttons/verify_accept.js, `vwiz_ok:` / `vwiz_no:`). The preview is held
 * here for 15 minutes; only the person who ran it can confirm.
 */
import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import {
    getVerifyConfig, saveVerifyConfig, postPanel, verificationStats, wizardPreview, wizardUndo, wizardProgress,
    describeConfig, VerificationError,
} from '../../core/verification.js';
import { validateSettings } from '../../core/verification-logic.js';
import {
    getPruneConfig, savePruneSettings, pruneQueue, removeFromQueue, systemRoleIds, PruneError,
} from '../../core/auto-prune.js';
import { formatMinutes, MAX_BYPASS_ROLES } from '../../core/auto-prune-logic.js';
import {
    getInactivityConfig, saveInactivitySettings, previewInactivity, inactivityStatus, InactivityError,
} from '../../core/inactivity-prune.js';
import { MAX_EXEMPT_ROLES } from '../../core/inactivity-prune-logic.js';
import logger from '../../utils/logger.js';

const EPHEMERAL = { flags: 64 };
const PREVIEW_TTL = 15 * 60_000;
const previews = new Map();   // token -> { guildId, actorId, input, at }

export function peekWizardPreview(token) {
    const e = previews.get(token);
    if (!e || Date.now() - e.at > PREVIEW_TTL) { previews.delete(token); return null; }
    return e;
}
export function takeWizardPreview(token) { previews.delete(token); }

const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
const isUserError = (err) => err instanceof VerificationError || err instanceof PruneError || err instanceof InactivityError;

async function fail(interaction, err) {
    if (!isUserError(err)) logger.error(`[Systems verification] ${err.message}`, { stack: err.stack });
    const content = isUserError(err) ? err.message : 'Something went wrong — try again in a moment.';
    return interaction.deferred || interaction.replied ? interaction.editReply({ content }) : interaction.reply({ content, ...EPHEMERAL });
}

/** The finished wizard (or undo) as an embed — shared with the Confirm button. */
export function wizardResultEmbed(p) {
    if (!p) return new EmbedBuilder().setColor(0xE74C3C).setTitle('Setup status unknown').setDescription('Check the dashboard Verification page.');
    if (p.error) return new EmbedBuilder().setColor(0xE74C3C).setTitle('Setup stopped').setDescription(p.error);
    const r = p.result || {};
    const e = new EmbedBuilder().setColor(r.failures?.length ? 0xE67E22 : 0x2ECC71);
    if (p.kind === 'undo') {
        return e.setTitle('Verification setup undone').setDescription([
            `Permission changes reverted: **${r.restored ?? 0}**`,
            r.removed?.length ? `Deleted: ${r.removed.join(', ')}` : null,
            r.failures?.length ? `Could not revert: ${r.failures.slice(0, 8).map(f => f.name).join(', ')}` : null,
        ].filter(Boolean).join('\n'));
    }
    return e.setTitle('Verification is set up').setDescription([
        `Channel: <#${r.channelId}>`,
        `Verified role: <@&${r.verifiedRoleId}>${r.unverifiedRoleId ? ` · Unverified role: <@&${r.unverifiedRoleId}>` : ''}`,
        `Channels locked: **${r.locked ?? 0}**`,
        r.granted ? `Verified role given to **${r.granted.count}** member(s) already here` : null,
        r.failures?.length ? `Could not change: ${r.failures.slice(0, 8).map(f => `#${f.name}`).join(', ')}` : null,
        ...(p.warnings || []),
        'Undo any time with `/systems verification undo` or on the dashboard.',
    ].filter(Boolean).join('\n'));
}

// ── /systems verification ─────────────────────────────────────────────────────

export async function handleVerification(interaction, sub) {
    try {
        switch (sub) {
            case 'setup': return await setup(interaction);
            case 'settings': return await settings(interaction);
            case 'panel': return await panel(interaction);
            case 'status': return await status(interaction);
            case 'undo': return await undo(interaction);
        }
    } catch (err) {
        return fail(interaction, err);
    }
}

async function setup(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const o = interaction.options;
    const input = {
        mode: o.getString('mode') || 'captcha',
        strategy: o.getString('lock') || 'unverified',
        channelId: o.getChannel('channel')?.id || null,
        verifiedRoleId: o.getRole('verified_role')?.id || null,
        unverifiedRoleId: o.getRole('unverified_role')?.id || null,
        hideGate: o.getBoolean('hide_gate') ?? true,
        grantExisting: true,
        postPanel: true,
    };
    const preview = await wizardPreview(interaction.guild, input);
    const token = crypto.randomBytes(8).toString('hex');
    previews.set(token, { guildId: interaction.guildId, actorId: interaction.user.id, input, at: Date.now() });
    const c = preview.creates;
    const hidden = preview.edits.filter(e => e.reason === 'lock');
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Verification setup — preview')
        .setDescription([
            `Mode: **${input.mode === 'captcha' ? 'CAPTCHA' : 'I agree button'}**`,
            c.channel ? `Creates channel **${c.channel}**` : `Uses <#${input.channelId}>`,
            c.verifiedRole ? `Creates role **@${c.verifiedRole}**` : `Verified role: <@&${input.verifiedRoleId}>`,
            c.unverifiedRole ? `Creates role **@${c.unverifiedRole}**` : input.unverifiedRoleId ? `Unverified role: <@&${input.unverifiedRoleId}>` : null,
            `Locks **${preview.lockedCount}** channel(s) (${hidden.length} permission change(s)); ${preview.privateCount} already private, ${preview.skipped.length} skipped.`,
            preview.grantEstimate ? `Gives the Verified role to about **${preview.grantEstimate}** member(s) already here first.` : null,
            ...preview.warnings.map(w => `⚠️ ${w}`),
        ].filter(Boolean).join('\n'))
        .addFields(hidden.length ? [{
            name: 'Channels it changes',
            value: [...new Set(hidden.map(e => `#${e.name}`))].slice(0, 25).join(', ').slice(0, 1000)
                + (new Set(hidden.map(e => e.channelId)).size > 25 ? ' …' : ''),
        }] : [])
        .setFooter({ text: 'Recorded so it can be undone. The preview expires in 15 minutes.' });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vwiz_ok:${token}`).setLabel('Apply').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`vwiz_no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.editReply({ embeds: [embed], components: [row] });
}

async function settings(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const o = interaction.options;
    const input = {};
    const pick = (key, value) => { if (value !== null && value !== undefined) input[key] = value; };
    pick('enabled', o.getBoolean('enabled'));
    pick('mode', o.getString('mode'));
    pick('attempts', o.getInteger('attempts'));
    pick('windowMinutes', o.getInteger('minutes'));
    pick('failAction', o.getString('fail_action'));
    pick('timeoutMinutes', o.getInteger('timeout_minutes'));
    pick('failDm', o.getBoolean('dm'));
    pick('unverifiedKickDays', o.getInteger('unverified_days'));
    const { patch, errors } = validateSettings(input);
    if (errors.length) return interaction.editReply({ content: errors.join(' ') });
    const before = await getVerifyConfig(interaction.guildId);
    if (!before) return interaction.editReply({ content: 'Verification is not set up yet — run `/systems verification setup` first.' });
    const cfg = await saveVerifyConfig(interaction.guildId, patch);
    const modeChanged = patch.mode && patch.mode !== before.mode;
    return interaction.editReply({
        content: `Saved. Verification: **${describeConfig(cfg)}**.`
            + (modeChanged && cfg.messageId ? '\nThe panel still shows the old wording — re-post it with `/systems verification panel`.' : ''),
    });
}

async function panel(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const channel = interaction.options.getChannel('channel');
    const msg = await postPanel(interaction.guild, { channelId: channel?.id || null });
    return interaction.editReply({ content: `Panel posted: ${msg.url}` });
}

async function status(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const cfg = await getVerifyConfig(interaction.guildId);
    if (!cfg) return interaction.editReply({ content: 'Verification is not set up. Run `/systems verification setup` or use the dashboard Verification page.' });
    const s = await verificationStats(interaction.guildId, 30);
    const job = wizardProgress(interaction.guildId);
    const embed = new EmbedBuilder()
        .setColor(cfg.enabled ? 0x2ECC71 : 0x6B7280)
        .setTitle(`Verification — ${describeConfig(cfg)}`)
        .addFields(
            { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'not set', inline: true },
            { name: 'Verified role', value: cfg.verifiedRoleId ? `<@&${cfg.verifiedRoleId}>` : 'not set', inline: true },
            { name: 'Unverified role', value: cfg.unverifiedRoleId ? `<@&${cfg.unverifiedRoleId}>` : 'none', inline: true },
            {
                name: 'Last 30 days',
                value: [
                    `Verified **${s.verified}** · failed **${s.failed}** · timed out **${s.timedOut}** · wrong codes **${s.wrong}**`,
                    `Kicked **${s.kicked}** · banned **${s.banned}** · timed out (Discord) **${s.timeouts}** · held **${s.held}**`,
                    `Verification rate: **${pct(s.rate)}** · waiting now: **${s.pendingVerify}**`,
                ].join('\n'),
            },
            {
                name: 'Setup wizard',
                value: cfg.wizard
                    ? `${cfg.wizard.status === 'undone' ? 'Undone' : 'Applied'} ${cfg.wizard.at ? `<t:${Math.floor(new Date(cfg.wizard.at).getTime() / 1000)}:R>` : ''} · ${cfg.wizard.edits?.length || 0} permission change(s) recorded${job?.running ? ` · running: ${job.phase}` : ''}`
                    : 'not used',
            },
        );
    return interaction.editReply({ embeds: [embed] });
}

async function undo(interaction) {
    await interaction.deferReply(EPHEMERAL);
    await wizardUndo(interaction.guild, { deleteCreated: interaction.options.getBoolean('delete_created') ?? false }, interaction.user);
    for (let i = 0; i < 390; i++) {           // ~13 minutes: inside the 15-minute interaction token
        const p = wizardProgress(interaction.guildId);
        if (!p?.running) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    const p = wizardProgress(interaction.guildId);
    if (p?.running) return interaction.editReply({ content: 'Still working — check the dashboard Verification page for progress.' });
    return interaction.editReply({ embeds: [wizardResultEmbed(p)] });
}

// ── /systems auto-prune ───────────────────────────────────────────────────────

export async function handleAutoPrune(interaction, sub) {
    try {
        await interaction.deferReply(EPHEMERAL);
        const guild = interaction.guild;
        if (sub === 'set') {
            const o = interaction.options;
            const input = {};
            for (const [key, value] of [['enabled', o.getBoolean('enabled')], ['minutes', o.getInteger('minutes')],
                ['action', o.getString('action')], ['dm', o.getBoolean('dm')]]) {
                if (value !== null && value !== undefined) input[key] = value;
            }
            const days = o.getInteger('days');
            if (days) input.minutes = days * 1440;
            const { cfg, cleared } = await savePruneSettings(guild, input, interaction.user);
            return interaction.editReply({ content: `${describePrune(cfg)}${cleared ? `\nCleared ${cleared} member(s) from the queue.` : ''}` });
        }
        if (sub === 'bypass') {
            const role = interaction.options.getRole('role', true);
            const remove = interaction.options.getBoolean('remove') ?? false;
            const cfg = await getPruneConfig(guild.id);
            const list = new Set(cfg.bypassRoleIds);
            if (remove) list.delete(role.id); else list.add(role.id);
            if (list.size > MAX_BYPASS_ROLES) return interaction.editReply({ content: `Up to ${MAX_BYPASS_ROLES} bypass roles.` });
            const out = await savePruneSettings(guild, { bypassRoleIds: [...list] }, interaction.user);
            return interaction.editReply({ content: `${remove ? 'Removed' : 'Added'} ${role}. ${bypassText(out.cfg, await systemRoleIds(guild.id))}` });
        }
        if (sub === 'inactive') {
            const o = interaction.options;
            const input = {};
            for (const [key, value] of [['neverEnabled', o.getBoolean('never')], ['neverDays', o.getInteger('never_days')],
                ['neverAction', o.getString('never_action')], ['quietEnabled', o.getBoolean('quiet')], ['quietDays', o.getInteger('quiet_days')],
                ['quietAction', o.getString('quiet_action')], ['warnDays', o.getInteger('warn_days')], ['minMemberDays', o.getInteger('min_days')],
                ['maxPerSweep', o.getInteger('per_sweep')], ['dailyCap', o.getInteger('per_day')], ['exemptBoosters', o.getBoolean('boosters_exempt')],
                ['exemptStaff', o.getBoolean('staff_exempt')]]) {
                if (value !== null && value !== undefined) input[key] = value;
            }
            const cfg = Object.keys(input).length ? await saveInactivitySettings(guild, input, interaction.user) : await getInactivityConfig(guild.id);
            return interaction.editReply({ embeds: [await inactivityEmbed(guild, cfg)] });
        }
        if (sub === 'inactive-exempt') {
            const role = interaction.options.getRole('role', true);
            const remove = interaction.options.getBoolean('remove') ?? false;
            const cfg = await getInactivityConfig(guild.id);
            const list = new Set(cfg.exemptRoleIds);
            if (remove) list.delete(role.id); else list.add(role.id);
            if (list.size > MAX_EXEMPT_ROLES) return interaction.editReply({ content: `Up to ${MAX_EXEMPT_ROLES} exempt roles.` });
            const out = await saveInactivitySettings(guild, { exemptRoleIds: [...list] }, interaction.user);
            return interaction.editReply({ content: `${remove ? 'Removed' : 'Added'} ${role}. Exempt from the inactivity rules: ${out.exemptRoleIds.length ? out.exemptRoleIds.map(id => `<@&${id}>`).join(' ') : 'no roles'}.` });
        }
        if (sub === 'inactive-preview') {
            const p = await previewInactivity(guild, { pageSize: 15 });
            const s = p.summary;
            const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
            const tag = (r) => (r.status === 'due' ? (r.action === 'kick' ? 'remove now' : 'flagged (log only)')
                : r.status === 'waiting' ? `warned, removed ${ts(r.kickAt)}`
                    : r.status === 'warn' ? 'warning next sweep' : `due ${ts(r.dueAt)}`);
            const lines = p.rows.map(r => `<@${r.user.id}> — ${r.rule === 'never' ? 'never active' : 'gone quiet'}, last active ${r.lastActiveAt ? ts(r.lastActiveAt, 'D') : 'never'} — ${tag(r)}`);
            let list = '';
            for (const l of lines) { if ((list + l).length > 950) break; list += `${l}\n`; }
            const shown = list ? list.trim().split('\n').length : 0;
            const embed = new EmbedBuilder()
                .setColor(0xE67E22)
                .setTitle(`Inactivity prune preview${p.asIfOn ? ' (rules off: shown as if on)' : ''}`)
                .setDescription([
                    p.describe,
                    `Judging from ${ts(p.trackingSinceMs || Date.now(), 'D')} (when activity tracking began); ${p.memberCount} members checked.`,
                    `**${s.due}** due now (${s.dueKick} kick, ${s.dueLog} log only) · **${s.warn}** to warn · **${s.waiting}** warned · **${s.soon}** due within 7 days`,
                    `Never active: ${s.never} · gone quiet: ${s.quiet} · exempt: ${s.exempt} · still at the gate: ${s.gate}`,
                ].join('\n'))
                .addFields({
                    name: `Members (${p.total})`,
                    value: shown ? `${list.trim()}${p.total > shown ? `\n…and ${p.total - shown} more (see the dashboard)` : ''}` : 'nobody',
                });
            return interaction.editReply({ embeds: [embed] });
        }
        if (sub === 'unqueue') {
            const user = interaction.options.getUser('user', true);
            await removeFromQueue(guild, user.id, interaction.user);
            return interaction.editReply({ content: `${user} is off the auto-prune queue and will not be removed.` });
        }
        // status
        const cfg = await getPruneConfig(guild.id);
        const queue = await pruneQueue(guild);
        const embed = new EmbedBuilder()
            .setColor(cfg.enabled ? 0x2ECC71 : 0x6B7280)
            .setTitle(`Auto-prune — ${cfg.enabled ? 'on' : 'off'}`)
            .setDescription(`${describePrune(cfg)}\n${bypassText(cfg, await systemRoleIds(guild.id))}`)
            .addFields({
                name: `Queue (${queue.length})`,
                value: queue.length
                    ? queue.slice(0, 15).map(q => `<@${q.userId}> — ${q.deadline ? `<t:${Math.floor(q.deadline / 1000)}:R>` : 'no deadline'}`).join('\n')
                        + (queue.length > 15 ? `\n…and ${queue.length - 15} more (see the dashboard)` : '')
                    : 'nobody',
            });
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        return fail(interaction, err);
    }
}

async function inactivityEmbed(guild, cfg) {
    const st = await inactivityStatus(guild);
    const r = st.lastResult;
    const exempt = [cfg.exemptStaff ? 'staff' : null, cfg.exemptBoosters ? 'boosters' : null, ...cfg.exemptRoleIds.map(id => `<@&${id}>`)].filter(Boolean);
    return new EmbedBuilder()
        .setColor(cfg.enabled ? 0x2ECC71 : 0x6B7280)
        .setTitle(`Inactivity prune — ${cfg.enabled ? 'on' : 'off'}`)
        .setDescription([
            st.describe,
            `Exempt: ${exempt.length ? exempt.join(', ') : 'nobody beyond the owner, admins and the allowlist'}`,
            `Members under ${cfg.minMemberDays} days in the server are never judged. Caps: ${cfg.maxPerSweep} per sweep, ${cfg.dailyCap} per day (${st.kickedToday} today).`,
            `Activity counted from <t:${Math.floor((st.judgedFromMs || Date.now()) / 1000)}:D>: nobody is judged on time before tracking began.`,
            r ? `Last sweep <t:${Math.floor(r.at / 1000)}:R>: ${r.kicked} removed, ${r.warned} warned, ${r.logged} logged${r.deferredKicks ? `, ${r.deferredKicks} waiting (cap)` : ''}.` : 'No sweep yet.',
            'Preview: `/systems auto-prune inactive-preview`. Everything (and Run now) is on the dashboard Verification page.',
        ].join('\n'));
}

function describePrune(cfg) {
    if (!cfg.enabled) return 'Auto-prune is **off**.';
    const what = cfg.action === 'log' ? 'logged (nobody is removed)' : `kicked${cfg.dm ? ' (with a DM)' : ''}`;
    return `Auto-prune is **on**: members who joined since it was switched on and still have no real role after **${formatMinutes(cfg.minutes)}** are ${what}.`;
}

function bypassText(cfg, systemIds) {
    const own = cfg.bypassRoleIds.length ? cfg.bypassRoleIds.map(id => `<@&${id}>`).join(' ') : 'none';
    const auto = systemIds.length ? ` · always ignored (given automatically by this bot): ${systemIds.map(id => `<@&${id}>`).join(' ')}` : '';
    return `Bypass roles (do not count as a real role): ${own}${auto}`;
}

export default { handleVerification, handleAutoPrune, peekWizardPreview, takeWizardPreview, wizardResultEmbed };
