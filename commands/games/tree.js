/*
 * Grow a Tree — one tree per server, grown a foot at a time by whoever presses 💧.
 * Reimplemented from ssMMiles/grow-a-tree-discord (MIT); sprites are our own.
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
  plantTree, getTree, renameTree, removeTree, getPlayer, setNotifyXp,
  getGardeners, getContribution, getForest, getForestRank, getTopPlayers, NAME_RE, MAX_PLANT_HEIGHT,
} from '../../core/growtree/manager.js';
import { buildTreeMessage } from '../../core/growtree/display.js';
import { getNextLevelRequiredXp, getTreeHeight } from '../../core/growtree/formulas.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const GREEN = 0x3E8E41;
const medal = i => ['🥇', '🥈', '🥉'][i] || `\`${String(i + 1).padStart(2)}\``;

export default {
  category: 'games',
  data: new SlashCommandBuilder()
    .setName('tree')
    .setDescription('Grow a tree together — press 💧 to water it')
    .addSubcommand(s => s.setName('plant').setDescription('[Admin] Plant this server\'s tree')
      .addStringOption(o => o.setName('name').setDescription('Name your tree').setRequired(true).setMaxLength(36))
      .addIntegerOption(o => o.setName('height')
        .setDescription('Carry a tree over at this height in ft (default: a 3ft sapling)')
        .setMinValue(3).setMaxValue(10000))
      .addUserOption(o => o.setName('last-watered-by')
        .setDescription('Who watered it last — they must wait for someone else, as before')))
    .addSubcommand(s => s.setName('show').setDescription('Show the tree and its water button'))
    .addSubcommand(s => s.setName('rename').setDescription('[Admin] Rename the tree')
      .addStringOption(o => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(36)))
    .addSubcommand(s => s.setName('chop').setDescription('[Admin] Remove the tree permanently'))
    .addSubcommand(s => s.setName('gardeners').setDescription('Who waters this tree the most')
      .addIntegerOption(o => o.setName('page').setDescription('Page').setMinValue(1).setMaxValue(10)))
    .addSubcommand(s => s.setName('forest').setDescription('The tallest trees across every server')
      .addIntegerOption(o => o.setName('page').setDescription('Page').setMinValue(1).setMaxValue(10)))
    .addSubcommand(s => s.setName('levels').setDescription('Global player levels')
      .addIntegerOption(o => o.setName('page').setDescription('Page').setMinValue(1).setMaxValue(10)))
    .addSubcommand(s => s.setName('profile').setDescription('Your level and contribution')
      .addUserOption(o => o.setName('user').setDescription('Someone else')))
    .addSubcommand(s => s.setName('xp-messages').setDescription('Toggle your "+N XP" messages')
      .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: 'Trees only grow in servers.', ...EPHEMERAL });

    const isAdmin = () => interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const needAdmin = () => interaction.reply({ content: 'You need **Manage Server** for that.', ...EPHEMERAL });

    if (sub === 'plant') {
      if (!isAdmin()) return needAdmin();
      const name = interaction.options.getString('name').trim();
      if (!NAME_RE.test(name)) {
        return interaction.reply({ content: 'Names may use letters, numbers, spaces, `-` and `\'` (max 36).', ...EPHEMERAL });
      }
      const height = interaction.options.getInteger('height');
      const lastWateredBy = interaction.options.getUser('last-watered-by');

      const res = await plantTree(guildId, interaction.user.id, name, Math.random, {
        height,
        lastWateredBy: lastWateredBy?.id ?? null,
      });
      if (!res.ok) {
        if (res.reason === 'exists') return interaction.reply({ content: `**${res.tree?.name ?? 'A tree'}** is already growing here.`, ...EPHEMERAL });
        if (res.reason === 'height') return interaction.reply({ content: `Height must be between 3 and ${MAX_PLANT_HEIGHT} ft.`, ...EPHEMERAL });
        return interaction.reply({ content: 'That name isn\'t allowed.', ...EPHEMERAL });
      }
      await interaction.deferReply();
      const payload = await buildTreeMessage(res.tree, interaction.guild);
      const intro = height
        ? `🌳 **${name}** picks up where it left off, at **${res.tree.size}ft**.`
        : `🌱 **${name}** has been planted! Everyone press 💧 — but you can't water twice in a row.`;
      return interaction.editReply({ content: intro, ...payload });
    }

    if (sub === 'show') {
      const tree = await getTree(guildId);
      if (!tree) return interaction.reply({ content: 'No tree here yet. An admin can plant one with `/tree plant`.', ...EPHEMERAL });
      await interaction.deferReply();
      const payload = await buildTreeMessage(tree, interaction.guild);
      return interaction.editReply(payload);
    }

    if (sub === 'rename') {
      if (!isAdmin()) return needAdmin();
      const name = interaction.options.getString('name').trim();
      const res = await renameTree(guildId, name);
      return interaction.reply({
        content: res.ok ? `🌳 Renamed to **${name}**.` : 'No tree here, or that name isn\'t allowed.',
        ...EPHEMERAL,
      });
    }

    if (sub === 'chop') {
      if (!isAdmin()) return needAdmin();
      const gone = await removeTree(guildId);
      return interaction.reply({
        content: gone ? '🪓 The tree is gone, along with its contributor history.' : 'There was no tree here.',
        ...EPHEMERAL,
      });
    }

    if (sub === 'gardeners') {
      const page = interaction.options.getInteger('page') || 1;
      const rows = await getGardeners(guildId, 10, (page - 1) * 10);
      if (!rows.length) return interaction.reply({ content: 'Nobody has watered this tree yet.', ...EPHEMERAL });
      const body = rows.map((r, i) => `${medal((page - 1) * 10 + i)} <@${r.userId}> — **${r.count}** water${r.count === 1 ? '' : 's'}`).join('\n');
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(GREEN).setTitle('🌿 Greatest Gardeners').setDescription(body)
          .setFooter({ text: `${interaction.guild.name} · page ${page}` })],
      });
    }

    if (sub === 'forest') {
      const page = interaction.options.getInteger('page') || 1;
      const rows = await getForest(10, (page - 1) * 10);
      if (!rows.length) return interaction.reply({ content: 'No trees have been planted anywhere yet.', ...EPHEMERAL });
      const rank = await getForestRank(guildId);
      const body = rows.map((r, i) => {
        const here = r.guildId === guildId ? ' ← **you**' : '';
        return `${medal((page - 1) * 10 + i)} **${r.name}** — ${r.size} ft${here}`;
      }).join('\n');
      const embed = new EmbedBuilder().setColor(GREEN).setTitle('🌲 The Forest').setDescription(body);
      if (rank) embed.setFooter({ text: `This server's tree ranks #${rank}` });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'levels') {
      const page = interaction.options.getInteger('page') || 1;
      const rows = await getTopPlayers(10, (page - 1) * 10);
      if (!rows.length) return interaction.reply({ content: 'Nobody has watered a tree yet.', ...EPHEMERAL });
      const body = rows.map((r, i) => `${medal((page - 1) * 10 + i)} <@${r.userId}> — level **${r.level}**`).join('\n');
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(GREEN).setTitle('🌍 Global Levels').setDescription(body)
          .setFooter({ text: 'Levels are shared across every server' })],
      });
    }

    if (sub === 'profile') {
      const target = interaction.options.getUser('user') || interaction.user;
      const [player, contribution, tree] = await Promise.all([
        getPlayer(target.id), getContribution(guildId, target.id), getTree(guildId),
      ]);
      const needed = getNextLevelRequiredXp(player.level);
      const embed = new EmbedBuilder().setColor(GREEN)
        .setTitle(`🌱 ${target.username}`)
        .addFields(
          { name: 'Level', value: String(player.level), inline: true },
          { name: 'XP', value: `${player.xp} / ${needed}`, inline: true },
          { name: 'Waters (all servers)', value: String(player.waters), inline: true },
          { name: 'Waters here', value: String(contribution.count), inline: true },
          { name: 'Rank here', value: contribution.rank ? `#${contribution.rank}` : '—', inline: true },
        );
      if (tree) embed.addFields({ name: 'This tree', value: `${getTreeHeight(tree).toFixed(1)} ft`, inline: true });
      return interaction.reply({ embeds: [embed], ...EPHEMERAL });
    }

    if (sub === 'xp-messages') {
      const on = interaction.options.getBoolean('enabled');
      await setNotifyXp(interaction.user.id, on);
      return interaction.reply({ content: on ? 'I\'ll show your XP after each water.' : 'XP messages off.', ...EPHEMERAL });
    }
  },
};
