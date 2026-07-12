/* Cat Bot — clean-room. See /LICENSE-CATBOT-NOTICE.md. */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
  setupChannel, forgetChannel, setTimings, getChannel, spawnCat, scheduleRespawn, startRain,
} from '../../core/catbot/spawn-manager.js';
import {
  getInventory, getProfile, getLeaderboard, getCatalogue, canCraftPrism, craftPrism, getPrisms,
} from '../../core/catbot/stats.js';
import { listPrisms, prismCounts, boostFor, prismProgress } from '../../core/catbot/prisms.js';
import { progressFor, checkAndAward } from '../../core/catbot/achievements.js';
import { getPacks, openPack } from '../../core/catbot/packs.js';
import { catEmoji } from '../../core/catbot/emoji.js';
import { CAT_TYPES, MIN_SPAWN_FLOOR, DEFAULT_SPAWN_MIN, DEFAULT_SPAWN_MAX } from '../../core/catbot/constants.js';
import { getWallet, getRichest, getGameStats, getGameProfile } from '../../core/catbot/economy.js';
import { PERKS, MAX_LEVEL, ACTIVE_SLOTS, getLoadout, buyPerk, setActive, refundPerk, perkCost } from '../../core/catbot/catnip.js';
import { getBoard, getSeason, seasonReward, advance as advanceQuests, questLine, SEASON_XP_PER_LEVEL, MAX_SEASON_LEVEL } from '../../core/catbot/battlepass.js';
import {
  runSlots, runCoinflip, runRoulette, runScratch, runRps, runChaos,
  runFish, runCookie, runBakery, runBlackjack, runPig, runTicTacToe,
  MIN_BET, MAX_BET, DEFAULT_BET, normalizeBet,
} from '../../core/catbot/game-runner.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const COLOR = 0xF2A65A;
// Optional: omitting it stakes DEFAULT_BET.
const betOption = o => o.setName('bet')
  .setDescription(`Cat Coins to stake (${MIN_BET}–${MAX_BET.toLocaleString()}, default ${DEFAULT_BET})`)
  .setMinValue(MIN_BET).setMaxValue(MAX_BET);

const fmtMs = ms => (ms < 60000 ? `${(ms / 1000).toFixed(3)}s` : `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(1)}s`);

const describeReward = r => `**${r.coins.toLocaleString()}** 🪙${r.pack ? ` and a **${r.pack} pack**` : ''}`;

