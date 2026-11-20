/*
 * `/protection allowlist | managers | pause | resume | status` — the controls every protection shares
 * (core/protection-exempt.js): who is exempt, which roles may configure the bot, and the pause switch.
 *
 * Discord shows /protection only to Administrators by default (default_member_permissions), and a bot
 * cannot grant a slash command to a role itself. A server that wants its bot-manager roles to use
 * these commands allows /protection for that role in Server Settings → Integrations; the dashboard's
 * Protection Settings page works for managers with no setup. Either way every change is re-checked
 * here against the LIVE member: allowlist and pause need configure access (owner, Administrator,
 * Manage Server or a manager role); manager roles can only be changed by the owner or an Administrator.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
    listAllowlist, listSeen, addAllow, removeAllow, listManagers, addManager, removeManager,
    pause, resume, getPause, liveConfigAccess, protectionsOverview,
} from '../../../core/protection-exempt.js';
import { parseDuration, formatDuration, canEditManagers } from '../../../core/protection-exempt-logic.js';
import { themeColor } from '../../../core/guild-theme.js';

const EPHEMERAL = { flags: 64 };
const QUIET = { allowedMentions: { parse: [] } };
const ts = (d) => Math.floor(new Date(d).getTime() / 1000);

const reply = (interaction, content) => interaction.reply({ content, ...QUIET, ...EPHEMERAL });

/** Build a one-button row that deep-links to the Protection Settings page for this guild. Returns
 *  null when DASHBOARD_URL is unset — the reply still works without the button. */
function dashboardButton(guildId, label = 'Manage on Dashboard') {
    const base = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
    if (!base) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link)
            .setURL(`${base}/manage/${encodeURIComponent(guildId)}?page=protection#managers`),
    );
}

async function access(interaction) {
    return liveConfigAccess(interaction.guild, interaction.user.id);
}

/** One line per protection that is switched on, for status. */
function describeProtections(p) {
    const on = [];
    if (p.joinGate) {
        if (p.joinGate.ageGate) on.push('account-age join gate');
        if (p.joinGate.rejoinLimit) on.push('rejoin limit');
        if (p.joinGate.spammer) on.push('spammer check');
    }
    for (const [key, label] of [['antiNuke', 'anti-nuke'], ['raid', 'raid detection'], ['selfbot', 'self-bot detection'],
        ['adaptiveSpam', 'adaptive spam'], ['phishing', 'phishing'], ['globalBan', 'global ban'],
        ['commissionFilter', 'commission filter'], ['linkPolicy', 'link policy'], ['messageThreats', 'message threats']]) {
        if (p[key]?.on) on.push(p[key].action ? `${label} (${p[key].action})` : label);
    }
    return on.length ? on.join(', ') : 'none switched on';
}

export async function status(interaction) {
    const guild = interaction.guild;
    const [allow, seen, managers, paused, overview] = await Promise.all([
        listAllowlist(guild.id), listSeen(guild.id), listManagers(guild.id), getPause(guild.id), protectionsOverview(guild.id)]);
    const users = allow.filter(r => r.kind === 'user');
    const roles = allow.filter(r => r.kind === 'role');
    const other = overview.otherLists;
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, paused.paused ? 'warning' : 'primary'))
        .setTitle(paused.paused ? '⏸️ Protections are PAUSED' : '🛡️ Protection overview')
        .setDescription(paused.paused
            ? `Protections are detecting and logging but taking no action${paused.until ? ` until <t:${ts(paused.until)}:f> (<t:${ts(paused.until)}:R>)` : ' until resumed'}.`
              + `${paused.by ? ` Paused by <@${paused.by}>` : ''}${paused.reason ? `: ${paused.reason}` : '.'}`
            : 'Protections are acting normally.')
        .addFields(
            { name: 'Switched on', value: describeProtections(overview.protections).slice(0, 1024) },
            { name: `Allowlisted users (${users.length})`, value: users.slice(0, 15).map(r => `<@${r.target_id}>`).join(' ') || 'None', inline: false },
            { name: `Allowlisted roles (${roles.length})`, value: roles.slice(0, 15).map(r => `<@&${r.target_id}>`).join(' ') || 'None', inline: false },
            { name: 'Once held an allowlisted role', value: seen.length ? `${seen.length} member(s), \`/protection allowlist list\`` : 'None', inline: true },
            { name: `Bot-manager roles (${managers.length})`, value: managers.map(r => `<@&${r.target_id}>`).join(' ') || 'None', inline: true },
            { name: 'Also always exempt', value: 'Bots and the server owner (anti-nuke still watches bots)', inline: false },
            { name: 'Feature-specific lists (kept separate)', inline: false, value: [
                `Anti-nuke trusted users: ${other.antiNukeTrusted ?? 0}`,
                `Invite-link allowed users/roles/channels: ${other.inviteLinkAllowed ?? 0}`,
                `Self-bot exempt roles: ${other.selfbotExemptRoles?.length ?? 0}`,
                `Global-ban exempt roles: ${other.globalBanExemptRoles?.length ?? 0}`,
                `Global ban appeals accepted here: ${other.globalBanAppealsAllowed ?? 0}`,
                `Commission-filter rulings: ${other.commissionRulings ?? 0}`,
            ].join('\n') },
        )
        .setFooter({ text: 'Manage it all on the dashboard: Protection Settings' });
    return interaction.reply({ embeds: [embed], ...QUIET, ...EPHEMERAL });
}

