/*
 * `/link-filter threats …` — message threats (core/message-threats.js): the obfuscated-URL "fake support"
 * scam, AutoMod escalation (+ installing the Obfuscated URL AutoMod rule, the circuit breaker), anti-everyone,
 * QR codes in images, per-server image-text rules, the ignore list for channels and categories, the card
 * channel and the flagged-member queue. Everything here is also on the dashboard's Message Threats page.
 * `nsfw-images` is the NSFW chat-image stage (core/nsfw-protection.js; its queue and the avatar side are
 * `/avatarfilter nsfw` and the dashboard's NSFW Protection page).
 *
 * A group of /link-filter rather than of /protection: /protection is at Discord's 8000-character limit for
 * one command. Every change is re-checked against the LIVE member (owner, Administrator, Manage Server or a
 * bot-manager role), as the /protection groups do.
 */
import { EmbedBuilder, ChannelType } from 'discord.js';
import mt from '../../core/message-threats.js';
import nsfw from '../../core/nsfw-protection.js';
import { liveConfigAccess, listIgnored, addIgnored, removeIgnored } from '../../core/protection-exempt.js';
import { qrDecoderAvailable } from '../../core/scam-image-ocr.js';
import { themeColor } from '../../core/guild-theme.js';

const EPHEMERAL = { flags: 64 };
const QUIET = { allowedMentions: { parse: [] } };
const reply = (interaction, content) => (interaction.deferred || interaction.replied
    ? interaction.editReply({ content, ...QUIET })
    : interaction.reply({ content, ...QUIET, ...EPHEMERAL }));
const onOff = (v) => (v ? 'on' : 'off');

/** Options present on this subcommand → a settings patch (only what was given). */
function patchFrom(interaction, map) {
    const patch = {};
    for (const [opt, col, kind] of map) {
        const v = kind === 'bool' ? interaction.options.getBoolean(opt)
            : kind === 'int' ? interaction.options.getInteger(opt)
                : kind === 'num' ? interaction.options.getNumber(opt)
                : kind === 'channel' ? interaction.options.getChannel(opt)?.id
                    : interaction.options.getString(opt);
        if (v !== null && v !== undefined) patch[col] = v;
    }
    return patch;
}

async function save(interaction, patch, what) {
    if (!Object.keys(patch).length) return status(interaction);
    const out = await mt.saveSettings(interaction.guild, patch, interaction.user.id);
    if (!out.ok) return reply(interaction, out.error);
    return reply(interaction, `${what} updated (${out.changed.map(c => c.replace(/_/g, ' ')).join(', ')}). Full controls: dashboard, Message Threats.`);
}

async function status(interaction) {
    const guild = interaction.guild;
    const { settings: s } = await mt.getSettings(guild.id);
    const [rules, ignored, counts, qr] = await Promise.all([
        mt.loadOcrRules(guild.id), listIgnored(guild.id).catch(() => []), mt.reviewCounts(guild.id).catch(() => ({})), qrDecoderAvailable(),
    ]);
    const breaker = mt.breakerState(guild.id, s);
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, breaker.trippedAt ? 'warning' : 'primary'))
        .setTitle('🛡️ Message threats')
        .addFields(
            { name: 'Obfuscated URL scam', value: `${onOff(s.obf.enabled)} · ${s.obf.action}${s.obf.action === 'timeout' ? ` ${s.obf.timeoutMinutes}m` : ''} · review alerts ${onOff(s.obf.reviewAlerts)}`, inline: false },
            { name: 'AutoMod escalation', value: `${onOff(s.escalation.enabled)} · ${s.escalation.action} · review alerts ${onOff(s.escalation.reviewAlerts)} · ${s.escalation.ruleIds.length} rule(s) enforced`, inline: false },
            { name: 'Circuit breaker', value: breaker.trippedAt ? `**TRIPPED** <t:${Math.floor(new Date(breaker.trippedAt).getTime() / 1000)}:R>: bans are flagged instead. \`/link-filter threats breaker-reset\`` : `closed · ${breaker.recentBans}/${breaker.limit} bans in the last ${breaker.windowMinutes} min`, inline: false },
            { name: 'Anti-everyone', value: `${onOff(s.everyone.enabled)} · timeout ${s.everyone.timeoutMinutes ? `${s.everyone.timeoutMinutes}m` : 'none (delete only)'} · ${s.everyone.strict ? 'strict' : 'misconfiguration'} mode · webhooks: ${s.everyone.webhooks} · ${s.everyone.allowedRoles.length} allowed role(s)`, inline: false },
            { name: 'QR codes', value: `${onOff(s.qr.enabled)} · ${s.qr.strict ? 'any QR removed' : 'bad links only'} · ${s.qr.action}${qr ? '' : ' · **decoder not installed**'}`, inline: false },
            { name: 'Image-text rules', value: `${onOff(s.ocrRules.enabled)} · ${rules.length} active rule(s)`, inline: false },
            { name: 'NSFW chat images', value: `${onOff(s.nsfw.enabled)} · ${s.nsfw.action}${s.nsfw.action === 'timeout' ? ` ${s.nsfw.timeoutMinutes}m` : ''} · act ${Math.round(s.nsfw.act * 100)}%, review ${Math.round(s.nsfw.review * 100)}% · cap ${s.nsfw.dailyCap}/day · \`/avatarfilter nsfw status\``, inline: false },
            { name: 'Ignored', value: ignored.length ? ignored.slice(0, 20).map(r => `<#${r.target_id}>${r.kind === 'category' ? ' (category)' : ''}`).join(' ') : 'nothing', inline: false },
            { name: 'Cards go to', value: s.threatChannelId ? `<#${s.threatChannelId}>` : s.alertChannelId ? `<#${s.alertChannelId}> (phishing alert channel)` : 'nowhere yet: `/link-filter threats channel`', inline: true },
            { name: 'Flagged, waiting', value: String(counts.pending ?? 0), inline: true },
        )
        .setFooter({ text: 'Everything here is on the dashboard: Message Threats' });
    return interaction.reply({ embeds: [embed], ...QUIET, ...EPHEMERAL });
}

