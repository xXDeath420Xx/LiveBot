/*
 * /kofi — Ko-fi supporter roles.
 *
 * Setup is two secrets: the webhook URL we hand out (contains an unguessable token) and the
 * verification token Ko-fi shows on its webhook page. Both are treated as secrets, so the
 * URL is only ever shown ephemerally.
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
  setup, getConfig, getTiers, addTier, removeTier, issueCode, unlink,
  getSupporter, listSupporters, DEFAULT_DURATION_DAYS,
} from '../../core/kofi-manager.js';
import pool from '../../utils/db.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const COLOR = 0xFF5E5B; // Ko-fi red

const publicUrl = () =>
  (process.env.DASHBOARD_URL || process.env.PUBLIC_URL || 'https://your-dashboard').replace(/\/+$/, '');

export default {
  category: 'community',
  data: new SlashCommandBuilder()
    .setName('kofi')
    .setDescription('Ko-fi supporter roles and donation announcements')
    .addSubcommand(s => s.setName('setup').setDescription('[Admin] Connect this server to your Ko-fi webhook')
      .addStringOption(o => o.setName('verification-token').setDescription("The token from Ko-fi's webhook settings page").setRequired(true))
      .addChannelOption(o => o.setName('announce-channel').setDescription('Where to thank supporters'))
      .addIntegerOption(o => o.setName('duration-days').setDescription(`How long a perk lasts (default ${DEFAULT_DURATION_DAYS})`).setMinValue(1).setMaxValue(365)))
    .addSubcommand(s => s.setName('url').setDescription('[Admin] Show the webhook URL to paste into Ko-fi'))
    .addSubcommand(s => s.setName('tier').setDescription('[Admin] Map a Ko-fi tier or amount to a role')
      .addRoleOption(o => o.setName('role').setDescription('Role to grant').setRequired(true))
      .addStringOption(o => o.setName('tier-name').setDescription('Exact Ko-fi membership tier name (e.g. Gold)'))
      .addNumberOption(o => o.setName('min-amount').setDescription('…or the minimum donation that earns it').setMinValue(0)))
    .addSubcommand(s => s.setName('untier').setDescription('[Admin] Stop granting a role')
      .addRoleOption(o => o.setName('role').setDescription('Role to unmap').setRequired(true)))
    .addSubcommand(s => s.setName('tiers').setDescription('Show the tier → role mapping'))
    .addSubcommand(s => s.setName('link').setDescription('Link your Ko-fi account so you get your role'))
    .addSubcommand(s => s.setName('unlink').setDescription('Unlink your Ko-fi account'))
    .addSubcommand(s => s.setName('status').setDescription('Your supporter status')
      .addUserOption(o => o.setName('user').setDescription('Someone else (admins only)')))
    .addSubcommand(s => s.setName('supporters').setDescription('Top supporters in this server'))
    .addSubcommand(s => s.setName('disable').setDescription('[Admin] Stop processing Ko-fi webhooks here')),

  async execute(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: 'Ko-fi only works in servers.', ...EPHEMERAL });

    const sub = interaction.options.getSubcommand();
    const isAdmin = () => interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const needAdmin = () => interaction.reply({ content: 'You need **Manage Server** for that.', ...EPHEMERAL });

    if (sub === 'setup') {
      if (!isAdmin()) return needAdmin();
      const config = await setup(guildId, {
        verificationToken: interaction.options.getString('verification-token'),
        announceChannelId: interaction.options.getChannel('announce-channel')?.id,
        durationDays: interaction.options.getInteger('duration-days') ?? DEFAULT_DURATION_DAYS,
      });

      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle('☕ Ko-fi connected')
          .setDescription(
            'Paste this into **Ko-fi → Settings → API → Webhook URL**:\n' +
            `\`\`\`${publicUrl()}/webhooks/kofi/${config.webhook_token}\`\`\`\n` +
            '**Treat that URL as a password** — anyone with it can post payments to this server.')
          .addFields(
            { name: 'Next', value: 'Map a role with `/kofi tier`, then tell supporters to run `/kofi link`.' },
            { name: 'Perk length', value: `${config.role_duration_days} days, extended on every renewal`, inline: true })],
        ...EPHEMERAL,
      });
    }

    if (sub === 'url') {
      if (!isAdmin()) return needAdmin();
      const config = await getConfig(guildId);
      if (!config) return interaction.reply({ content: 'Run `/kofi setup` first.', ...EPHEMERAL });
      return interaction.reply({
        content: `Webhook URL (keep it secret):\n\`\`\`${publicUrl()}/webhooks/kofi/${config.webhook_token}\`\`\``,
        ...EPHEMERAL,
      });
    }

    if (sub === 'tier') {
      if (!isAdmin()) return needAdmin();
      const role = interaction.options.getRole('role');
      const tierName = interaction.options.getString('tier-name');
      const minAmount = interaction.options.getNumber('min-amount');

      if (!tierName && (minAmount === null || minAmount <= 0)) {
        return interaction.reply({ content: 'Give me a `tier-name` or a `min-amount` above 0.', ...EPHEMERAL });
      }
      // We must be able to hand the role out.
      const me = interaction.guild.members.me;
      if (role.managed) return interaction.reply({ content: `**${role.name}** is managed by an integration and cannot be assigned.`, ...EPHEMERAL });
      if (role.position >= me.roles.highest.position) {
        return interaction.reply({ content: `**${role.name}** sits above my highest role — move mine up, or I can never grant it.`, ...EPHEMERAL });
      }

      await addTier(guildId, { roleId: role.id, tierName, minAmount: minAmount ?? 0 });
      return interaction.reply({
        content: tierName
          ? `✅ Ko-fi tier **${tierName}** now grants ${role}.`
          : `✅ Donations of **${minAmount.toFixed(2)}** or more now grant ${role}.`,
        ...EPHEMERAL,
      });
    }

    if (sub === 'untier') {
      if (!isAdmin()) return needAdmin();
      const role = interaction.options.getRole('role');
      const gone = await removeTier(guildId, role.id);
      return interaction.reply({ content: gone ? `Removed the mapping for ${role}.` : `${role} was not mapped.`, ...EPHEMERAL });
    }

    if (sub === 'tiers') {
      const tiers = await getTiers(guildId);
      if (!tiers.length) return interaction.reply({ content: 'No tiers mapped yet. `/kofi tier` sets one up.', ...EPHEMERAL });
      const body = tiers.map(t => t.tier_name
        ? `• Tier **${t.tier_name}** → <@&${t.role_id}>`
        : `• **${Number(t.min_amount).toFixed(2)}+** → <@&${t.role_id}>`).join('\n');
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle('☕ Ko-fi tiers').setDescription(body)],
        allowedMentions: { parse: [] },
        ...EPHEMERAL,
      });
    }

    if (sub === 'link') {
      const config = await getConfig(guildId);
      if (!config?.enabled) return interaction.reply({ content: 'Ko-fi is not set up in this server.', ...EPHEMERAL });
      const code = await issueCode(guildId, interaction.user.id);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle('☕ Link your Ko-fi')
          .setDescription(
            `Put this code in the **message** field of your next Ko-fi payment:\n\n# \`${code}\`\n\n` +
            'You only need to do this once. After that every renewal is matched automatically, ' +
            'because Ko-fi sends us the same email each time.')
          .setFooter({ text: 'Already donated? Send any amount with the code, or ask an admin to link you.' })],
        ...EPHEMERAL,
      });
    }

    if (sub === 'unlink') {
      const gone = await unlink(guildId, interaction.user.id);
      return interaction.reply({
        content: gone ? 'Unlinked. Your role stays until it expires.' : 'You had no Ko-fi account linked here.',
        ...EPHEMERAL,
      });
    }

    if (sub === 'status') {
      const target = interaction.options.getUser('user');
      if (target && target.id !== interaction.user.id && !isAdmin()) return needAdmin();
      const who = target || interaction.user;

      const s = await getSupporter(guildId, who.id);
      if (!s) {
        return interaction.reply({
          content: who.id === interaction.user.id
            ? 'You have no Ko-fi support recorded here. Run `/kofi link` to connect your account.'
            : `**${who.username}** has no Ko-fi support recorded here.`,
          ...EPHEMERAL,
        });
      }
      const expires = s.expires_at ? `<t:${Math.floor(new Date(s.expires_at).getTime() / 1000)}:R>` : '—';
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle(`☕ ${who.username}'s Ko-fi support`)
          .addFields(
            { name: 'Tier', value: s.tier_name || '—', inline: true },
            { name: 'Role', value: s.role_id ? `<@&${s.role_id}>` : '—', inline: true },
            { name: 'Lifetime', value: `${s.currency || ''} ${Number(s.lifetime_amount).toFixed(2)}`.trim(), inline: true },
            { name: 'Recurring', value: s.is_subscription ? 'Yes' : 'No', inline: true },
            { name: 'Expires', value: expires, inline: true })],
        allowedMentions: { parse: [] },
        ...EPHEMERAL,
      });
    }

    if (sub === 'supporters') {
      const rows = await listSupporters(guildId, 15);
      if (!rows.length) return interaction.reply({ content: 'No supporters yet.', ...EPHEMERAL });
      const medal = i => ['🥇', '🥈', '🥉'][i] || `\`${String(i + 1).padStart(2)}\``;
      const body = rows.map((r, i) =>
        `${medal(i)} ${r.user_id ? `<@${r.user_id}>` : (r.from_name || 'Anonymous')} — ` +
        `${r.currency || ''} ${Number(r.lifetime_amount).toFixed(2)}`.trim() +
        (r.tier_name ? ` · ${r.tier_name}` : '')).join('\n');
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle('☕ Top supporters').setDescription(body)],
        allowedMentions: { parse: [] },
      });
    }

    if (sub === 'disable') {
      if (!isAdmin()) return needAdmin();
      await pool.execute('UPDATE kofi_config SET enabled = 0 WHERE guild_id = ?', [guildId]);
      return interaction.reply({ content: 'Ko-fi webhooks are now ignored here. Roles already granted stay.', ...EPHEMERAL });
    }
  },
};