async function allowlistCmd(interaction, sub) {
    const guild = interaction.guild;
    if (sub === 'list') {
        const [allow, seen] = await Promise.all([listAllowlist(guild.id), listSeen(guild.id)]);
        const lines = allow.slice(0, 40).map(r => `${r.kind === 'role' ? `<@&${r.target_id}>` : `<@${r.target_id}>`}`
            + ` · ${r.added_by ? `<@${r.added_by}>` : 'staff'} <t:${ts(r.added_at)}:R>${r.note ? ` · ${r.note}` : ''}`);
        const held = seen.slice(0, 20).map(r => `<@${r.target_id}> (held <@&${r.via_role_id}>)`);
        return reply(interaction, (lines.length
            ? `**Protection allowlist** (${allow.length}): every automatic protection leaves these alone.\n${lines.join('\n')}`
            : 'The allowlist is empty. `/protection allowlist add` adds a user or role.')
            + (held.length ? `\n\n**Once held an allowlisted role** (${seen.length}), still exempt:\n${held.join('\n')}` : ''));
    }

    const a = await access(interaction);
    if (!a.ok) return reply(interaction, 'You need Manage Server, Administrator or a bot-manager role to change the allowlist.');
    const user = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');
    if (!user && !role) return reply(interaction, 'Pick a `user` or a `role`.');
    if (role && role.id === guild.id) return reply(interaction, 'Allowlisting @everyone would switch every protection off. Use `/protection pause` for that.');

    const done = [];
    for (const [kind, target] of [['user', user], ['role', role]]) {
        if (!target) continue;
        const label = kind === 'role' ? `<@&${target.id}>` : `<@${target.id}>`;
        if (sub === 'add') {
            const out = await addAllow(guild, kind, target.id, interaction.user.id, interaction.options.getString('note'));
            done.push(out.ok ? `${label} is allowlisted: no automatic protection will act on ${kind === 'role' ? 'anyone holding it' : 'them'}.` : out.error);
        } else {
            const out = await removeAllow(guild, kind, target.id, interaction.user.id);
            done.push(!out.ok ? out.error : out.removed ? `${label} is off the allowlist.` : `${label} was not on the allowlist.`);
        }
    }
    return reply(interaction, done.join('\n'));
}

async function managersCmd(interaction, sub) {
    const guild = interaction.guild;
    if (sub === 'list') {
        const rows = await listManagers(guild.id);
        const content = rows.length
            ? `**Bot-manager roles** (${rows.length}): holders can configure the bot and its dashboard without Manage Server, and are exempt from automatic protections.\n`
              + rows.map(r => `<@&${r.target_id}> · added by ${r.added_by ? `<@${r.added_by}>` : 'staff'} <t:${ts(r.added_at)}:R>`).join('\n')
            : 'No bot-manager roles. `/protection managers add` makes one (owner or Administrator only).';
        const row = dashboardButton(guild.id);
        return interaction.reply({ content, ...QUIET, ...EPHEMERAL, ...(row ? { components: [row] } : {}) });
    }
    const a = await access(interaction);
    if (!canEditManagers({ isOwner: a.isOwner, isAdmin: a.isAdmin })) {
        return reply(interaction, 'Only the server owner or an Administrator can change bot-manager roles.');
    }
    const role = interaction.options.getRole('role', true);
    if (role.id === guild.id) return reply(interaction, '@everyone cannot be a bot-manager role.');
    if (role.managed) return reply(interaction, "That role belongs to an integration and can't be a bot-manager role.");
    if (sub === 'add') {
        const out = await addManager(guild, role.id, interaction.user.id);
        return reply(interaction, out.ok
            ? `${role} is a bot-manager role. Its holders can open this server on the dashboard and are exempt from automatic protections. `
              + 'To let them use `/protection` too, allow the command for the role in Server Settings → Integrations.'
            : out.error);
    }
    const removed = await removeManager(guild, role.id, interaction.user.id);
    return reply(interaction, removed ? `${role} is no longer a bot-manager role.` : `${role} was not a bot-manager role.`);
}

async function pauseCmd(interaction) {
    const a = await access(interaction);
    if (!a.ok) return reply(interaction, 'You need Manage Server, Administrator or a bot-manager role to pause protections.');
    const d = parseDuration(interaction.options.getString('duration'));
    if (!d.ok) return reply(interaction, d.error);
    const untilMs = d.ms ? Date.now() + d.ms : null;
    await pause(interaction.guild, { untilMs, by: interaction.user.id, reason: interaction.options.getString('reason') });
    return reply(interaction, `⏸️ Protections are paused${untilMs ? ` for ${formatDuration(d.ms)}, until <t:${Math.floor(untilMs / 1000)}:f>` : ' until `/protection resume`'}. `
        + 'They keep detecting and logging ("would have banned …") but take no action: no bans, kicks, timeouts, role changes or message removals.');
}

async function resumeCmd(interaction) {
    const a = await access(interaction);
    if (!a.ok) return reply(interaction, 'You need Manage Server, Administrator or a bot-manager role to resume protections.');
    const was = await resume(interaction.guild, interaction.user.id);
    return reply(interaction, was ? '▶️ Protections are acting again.' : 'Protections were not paused.');
}

export async function execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (group === 'allowlist') return allowlistCmd(interaction, sub);
    if (group === 'managers') return managersCmd(interaction, sub);
    if (sub === 'pause') return pauseCmd(interaction);
    if (sub === 'resume') return resumeCmd(interaction);
    if (sub === 'status') return status(interaction);
    return reply(interaction, 'Unknown subcommand.');
}

export default { execute };