export async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    if (sub === 'status') return status(interaction);

    const a = await liveConfigAccess(guild, interaction.user.id);
    if (!a.ok) return reply(interaction, 'You need Manage Server, Administrator or a bot-manager role to change message threat settings.');

    switch (sub) {
        case 'obfuscated':
            return save(interaction, patchFrom(interaction, [['enabled', 'obf_enabled', 'bool'], ['action', 'obf_action'],
                ['timeout-minutes', 'obf_timeout_minutes', 'int'], ['review-alerts', 'obf_review_alerts', 'bool']]), 'Obfuscated URL scam');
        case 'everyone':
            return save(interaction, patchFrom(interaction, [['enabled', 'everyone_enabled', 'bool'], ['timeout-minutes', 'everyone_timeout_minutes', 'int'],
                ['strict', 'everyone_strict', 'bool'], ['webhooks', 'everyone_webhooks']]), 'Anti-everyone');
        case 'everyone-allow': {
            const role = interaction.options.getRole('role', true);
            const remove = interaction.options.getBoolean('remove') ?? false;
            const { settings } = await mt.getSettings(guild.id);
            const ids = new Set(settings.everyone.allowedRoles);
            if (remove) ids.delete(role.id); else ids.add(role.id);
            const out = await mt.saveSettings(guild, { everyone_allowed_roles: [...ids] }, interaction.user.id);
            return reply(interaction, out.ok ? `<@&${role.id}> ${remove ? 'may no longer' : 'may'} ping @everyone without being acted on.` : out.error);
        }
        case 'qr':
            return save(interaction, patchFrom(interaction, [['enabled', 'qr_enabled', 'bool'], ['strict', 'qr_strict', 'bool'],
                ['action', 'qr_action'], ['timeout-minutes', 'qr_timeout_minutes', 'int']]), 'QR codes');
        case 'escalation':
            return save(interaction, patchFrom(interaction, [['enabled', 'esc_enabled', 'bool'], ['action', 'esc_action'],
                ['review-alerts', 'esc_review_alerts', 'bool']]), 'AutoMod escalation');
        case 'channel':
            return save(interaction, { threat_channel_id: interaction.options.getChannel('channel')?.id ?? null }, 'Card channel');
        case 'nsfw-images': {
            // Through core/nsfw-protection.js: it checks the thresholds against each other.
            const patch = patchFrom(interaction, [['enabled', 'enabled', 'bool'], ['action', 'action'], ['timeout-minutes', 'timeoutMinutes', 'int'],
                ['act-at', 'act', 'num'], ['review-at', 'review', 'num'], ['review-alerts', 'reviewAlerts', 'bool'], ['daily-cap', 'dailyCap', 'int']]);
            if (!Object.keys(patch).length) return status(interaction);
            const out = await nsfw.saveSettings(guild, 'image', patch, interaction.user.id);
            return reply(interaction, out.ok ? `NSFW chat images updated (${out.changed.map(c => c.replace(/^nsfw_img_/, '').replace(/_/g, ' ')).join(', ')}). `
                + 'Full controls and the review queue: dashboard, NSFW Protection.' : out.error);
        }
        case 'image-rules':
            return save(interaction, patchFrom(interaction, [['enabled', 'ocr_rules_enabled', 'bool'], ['timeout-minutes', 'ocr_timeout_minutes', 'int']]), 'Image-text rules');
        case 'rules': {
            await interaction.deferReply(EPHEMERAL);
            const out = await mt.listAutomodRules(guild).catch(err => ({ ok: false, error: err.message, rules: [] }));
            if (!out.ok) return reply(interaction, out.error);
            if (!out.rules.length) return reply(interaction, 'This server has no AutoMod rules. `/link-filter threats install-rule` adds the Obfuscated URL rule.');
            return reply(interaction, '**AutoMod rules** (enforced = hits are scored and escalated):\n' + out.rules.map(r =>
                `${r.enforced ? '✅' : '▫️'} **${r.name}** \`${r.id}\`${r.installed ? ' (ours)' : ''}${r.enabled ? '' : ' (disabled in Discord)'}`).join('\n')
                + '\n\n`/link-filter threats escalation-rule rule-id:<id> enforce:true` to enforce one.');
        }
        case 'escalation-rule': {
            const id = interaction.options.getString('rule-id', true).trim();
            const out = await mt.setRuleEnforced(guild, id, interaction.options.getBoolean('enforce', true), interaction.user.id);
            return reply(interaction, out.ok ? `Rule \`${id}\` is ${interaction.options.getBoolean('enforce') ? 'now enforced' : 'no longer enforced'}.` : out.error);
        }
        case 'install-rule': {
            await interaction.deferReply(EPHEMERAL);
            const out = await mt.installAutomodRule(guild, interaction.user.id);
            return reply(interaction, out.ok
                ? `${out.created ? 'Installed' : 'Updated'} the **Obfuscated URL** AutoMod rule (\`${out.ruleId}\`) and enforced it. Turn on escalation with \`/link-filter threats escalation enabled:true\`.`
                : out.error);
        }
        case 'breaker-reset':
            await mt.resetBreaker(guild, interaction.user.id);
            return reply(interaction, 'Circuit breaker reset: automatic bans from message threats are back on.');
        case 'image-rule-add': {
            const out = await mt.addOcrRule(guild, {
                type: interaction.options.getString('type', true), pattern: interaction.options.getString('pattern', true),
                action: interaction.options.getString('action') ?? 'log', reason: interaction.options.getString('reason'),
            }, interaction.user.id);
            return reply(interaction, out.ok ? `Image-text rule #${out.id} added. Rules only run while \`/link-filter threats image-rules enabled:true\` is on.` : out.error);
        }
        case 'image-rule-remove': {
            const ok = await mt.removeOcrRule(guild, interaction.options.getInteger('id', true), interaction.user.id);
            return reply(interaction, ok ? 'Rule removed.' : 'No such image-text rule here.');
        }
        case 'image-rule-list': {
            const rows = await mt.listOcrRules(guild.id);
            return reply(interaction, rows.length
                ? '**Image-text rules**\n' + rows.slice(0, 40).map(r => `#${r.id} ${r.enabled ? '' : '(off) '}${r.pattern_type}: \`${String(r.pattern).slice(0, 80)}\` → ${r.action}${r.hits ? ` · ${r.hits} hit(s)` : ''}`).join('\n')
                : 'No image-text rules yet. `/link-filter threats image-rule-add`.');
        }
        case 'ignore': {
            const channel = interaction.options.getChannel('channel');
            const remove = interaction.options.getBoolean('remove') ?? false;
            if (!channel) {
                const rows = await listIgnored(guild.id);
                return reply(interaction, rows.length
                    ? '**Ignored by message protections**\n' + rows.map(r => `<#${r.target_id}>${r.kind === 'category' ? ' (category, includes channels made later)' : ''}`).join('\n')
                    : 'Nothing is ignored. Add a channel or a category with `/link-filter threats ignore channel:`.');
            }
            const kind = channel.type === ChannelType.GuildCategory ? 'category' : 'channel';
            if (remove) {
                const ok = await removeIgnored(guild, kind, channel.id, interaction.user.id);
                return reply(interaction, ok ? `<#${channel.id}> is checked again.` : `<#${channel.id}> was not ignored.`);
            }
            const out = await addIgnored(guild, kind, channel.id, interaction.user.id);
            return reply(interaction, out.ok
                ? `<#${channel.id}> ${kind === 'category' ? '(and every channel in it, including new ones)' : ''} is now ignored by phishing, link, invite, image and message-threat checks.`
                : out.error);
        }
        case 'flagged': {
            const rows = await mt.listReviews(guild.id, { status: 'pending', limit: 25 });
            return reply(interaction, rows.length
                ? '**Flagged, waiting for a decision** (use the card buttons or the dashboard)\n' + rows.map(r =>
                    `<@${r.user_id}> · ${r.filter_label} · <t:${Math.floor(new Date(r.found_at).getTime() / 1000)}:R>${r.detail ? ` · ${String(r.detail).slice(0, 80)}` : ''}`).join('\n')
                : 'Nobody is waiting for review.');
        }
        default:
            return reply(interaction, 'Unknown subcommand.');
    }
}

export default { execute };
