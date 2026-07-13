/*
 * /takeover — migrate a server off its third-party bots, one channel at a time.
 *
 * `plan` is read-only and safe to run at any moment. `apply` writes config rows only; it
 * never posts, edits or deletes a message in any channel, and it refuses to run without a
 * fresh plan confirmed by a button.
 */
import {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { plan, apply, detectBots } from '../../core/takeover-manager.js';
import { isSuperAdmin } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const COLOR = 0xF2A65A;
const PLAN_TTL_MS = 10 * 60 * 1000;

// messageId -> { plan, userId, guildId, timer }. A plan must be applied from its own
// message, so nobody can approve a plan they never saw.
const pending = new Map();

function stash(messageId, entry) {
  const timer = setTimeout(() => pending.delete(messageId), PLAN_TTL_MS);
  if (timer.unref) timer.unref();
  pending.set(messageId, { ...entry, timer });
}

function renderPlan(p) {
  const embed = new EmbedBuilder().setColor(COLOR)
    .setTitle(`Takeover plan — ${p.guildName}`)
    .setDescription(
      `Found **${p.bots.length}** known bot(s) here. Nothing below posts, edits or deletes ` +
      'any message — takeover only writes configuration.');

  const line = s => {
    const icon = s.done ? '✅' : s.blocked ? '⛔' : '▫️';
    const replaces = s.replaces ? ` *(replaces ${s.replaces})*` : '';
    const detail = s.blocked ? `\n   ⛔ ${s.blocked}` : (s.note ? `\n   ↳ ${s.note}` : '');
    const target = s.channelName && s.channelName !== '—' ? ` → #${s.channelName}` : '';
    const extra = s.key === 'counting' && !s.blocked
      ? `\n   ↳ resumes at **${s.lastNumber + 1}**, ${s.failMode === 'delete' ? 'wrong numbers deleted, never resets' : 'resets on a wrong number'}` +
        `${s.deleteChatter ? ', chatter deleted' : ''}`
      : '';
    return `${icon} **${s.label}**${target}${replaces}${extra}${detail}`;
  };

  if (p.steps.length) {
    // Discord caps a field at 1024 chars; split rather than truncate silently.
    const chunks = [];
    let buf = '';
    for (const s of p.steps) {
      const t = line(s) + '\n';
      if (buf.length + t.length > 1000) { chunks.push(buf); buf = ''; }
      buf += t;
    }
    if (buf) chunks.push(buf);
    chunks.forEach((c, i) => embed.addFields({ name: i ? '​' : 'Steps', value: c }));
  } else {
    embed.addFields({ name: 'Steps', value: 'Nothing to do.' });
  }

  if (p.unreplaceable.length) {
    embed.addFields({
      name: '⚠️ Cannot be replaced — keep these bots',
      value: p.unreplaceable.map(b => `• **${b.name}** — ${b.why}`).join('\n').slice(0, 1024),
    });
  }

  const redundant = p.bots.filter(b => b.feature && p.steps.some(s => s.replaces === b.name && (s.done || !s.blocked)));
  if (redundant.length) {
    embed.addFields({
      name: 'Safe to remove once applied (kick them yourself)',
      value: redundant.map(b => `• ${b.name} \`${b.id}\``).join('\n').slice(0, 1024),
    });
  }

  embed.setFooter({ text: `${p.actionable.length} step(s) ready to apply · plan expires in 10 minutes` });
  return embed;
}

export default {
  category: 'admin',
  data: new SlashCommandBuilder()
    .setName('takeover')
    .setDescription('[Owner] Migrate this server off its third-party bots')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('plan').setDescription('Show exactly what a takeover would change. Changes nothing.')
      .addChannelOption(o => o.setName('counting-channel').setDescription('Override the detected counting channel'))
      .addChannelOption(o => o.setName('cat-channel').setDescription('Where Cat Bot should spawn cats'))
      .addStringOption(o => o.setName('on-wrong-number').setDescription('Counting: what happens on a wrong number')
        .addChoices(
          { name: 'Delete it, never reset (infinite attempts)', value: 'delete' },
          { name: 'Reset the count to 0', value: 'reset' }))
      .addBooleanOption(o => o.setName('react-on-valid').setDescription('Counting: react ✅ on every valid count'))
      .addBooleanOption(o => o.setName('announce-milestones').setDescription('Counting: announce milestones'))
      .addBooleanOption(o => o.setName('delete-chatter').setDescription('Counting: delete non-numeric messages too')))
    .addSubcommand(s => s.setName('bots').setDescription('List the known bots present in this server')),

  async execute(interaction) {
    if (!interaction.guild) return interaction.reply({ content: 'Servers only.', ...EPHEMERAL });
    // Takeover rewires a whole guild. Owner-only, not merely Administrator.
    if (!isSuperAdmin(interaction.user.id) && interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ content: 'Only the server owner can run a takeover.', ...EPHEMERAL });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'bots') {
      await interaction.deferReply(EPHEMERAL);
      const bots = await detectBots(interaction.guild);
      if (!bots.length) return interaction.editReply('No known third-party bots detected here.');
      const embed = new EmbedBuilder().setColor(COLOR).setTitle('Known bots in this server')
        .setDescription(bots.map(b => b.feature
          ? `✅ **${b.name}** — we cover this (\`${b.feature}\`)`
          : `⚠️ **${b.name}** — ${b.why}`).join('\n').slice(0, 4000));
      return interaction.editReply({ embeds: [embed] });
    }

    // plan
    await interaction.deferReply(EPHEMERAL);
    const opts = {
      countingChannel: interaction.options.getChannel('counting-channel') ?? undefined,
      catChannel: interaction.options.getChannel('cat-channel') ?? undefined,
      failMode: interaction.options.getString('on-wrong-number') ?? 'delete',
      reactOnValid: interaction.options.getBoolean('react-on-valid') ?? false,
      announceMilestones: interaction.options.getBoolean('announce-milestones') ?? false,
      deleteChatter: interaction.options.getBoolean('delete-chatter') ?? true,
      allowSameUser: false,
    };

    let p;
    try {
      p = await plan(interaction.guild, opts);
    } catch (err) {
      logger.error(`[Takeover] plan failed: ${err.message}`, { stack: err.stack });
      return interaction.editReply(`Could not build a plan: ${err.message}`);
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tko:apply').setLabel(`Apply ${p.actionable.length} step(s)`)
        .setStyle(ButtonStyle.Danger).setDisabled(!p.actionable.length),
      new ButtonBuilder().setCustomId('tko:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    await interaction.editReply({ embeds: [renderPlan(p)], components: [row] });
    const msg = await interaction.fetchReply().catch(() => null);
    if (msg?.id) stash(msg.id, { plan: p, userId: interaction.user.id, guildId: interaction.guildId });
  },
};