export default {
  category: 'games',
  data: new SlashCommandBuilder()
    .setName('cat')
    .setDescription('Cat Bot — cats appear on a timer; type `cat` to catch them')
    .addSubcommand(s => s.setName('setup').setDescription('[Admin] Start spawning cats in a channel')
      .addChannelOption(o => o.setName('channel').setDescription('Defaults to this channel')))
    .addSubcommand(s => s.setName('forget').setDescription('[Admin] Stop spawning cats in a channel')
      .addChannelOption(o => o.setName('channel').setDescription('Defaults to this channel')))
    .addSubcommand(s => s.setName('timings').setDescription('[Admin] Seconds between spawns')
      .addIntegerOption(o => o.setName('min').setDescription(`Minimum (>= ${MIN_SPAWN_FLOOR})`).setRequired(true).setMinValue(MIN_SPAWN_FLOOR))
      .addIntegerOption(o => o.setName('max').setDescription('Maximum').setRequired(true).setMinValue(MIN_SPAWN_FLOOR)))
    .addSubcommand(s => s.setName('forcespawn').setDescription('[Admin] Spawn a cat right now')
      .addStringOption(o => o.setName('type').setDescription('Specific type').setAutocomplete(true)))
    .addSubcommand(s => s.setName('inventory').setDescription('Your caught cats')
      .addUserOption(o => o.setName('user').setDescription('Someone else')))
    .addSubcommand(s => s.setName('catalogue').setDescription('Every cat type, its spawn chance and value'))
    .addSubcommand(s => s.setName('leaderboard').setDescription('Who is winning')
      .addStringOption(o => o.setName('kind').setDescription('Which board').addChoices(
        { name: 'Cats — most caught', value: 'cats' },
        { name: 'Value — rarest collection', value: 'value' },
        { name: 'Fast — quickest catch', value: 'fast' },
        { name: 'Slow — slowest catch', value: 'slow' })))
    .addSubcommand(s => s.setName('stats').setDescription('Your catch stats')
      .addUserOption(o => o.setName('user').setDescription('Someone else')))
    .addSubcommand(s => s.setName('prism').setDescription('Craft a prism — costs one of every cat type')
      .addStringOption(o => o.setName('name').setDescription('Name your prism')))
    .addSubcommand(s => s.setName('prisms').setDescription('This server\'s prisms and the boost they give'))
    .addSubcommand(s => s.setName('achievements').setDescription('What you\'ve unlocked')
      .addUserOption(o => o.setName('user').setDescription('Someone else')))
    .addSubcommand(s => s.setName('packs').setDescription('View and open your packs')
      .addStringOption(o => o.setName('open').setDescription('Which pack to open').setAutocomplete(true)))
    .addSubcommand(s => s.setName('coins').setDescription('Your Cat Coins, and who has the most')
      .addUserOption(o => o.setName('user').setDescription('Someone else')))
    .addSubcommand(s => s.setName('catnip').setDescription(`Perks that apply to your catches (${ACTIVE_SLOTS} active at once)`)
      .addStringOption(o => o.setName('action').setDescription('What to do').addChoices(
        { name: 'View your loadout', value: 'view' },
        { name: 'Buy or level up a perk', value: 'buy' },
        { name: 'Equip a perk', value: 'equip' },
        { name: 'Unequip a perk', value: 'unequip' },
        { name: 'Sell a perk back (50%)', value: 'refund' }))
      .addStringOption(o => o.setName('perk').setDescription('Which perk').setAutocomplete(true)))
    .addSubcommand(s => s.setName('quests').setDescription('Daily and weekly quests, and your season track'))
    .addSubcommandGroup(g => g.setName('game').setDescription('Spend your Cat Coins')
      .addSubcommand(s => s.setName('slots').setDescription('🎰 Three reels, six symbols').addIntegerOption(betOption))
      // Discord rejects a payload where a required option follows an optional one, so the
      // pick comes before the (now optional) bet.
      .addSubcommand(s => s.setName('coinflip').setDescription('🪙 Heads or tails, double or nothing')
        .addStringOption(o => o.setName('call').setDescription('Your call').setRequired(true)
          .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }))
        .addIntegerOption(betOption))
      .addSubcommand(s => s.setName('roulette').setDescription('🎡 Colour, parity, or a single number')
        .addStringOption(o => o.setName('on').setDescription('red / black / green / even / odd, or a number 0-36').setRequired(true))
        .addIntegerOption(betOption))
      .addSubcommand(s => s.setName('scratch').setDescription('🎫 Nine squares, three to match').addIntegerOption(betOption))
      .addSubcommand(s => s.setName('rps').setDescription('✂️ Rock paper scissors against the cat')
        .addStringOption(o => o.setName('choice').setDescription('Your throw').setRequired(true).addChoices(
          { name: 'Rock', value: 'rock' }, { name: 'Paper', value: 'paper' }, { name: 'Scissors', value: 'scissors' }))
        .addIntegerOption(betOption))
      .addSubcommand(s => s.setName('blackjack').setDescription('🃏 Hit or stand; natural 21 pays 3:2').addIntegerOption(betOption))
      .addSubcommand(s => s.setName('pig').setDescription('🐷 Press your luck — roll a 1 and lose it all').addIntegerOption(betOption))
      .addSubcommand(s => s.setName('tictactoe').setDescription('⭕ The cat plays perfectly. A draw refunds you').addIntegerOption(betOption))
      .addSubcommand(s => s.setName('chaos').setDescription('🌀 Nobody knows what happens').addIntegerOption(betOption))
      .addSubcommand(s => s.setName('fish').setDescription('🎣 Free. One cast a minute'))
      .addSubcommand(s => s.setName('cookie').setDescription('🍪 Free. Click the cookie'))
      .addSubcommand(s => s.setName('bakery').setDescription('🏭 Idle cookie production')
        .addStringOption(o => o.setName('action').setDescription('What to do').addChoices(
          { name: 'View', value: 'view' },
          { name: 'Collect and sell', value: 'collect' },
          { name: 'Upgrade', value: 'upgrade' }))))
    .addSubcommand(s => s.setName('rain').setDescription('[Admin] Make cats rain in this channel'))
    .addSubcommand(s => s.setName('settings').setDescription('[Admin] Toggle server options')
      .addStringOption(o => o.setName('option').setDescription('Which flag').setRequired(true).addChoices(
        { name: 'Auto-delete catch messages', value: 'auto_delete_catches' },
        { name: 'Anti double-catch (5m cross-channel cooldown)', value: 'anti_double_catch' },
        { name: 'Legacy catching (first only, no late catchers)', value: 'legacy_catching' },
        { name: 'Reactions', value: 'do_reactions' },
        { name: 'Cat rain', value: 'do_rain' }))
      .addBooleanOption(o => o.setName('value').setDescription('On or off').setRequired(true))),

  async autocomplete(interaction) {
    const q = String(interaction.options.getFocused() || '').toLowerCase();
    const sub = interaction.options.getSubcommand(false);

    if (sub === 'catnip') {
      const hits = PERKS.filter(p => p.id.includes(q) || p.name.toLowerCase().includes(q)).slice(0, 25);
      return interaction.respond(hits.map(p => ({ name: `${p.emoji} ${p.name}`, value: p.id }))).catch(() => {});
    }

    if (sub === 'packs') {
      // Only offer packs they actually hold.
      const owned = (await getPacks(interaction.guildId, interaction.user.id)).filter(p => p.count > 0);
      const hits = owned.filter(p => p.id.includes(q) || p.name.toLowerCase().includes(q)).slice(0, 25);
      return interaction.respond(hits.map(p => ({ name: `${p.name} ×${p.count}`, value: p.id }))).catch(() => {});
    }
    const hits = CAT_TYPES.filter(t => t.toLowerCase().includes(q)).slice(0, 25);
    await interaction.respond(hits.map(t => ({ name: t, value: t }))).catch(() => {});
  },

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: 'Cat Bot only works in servers.', ...EPHEMERAL });

    const isAdmin = () => interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const needAdmin = () => interaction.reply({ content: 'You need **Manage Server** for that.', ...EPHEMERAL });

    if (group === 'game') {
      // No number given (or junk from the prefix bridge) → the default stake.
      const bet = normalizeBet(interaction.options.getInteger('bet'));
      // Discord enforces required options and choices; `!coinflip 50` through the prefix
      // bridge does not, so every choice is re-validated before a stake is taken.
      const oneOf = (name, allowed) => {
        const v = String(interaction.options.getString(name) ?? '').trim().toLowerCase();
        return allowed.includes(v) ? v : null;
      };
      const badChoice = allowed => interaction.reply({
        content: `Pick one of: ${allowed.map(a => `\`${a}\``).join(', ')}.`, ...EPHEMERAL,
      });

      switch (sub) {
        case 'slots': return runSlots(interaction, bet);
        case 'coinflip': {
          const call = oneOf('call', ['heads', 'tails']);
          return call ? runCoinflip(interaction, bet, call) : badChoice(['heads', 'tails']);
        }
        case 'roulette': {
          const on = String(interaction.options.getString('on') ?? '').trim().toLowerCase();
          const valid = ['red', 'black', 'green', 'even', 'odd'].includes(on) ||
            (/^\d{1,2}$/.test(on) && Number(on) <= 36);
          if (!valid) {
            return interaction.reply({ content: 'Bet on `red`, `black`, `green`, `even`, `odd`, or a number `0`–`36`.', ...EPHEMERAL });
          }
          return runRoulette(interaction, bet, on);
        }
        case 'scratch': return runScratch(interaction, bet);
        case 'rps': {
          const choice = oneOf('choice', ['rock', 'paper', 'scissors']);
          return choice ? runRps(interaction, bet, choice) : badChoice(['rock', 'paper', 'scissors']);
        }
        case 'blackjack': return runBlackjack(interaction, bet);
        case 'pig': return runPig(interaction, bet);
        case 'tictactoe': return runTicTacToe(interaction, bet);
        case 'chaos': return runChaos(interaction, bet);
        case 'fish': return runFish(interaction);
        case 'cookie': return runCookie(interaction);
        case 'bakery': return runBakery(interaction, interaction.options.getString('action') || 'view');
      }
    }

    if (sub === 'setup') {
      if (!isAdmin()) return needAdmin();
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      await setupChannel(guildId, channel.id);
      await scheduleRespawn(channel.id);
      // Public, and worded as the bot this replaces worded it — the announcement IS the signal
      // to the channel that cats are now live, so hiding it behind an ephemeral reply loses that.
      return interaction.reply({ content: `ok, now i will also send cats in ${channel}` });
    }

    if (sub === 'forget') {
      if (!isAdmin()) return needAdmin();
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const gone = await forgetChannel(channel.id);
      return interaction.reply({ content: gone ? `Cats will no longer appear in ${channel}.` : `Cats weren't spawning in ${channel}.`, ...EPHEMERAL });
    }

    if (sub === 'timings') {
      if (!isAdmin()) return needAdmin();
      const min = interaction.options.getInteger('min');
      const max = interaction.options.getInteger('max');
      if (max < min) return interaction.reply({ content: '`max` must be at least `min`.', ...EPHEMERAL });
      const row = await getChannel(interaction.channelId);
      if (!row) return interaction.reply({ content: 'Run `/cat setup` here first.', ...EPHEMERAL });
      await setTimings(interaction.channelId, min, max);
      return interaction.reply({ content: `⏱️ Cats will now appear every **${min}–${max}s** here.`, ...EPHEMERAL });
    }

    if (sub === 'forcespawn') {
      if (!isAdmin()) return needAdmin();
      const row = await getChannel(interaction.channelId);
      if (!row) return interaction.reply({ content: 'Run `/cat setup` here first.', ...EPHEMERAL });
      if (row.cat_message_id) return interaction.reply({ content: 'A cat is already out here!', ...EPHEMERAL });
      const type = interaction.options.getString('type');
      if (type && !CAT_TYPES.includes(type)) return interaction.reply({ content: `Unknown cat type **${type}**.`, ...EPHEMERAL });
      await interaction.reply({ content: 'Spawning…', ...EPHEMERAL });
      const spawned = await spawnCat(interaction.channelId, type);
      return interaction.editReply(spawned ? `Spawned a **${spawned.type}** cat.` : 'Could not spawn (missing permissions?).');
    }

    if (sub === 'settings') {
      if (!isAdmin()) return needAdmin();
      const option = interaction.options.getString('option');
      const value = interaction.options.getBoolean('value') ? 1 : 0;
      // `option` is constrained to the choice list above, never free text.
      await pool.execute(
        `INSERT INTO catbot_settings (guild_id, ${option}) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE ${option} = VALUES(${option})`, [guildId, value]);
      return interaction.reply({ content: `✅ **${option.replace(/_/g, ' ')}** is now **${value ? 'on' : 'off'}**.`, ...EPHEMERAL });
    }

    if (sub === 'inventory') {
      const target = interaction.options.getUser('user') || interaction.user;
      const inv = await getInventory(guildId, target.id);
      if (!inv.total) {
        return interaction.reply({ content: `**${target.username}** hasn't caught any cats yet.`, ...EPHEMERAL });
      }
      const lines = inv.cats.filter(c => c.count > 0).map(c => `${catEmoji(c.type)} **${c.type}** ×${c.count}`);
      const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle(`${target.username}'s cats`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${inv.total} cats · ${inv.distinct}/${CAT_TYPES.length} types · ${inv.value.toFixed(2)} value` });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'catalogue') {
      const rows = getCatalogue().map(c =>
        `${catEmoji(c.type)} **${c.type}** — ${c.chance < 0.1 ? c.chance.toFixed(4) : c.chance.toFixed(2)}% · worth ${c.value.toFixed(2)}`);
      const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle('🐱 Cat Catalogue')
        .setDescription(rows.join('\n'))
        .setFooter({ text: 'Rarer cats are worth more.' });
      return interaction.reply({ embeds: [embed], ...EPHEMERAL });
    }

    if (sub === 'leaderboard') {
      const kind = interaction.options.getString('kind') || 'cats';
      const rows = await getLeaderboard(guildId, kind, 10);
      if (!rows.length) return interaction.reply({ content: 'Nobody has caught a cat here yet.', ...EPHEMERAL });
      const medal = i => ['🥇', '🥈', '🥉'][i] || `\`${String(i + 1).padStart(2)}\``;
      const body = rows.map((r, i) => {
        const who = `<@${r.userId}>`;
        if (kind === 'cats') return `${medal(i)} ${who} — **${r.cats}** cats`;
        if (kind === 'value') return `${medal(i)} ${who} — **${r.value.toFixed(2)}** value`;
        return `${medal(i)} ${who} — **${fmtMs(r.ms)}**`;
      }).join('\n');
      const titles = { cats: 'Most Cats', value: 'Rarest Collection', fast: 'Fastest Catch', slow: 'Slowest Catch' };
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle(`🏆 ${titles[kind]}`).setDescription(body)
          .setFooter({ text: interaction.guild.name })],
      });
    }

    if (sub === 'stats') {
      const target = interaction.options.getUser('user') || interaction.user;
      const [p, inv] = await Promise.all([getProfile(guildId, target.id), getInventory(guildId, target.id)]);
      if (!p) return interaction.reply({ content: `**${target.username}** hasn't caught any cats yet.`, ...EPHEMERAL });
      const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle(`${target.username}'s stats`)
        .addFields(
          { name: 'Cats caught', value: String(p.total_catches), inline: true },
          { name: 'Types', value: `${inv.distinct}/${CAT_TYPES.length}`, inline: true },
          { name: 'Collection value', value: inv.value.toFixed(2), inline: true },
          { name: 'Fastest catch', value: p.fastest_ms != null ? fmtMs(p.fastest_ms) : '—', inline: true },
          { name: 'Slowest catch', value: p.slowest_ms != null ? fmtMs(p.slowest_ms) : '—', inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'prism') {
      const name = (interaction.options.getString('name') || `${interaction.user.username}'s prism`).slice(0, 64);
      const check = await canCraftPrism(guildId, interaction.user.id);
      if (!check.ok) {
        const progress = await prismProgress(guildId, interaction.user.id);
        return interaction.reply({
          content: `🔮 A prism costs **one of every cat type** (${progress.have}/${progress.need}).\nStill missing: ${check.missing.map(t => `**${t}**`).join(', ')}`,
          ...EPHEMERAL,
        });
      }
      const res = await craftPrism(guildId, interaction.user.id, name);
      if (!res.ok) return interaction.reply({ content: `You no longer have a **${res.missing}** cat.`, ...EPHEMERAL });
      const all = await getPrisms(guildId);
      return interaction.reply({
        content: `🔮 **${interaction.user.username}** crafted **${name}**! This server now has **${all.length}** prism${all.length === 1 ? '' : 's'}.\n` +
          'Prisms give every catch here a chance to upgrade a rarity tier.',
      });
    }

    if (sub === 'prisms') {
      const all = await listPrisms(guildId);
      if (!all.length) {
        return interaction.reply({ content: 'No prisms here yet. Craft one with `/cat prism`.', ...EPHEMERAL });
      }
      const counts = await prismCounts(guildId, interaction.user.id);
      const boost = boostFor(counts);
      const body = all.slice(0, 20).map(p =>
        `🔮 **${p.name}** — by <@${p.creator_id}> · boosted ${p.catches_boosted} catches`).join('\n');
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xB57BE0)
          .setTitle(`🔮 Prisms of ${interaction.guild.name}`)
          .setDescription(body)
          .setFooter({ text: `${all.length} prism(s) · your upgrade chance: ${(Math.min(boost, 1) * 100).toFixed(1)}%${boost > 1 ? ' (+ a shot at a second tier)' : ''}` })],
      });
    }

    if (sub === 'achievements') {
      const target = interaction.options.getUser('user') || interaction.user;
      const all = await progressFor(guildId, target.id);
      const earned = all.filter(a => a.earned);
      const byCategory = {};
      for (const a of all) (byCategory[a.category] ??= []).push(a);

      const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle(`🏆 ${target.username}'s achievements`)
        .setFooter({ text: `${earned.length}/${all.length} unlocked` });
      for (const [category, list] of Object.entries(byCategory)) {
        embed.addFields({
          name: `${category} (${list.filter(a => a.earned).length}/${list.length})`,
          value: list.map(a => a.earned ? `${a.emoji} **${a.name}**` : `🔒 ${a.name} — *${a.description}*`).join('\n').slice(0, 1024),
        });
      }
      return interaction.reply({ embeds: [embed], ...EPHEMERAL });
    }

    if (sub === 'packs') {
      const toOpen = interaction.options.getString('open');
      if (toOpen) {
        const res = await openPack(guildId, interaction.user.id, toOpen);
        if (!res.ok) {
          return interaction.reply({
            content: res.reason === 'none' ? "You don't have that pack." : 'Unknown pack.',
            ...EPHEMERAL,
          });
        }
        const tally = new Map();
        for (const t of res.cats) tally.set(t, (tally.get(t) || 0) + 1);
        const list = [...tally].map(([t, n]) => `${catEmoji(t, interaction.client.user?.id)} **${t}**${n > 1 ? ` ×${n}` : ''}`).join(' · ');
        const quests = questLine(await advanceQuests(guildId, interaction.user.id, [['pack_open', 1]]));
        await interaction.reply({ content: `${res.pack.emoji} **${interaction.user.username}** opened a **${res.pack.name}** and found:\n${list}${quests}` });
        // Opening can complete a collection.
        const earned = await checkAndAward(guildId, interaction.user.id);
        if (earned.length) {
          await interaction.followUp({
            content: `🏆 ${interaction.user} unlocked: ${earned.map(a => `${a.emoji} **${a.name}**`).join(', ')}`,
            allowedMentions: { users: [] },
          }).catch(() => {});
        }
        return;
      }

      const packs = await getPacks(guildId, interaction.user.id);
      const owned = packs.filter(p => p.count > 0);
      const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle(`📦 ${interaction.user.username}'s packs`)
        .setDescription(owned.length
          ? owned.map(p => `${p.emoji} **${p.name}** ×${p.count} — ${p.cats} cats, ${CAT_TYPES[p.minTier]} or better`).join('\n')
          : 'No packs yet. They drop occasionally when you catch a cat.')
        .setFooter({ text: 'Open one with /cat packs open:<pack>' });
      return interaction.reply({ embeds: [embed], ...EPHEMERAL });
    }

    if (sub === 'coins') {
      const target = interaction.options.getUser('user') || interaction.user;
      const [wallet, richest, games, profile] = await Promise.all([
        getWallet(guildId, target.id), getRichest(guildId, 5),
        getGameStats(guildId, target.id), getGameProfile(guildId, target.id),
      ]);
      const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle(`🪙 ${target.username}'s Cat Coins`)
        .setDescription(`**${wallet.coins.toLocaleString()}** on hand · **${wallet.lifetime.toLocaleString()}** earned all-time`);

      if (games.length) {
        const net = games.reduce((s, g) => s + g.net, 0);
        embed.addFields({
          name: 'Games',
          value: games.slice(0, 8).map(g =>
            `**${g.game}** — ${g.plays} played, ${g.wins} won, ${g.net >= 0 ? '+' : ''}${g.net.toLocaleString()} 🪙`).join('\n') +
            `\n\nLifetime table result: **${net >= 0 ? '+' : ''}${net.toLocaleString()}** 🪙`,
        });
      }
      if (Number(profile.cookies) || Number(profile.fish_caught)) {
        embed.addFields({
          name: 'Odds and ends',
          value: `🍪 ${Number(profile.cookies).toLocaleString()} cookies · 🎣 ${profile.fish_caught} fish` +
            (profile.best_fish ? ` (best: **${profile.best_fish}**)` : '') +
            (Number(profile.best_pig) ? ` · 🐷 best pot **${profile.best_pig}**` : ''),
        });
      }
      if (richest.length) {
        embed.addFields({
          name: 'Richest here',
          value: richest.map((r, i) => `${['🥇', '🥈', '🥉'][i] || `\`${i + 1}\``} <@${r.userId}> — **${r.coins.toLocaleString()}** 🪙`).join('\n'),
        });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'catnip') {
      const action = interaction.options.getString('action') || 'view';
      const perkId = interaction.options.getString('perk');

      if (action !== 'view' && !perkId) {
        return interaction.reply({ content: 'Pick a perk with the `perk` option.', ...EPHEMERAL });
      }

      if (action === 'buy') {
        const res = await buyPerk(guildId, interaction.user.id, perkId);
        if (!res.ok) {
          const why = {
            unknown: 'No such perk.',
            maxed: `That perk is already at level **${MAX_LEVEL}**.`,
            poor: `That costs **${res.cost?.toLocaleString()}** 🪙 — you have **${res.coins?.toLocaleString()}**.`,
          }[res.reason];
          return interaction.reply({ content: why, ...EPHEMERAL });
        }
        return interaction.reply({
          content: `${res.perk.emoji} **${res.perk.name}** is now level **${res.level}** — ${res.perk.format(res.perk.value(res.level))}.` +
            (res.level === 1 ? `\nEquip it with \`/cat catnip action:equip perk:${res.perk.id}\`.` : ''),
          ...EPHEMERAL,
        });
      }

      if (action === 'equip' || action === 'unequip') {
        const res = await setActive(guildId, interaction.user.id, perkId, action === 'equip');
        if (!res.ok) {
          const why = {
            unknown: 'No such perk.',
            unowned: "You don't own that perk yet — buy it first.",
            full: `You already have **${ACTIVE_SLOTS}** perks equipped. Unequip one first.`,
          }[res.reason];
          return interaction.reply({ content: why, ...EPHEMERAL });
        }
        return interaction.reply({
          content: `${res.perk.emoji} **${res.perk.name}** ${action === 'equip' ? 'equipped' : 'unequipped'}.`,
          ...EPHEMERAL,
        });
      }

      if (action === 'refund') {
        const res = await refundPerk(guildId, interaction.user.id, perkId);
        if (!res.ok) {
          return interaction.reply({ content: res.reason === 'unowned' ? "You don't own that perk." : 'No such perk.', ...EPHEMERAL });
        }
        return interaction.reply({ content: `${res.perk.emoji} Sold **${res.perk.name}** back for **${res.refund.toLocaleString()}** 🪙.`, ...EPHEMERAL });
      }

      const [loadout, wallet] = await Promise.all([
        getLoadout(guildId, interaction.user.id), getWallet(guildId, interaction.user.id),
      ]);
      const equipped = loadout.filter(p => p.active).length;
      const embed = new EmbedBuilder().setColor(0x77DD77)
        .setTitle('🌿 Catnip')
        .setDescription(`Perks apply to the cats **you** catch. Only **${ACTIVE_SLOTS}** can be equipped at a time — you have **${equipped}**.`)
        .setFooter({ text: `Balance: ${wallet.coins.toLocaleString()} 🪙` });

      for (const p of loadout) {
        const owned = p.level > 0;
        const next = p.level < MAX_LEVEL ? `\nNext level: **${perkCost(p, p.level + 1).toLocaleString()}** 🪙` : '\n*Maxed.*';
        embed.addFields({
          name: `${p.active ? '✅' : owned ? '▫️' : '🔒'} ${p.emoji} ${p.name} ${owned ? `— Lv.${p.level}` : ''}`,
          value: `${p.description}${owned ? `\nNow: **${p.format(p.value(p.level))}**` : ''}${next}`,
        });
      }
      return interaction.reply({ embeds: [embed], ...EPHEMERAL });
    }

    if (sub === 'quests') {
      const [board, season] = await Promise.all([
        getBoard(guildId, interaction.user.id), getSeason(guildId, interaction.user.id),
      ]);
      const ready = board.filter(q => q.complete && !q.claimed).length;
      const unclaimedLevels = season.level - season.claimed;

      const bar = (n, t) => {
        const filled = Math.round((Math.min(n, t) / t) * 10);
        return `\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\``;
      };
      const line = q => `${q.claimed ? '✅' : q.complete ? '🎁' : '▫️'} **${q.name}** ${bar(q.progress, q.target)} ${q.progress}/${q.target}` +
        `${q.claimed ? '' : ` — **${q.coins}** 🪙, **${q.xp}** ⭐`}`;

      const embed = new EmbedBuilder().setColor(0xB57BE0)
        .setTitle('🎯 Quests')
        .addFields(
          { name: 'Daily — resets at midnight UTC', value: board.filter(q => q.kind === 'daily').map(line).join('\n') || '—' },
          { name: 'Weekly', value: board.filter(q => q.kind === 'weekly').map(line).join('\n') || '—' },
          {
            name: `⭐ Season level ${season.level}${season.level >= MAX_SEASON_LEVEL ? ' (max)' : ''}`,
            value: `${bar(season.xp, SEASON_XP_PER_LEVEL)} ${season.xp}/${SEASON_XP_PER_LEVEL} XP` +
              (season.level < MAX_SEASON_LEVEL ? `\nLevel ${season.level + 1} pays ${describeReward(seasonReward(season.level + 1))}.` : '') +
              (unclaimedLevels > 0 ? `\n🎁 **${unclaimedLevels}** level reward${unclaimedLevels === 1 ? '' : 's'} unclaimed.` : ''),
          })
        .setFooter({ text: 'Quests refresh per person — yours are yours.' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cbq:claim').setLabel(ready ? `Claim ${ready} quest${ready === 1 ? '' : 's'}` : 'Nothing to claim')
          .setStyle(ButtonStyle.Success).setDisabled(!ready),
        new ButtonBuilder().setCustomId('cbq:season').setLabel('Claim rewards')
          .setStyle(ButtonStyle.Primary).setDisabled(unclaimedLevels <= 0),
      );
      return interaction.reply({ embeds: [embed], components: [row], ...EPHEMERAL });
    }

    if (sub === 'rain') {
      if (!isAdmin()) return needAdmin();
      const row = await getChannel(interaction.channelId);
      if (!row) return interaction.reply({ content: 'Run `/cat setup` here first.', ...EPHEMERAL });
      await startRain(interaction.channelId);
      await interaction.reply({ content: '🌧️ **Cats are raining!** The next several spawns come fast.' });
      // Kick the first one off now rather than waiting out the current timer.
      if (!row.cat_message_id) await scheduleRespawn(interaction.channelId);
      return;
    }
  },
};