/** Button handler: `tko:apply` / `tko:cancel`. Registered in interactions/handlerRegistry.js. */
export async function handleTakeoverButton(interaction) {
  const entry = pending.get(interaction.message.id);
  if (!entry) {
    return interaction.reply({ content: 'That plan has expired. Run `/takeover plan` again.', ...EPHEMERAL });
  }
  if (entry.userId !== interaction.user.id) {
    return interaction.reply({ content: 'That is not your plan.', ...EPHEMERAL });
  }

  const [, action] = interaction.customId.split(':');
  pending.delete(interaction.message.id);

  if (action === 'cancel') {
    return interaction.update({ content: 'Takeover cancelled. Nothing was changed.', embeds: [], components: [] });
  }

  await interaction.deferUpdate().catch(() => {});
  let results;
  try {
    results = await apply(interaction.guild, entry.plan);
  } catch (err) {
    logger.error(`[Takeover] apply failed: ${err.message}`, { stack: err.stack });
    return interaction.editReply({ content: `Takeover failed: ${err.message}`, embeds: [], components: [] });
  }

  const icon = { applied: '✅', 'already-done': '⏭️', blocked: '⛔', failed: '❌' };
  const body = results.map(r => `${icon[r.outcome]} **${r.label}**${r.error ? ` — ${r.error}` : ''}`).join('\n')
    || 'Nothing to do.';
  const applied = results.filter(r => r.outcome === 'applied').length;

  const embed = new EmbedBuilder().setColor(applied ? 0x57F287 : COLOR)
    .setTitle('Takeover applied')
    .setDescription(body.slice(0, 4000))
    .setFooter({ text: `${applied} step(s) applied · no messages were posted or deleted` });

  await interaction.editReply({ embeds: [embed], components: [] });

  const redundant = entry.plan.bots.filter(b => b.feature && results.some(r => r.replaces === b.name && r.outcome === 'applied'));
  if (redundant.length) {
    await interaction.followUp({
      content: '**Now safe to remove:** ' + redundant.map(b => `${b.name} (\`${b.id}\`)`).join(', ') +
        '\nKick them yourself when you have verified ours is behaving.',
      ...EPHEMERAL,
    }).catch(() => {});
  }
}
