import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import {
  getPlayer, cast, getInventory, sell, buyRod, equipRod, buyBait, buyLocation,
  travel, claimDaily, getQuest, getLeaderboard, getGuildLeaderboard,
  getRecords, toggleLock, buyPet, equipPet, getAutofisher, buyAutofisher,
  collectAutofisher, giftCoins, giftFish, getWeather,
  startTournament, getActiveTournament, getTournamentStandings, suggestFishNames,
  RARITIES, RODS, BAITS, LOCATIONS, PETS, AUTOFISHER,
  RODS_BY_ID, BAITS_BY_ID, LOCATIONS_BY_ID, PETS_BY_ID, FISH_INDEX,
  levelFromXp, xpForLevel,
} from '../../core/fishing-manager.js';

const COIN = '🪙';
const n = (x) => Number(x).toLocaleString();
const RANKS = ['junk', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];
const rank = (k) => RANKS.indexOf(k);

function choicesFromList(list) {
  return list.slice(0, 25).map(x => ({ name: `${x.name}${x.price ? ` — ${n(x.price)} ${COIN}` : ''}`, value: x.id }));
}
function metaName(meta, shiny) { return `${shiny ? '✨ ' : ''}${meta.name}`; }

// ── Shared catch renderer (reused by the "Catch again" button) ──────────────
export function castButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fish_again').setLabel('Catch again').setEmoji('🎣').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('fish_sellall').setLabel('Sell all').setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('fish_inv').setLabel('Inventory').setEmoji('🎒').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

export async function renderCast(result) {
  const top = result.caught.reduce((a, b) => (rank(b.rarity) > rank(a.rarity) ? b : a), result.caught[0]);
  const color = (RARITIES[top.rarity] || RARITIES.common).color;
  const lines = result.caught.map(c => {
    const r = RARITIES[c.rarity] || RARITIES.common;
    const w = c.rarity === 'junk' ? '' : ` · ${c.weight} kg`;
    const name = c.shiny ? `✨ **${c.name}**` : `**${c.name}**`;
    return `${c.emoji} ${r.emoji} ${name}${w} — \`${n(c.value)}\` ${COIN}`;
  });
  const haul = result.caught.filter(c => c.rarity !== 'junk').reduce((s, c) => s + c.value, 0);
  const junk = result.caught.filter(c => c.rarity === 'junk');
  const w = result.weather;
  const embed = new EmbedBuilder()
    .setColor(result.shinyHit ? 0xfde047 : color)
    .setAuthor({ name: `${result.location.emoji} ${result.location.name} · ${result.rod.emoji} ${result.rod.name} · ${w.emoji} ${w.name}` })
    .setTitle(result.shinyHit ? '✨ A SHINY catch!' : (result.caught.length > 1 ? `🎣 You reeled in ${result.caught.length} catches!` : '🎣 You caught something!'))
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Haul value: ${n(haul)} ${COIN} · +${n(result.xpGain)} XP (Lv ${result.level})${result.bait ? ` · ${result.bait.emoji} ${result.bait.name} (${result.baitLeft})` : ''}` });

  if (result.leveledUp) embed.addFields({ name: '⭐ Level up!', value: `You're now **Angler Level ${result.leveledUp}** — luck improved!` });
  const q = result.quest;
  if (q && q.justRewarded) embed.addFields({ name: '🎯 Daily quest complete!', value: `${q.desc} — **+${n(q.justRewarded)}** ${COIN}` });
  else if (q && !q.claimed) embed.addFields({ name: '🎯 Daily quest', value: `${q.desc} — \`${n(q.progress)}/${n(q.target)}\`` });
  if (junk.length) embed.addFields({ name: '🗑️ Junk', value: junk.map(j => `${j.emoji} ${j.name}`).join(', ') });
  return embed;
}

function cooldownMsg(ms) { return `🌊 Your line is still in the water — cast again in **${(ms / 1000).toFixed(1)}s**.`; }

export async function doCast(interaction) {
  const result = await cast(interaction.user.id, interaction.guildId);
  if (result.cooldown) return interaction.reply({ content: cooldownMsg(result.remainingMs), ephemeral: true });
  return interaction.reply({ embeds: [await renderCast(result)], components: [castButtons()] });
}

export default {
  category: 'games',
  data: new SlashCommandBuilder()
    .setName('fish')
    .setDescription('Go fishing! Catch, collect, upgrade — your gear follows you across servers.')
    .addSubcommand(s => s.setName('catch').setDescription('🎣 Cast your line and catch a fish'))
    .addSubcommand(s => s.setName('inventory').setDescription('🎒 See the fish you\'re holding (sellable bucket)'))
    .addSubcommand(s => s.setName('sell').setDescription('💰 Sell all your unlocked fish for fishcoins'))
    .addSubcommand(s => s.setName('sellone').setDescription('💵 Sell just one species')
      .addStringOption(o => o.setName('fish').setDescription('Which fish (type to search)').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('lock').setDescription('🔒 Lock a trophy so "sell all" never sells it')
      .addStringOption(o => o.setName('fish').setDescription('Which fish').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('unlock').setDescription('🔓 Unlock a trophy so it can be sold again')
      .addStringOption(o => o.setName('fish').setDescription('Which fish').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('balance').setDescription('🪙 Your fishcoins, level and gear')
      .addUserOption(o => o.setName('user').setDescription('Whose card').setRequired(false)))
    .addSubcommand(s => s.setName('bestiary').setDescription('📖 Your permanent collection & completion %')
      .addUserOption(o => o.setName('user').setDescription('Whose bestiary').setRequired(false)))
    .addSubcommand(s => s.setName('aquarium').setDescription('🐠 Your prize trophies (best catches, kept forever)'))
    .addSubcommand(s => s.setName('collect').setDescription('🤖 Collect your auto-fisher\'s banked fishcoins'))
    .addSubcommand(s => s.setName('weather').setDescription('🌦️ Today\'s fishing weather'))
    .addSubcommand(s => s.setName('daily').setDescription('📅 Claim your daily fishcoins (streak bonus)'))
    .addSubcommand(s => s.setName('quest').setDescription('🎯 View today\'s fishing quest'))
    .addSubcommand(s => s.setName('leaderboard').setDescription('🏆 Top anglers')
      .addStringOption(o => o.setName('scope').setDescription('Global or this server').addChoices(
        { name: 'Global', value: 'global' }, { name: 'This server', value: 'server' }))
      .addStringOption(o => o.setName('by').setDescription('Rank by').addChoices(
        { name: 'Fishcoins', value: 'coins' }, { name: 'Fish caught', value: 'catches' })))
    .addSubcommandGroup(g => g.setName('shop').setDescription('Buy gear')
      .addSubcommand(s => s.setName('view').setDescription('🛒 Browse everything for sale'))
      .addSubcommand(s => s.setName('rod').setDescription('🎣 Buy a rod')
        .addStringOption(o => o.setName('rod').setDescription('Which rod').setRequired(true).addChoices(...choicesFromList(RODS.filter(r => r.price > 0)))))
      .addSubcommand(s => s.setName('bait').setDescription('🪱 Buy bait')
        .addStringOption(o => o.setName('bait').setDescription('Which bait').setRequired(true).addChoices(...choicesFromList(BAITS))))
      .addSubcommand(s => s.setName('location').setDescription('🗺️ Unlock a fishing spot')
        .addStringOption(o => o.setName('location').setDescription('Which spot').setRequired(true).addChoices(...choicesFromList(LOCATIONS.filter(l => l.price > 0)))))
      .addSubcommand(s => s.setName('pet').setDescription('🐾 Buy a companion pet')
        .addStringOption(o => o.setName('pet').setDescription('Which pet').setRequired(true).addChoices(...choicesFromList(PETS))))
      .addSubcommand(s => s.setName('autofisher').setDescription('🤖 Buy / upgrade your idle auto-fisher')))
    .addSubcommandGroup(g => g.setName('equip').setDescription('Equip gear you own')
      .addSubcommand(s => s.setName('rod').setDescription('🎣 Equip a rod')
        .addStringOption(o => o.setName('rod').setDescription('Which rod').setRequired(true).addChoices(...choicesFromList(RODS))))
      .addSubcommand(s => s.setName('pet').setDescription('🐾 Equip (or remove) a pet')
        .addStringOption(o => o.setName('pet').setDescription('Which pet (omit to unequip)').setRequired(false).addChoices(...choicesFromList(PETS), { name: 'None (unequip)', value: 'none' })))
      .addSubcommand(s => s.setName('travel').setDescription('🚤 Travel to a spot you\'ve unlocked')
        .addStringOption(o => o.setName('location').setDescription('Which spot').setRequired(true).addChoices(...choicesFromList(LOCATIONS)))))
    .addSubcommandGroup(g => g.setName('gift').setDescription('Give to another angler')
      .addSubcommand(s => s.setName('coins').setDescription('🎁 Gift fishcoins')
        .addUserOption(o => o.setName('user').setDescription('Recipient').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('How many fishcoins').setRequired(true).setMinValue(1)))
      .addSubcommand(s => s.setName('fish').setDescription('🎁 Gift a fish from your bucket')
        .addUserOption(o => o.setName('user').setDescription('Recipient').setRequired(true))
        .addStringOption(o => o.setName('fish').setDescription('Which fish').setRequired(true).setAutocomplete(true))
        .addIntegerOption(o => o.setName('amount').setDescription('How many (default 1)').setRequired(false).setMinValue(1))))
    .addSubcommandGroup(g => g.setName('tournament').setDescription('Server fishing contests')
      .addSubcommand(s => s.setName('start').setDescription('🏁 Start a timed contest (Manage Server)')
        .addStringOption(o => o.setName('type').setDescription('Win condition').addChoices(
          { name: 'Biggest catch', value: 'biggest' }, { name: 'Most fish', value: 'most' }))
        .addIntegerOption(o => o.setName('minutes').setDescription('Duration (5-1440)').setMinValue(5).setMaxValue(1440))
        .addIntegerOption(o => o.setName('prize').setDescription('Prize pool in fishcoins').setMinValue(0)))
      .addSubcommand(s => s.setName('status').setDescription('📊 Current contest standings'))),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'fish') return interaction.respond([]);
    const sub = interaction.options.getSubcommand(false);
    const group = interaction.options.getSubcommandGroup(false);
    const fromBucket = sub === 'sellone' || (group === 'gift' && sub === 'fish');
    const list = await suggestFishNames(interaction.user.id, focused.value, fromBucket);
    return interaction.respond(list.map(x => ({ name: x.name.slice(0, 100), value: metaFor_name(x) })));
  },

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;

    // ── shop group ──
    if (group === 'shop') {
      if (sub === 'view') return shopView(interaction);
      if (sub === 'rod') { const r = await buyRod(uid, interaction.options.getString('rod')); return interaction.reply({ content: r.ok ? `✅ Bought & equipped ${r.rod.emoji} **${r.rod.name}**! Balance: **${n(r.balance)}** ${COIN}` : `❌ ${r.reason}`, ephemeral: !r.ok }); }
      if (sub === 'bait') { const r = await buyBait(uid, interaction.options.getString('bait')); return interaction.reply({ content: r.ok ? `✅ Bought ${r.bait.emoji} **${r.bait.name}** — ${r.uses} casts ready. Balance: **${n(r.balance)}** ${COIN}` : `❌ ${r.reason}`, ephemeral: !r.ok }); }
      if (sub === 'location') { const r = await buyLocation(uid, interaction.options.getString('location')); return interaction.reply({ content: r.ok ? `🗺️ Unlocked & travelled to ${r.location.emoji} **${r.location.name}**! Balance: **${n(r.balance)}** ${COIN}` : `❌ ${r.reason}`, ephemeral: !r.ok }); }
      if (sub === 'pet') { const r = await buyPet(uid, interaction.options.getString('pet')); return interaction.reply({ content: r.ok ? `🐾 Adopted & equipped ${r.pet.emoji} **${r.pet.name}**! Balance: **${n(r.balance)}** ${COIN}` : `❌ ${r.reason}`, ephemeral: !r.ok }); }
      if (sub === 'autofisher') {
        const r = await buyAutofisher(uid);
        return interaction.reply({ content: r.ok ? `🤖 Auto-fisher upgraded to **Lv ${r.tier.level}** — ${n(r.tier.perHour)} ${COIN}/hr (banks up to ${r.tier.capHours}h)${r.collected ? `\nCollected **${n(r.collected)}** ${COIN} pending.` : ''}\nBalance: **${n(r.balance)}** ${COIN}` : `❌ ${r.reason}`, ephemeral: !r.ok });
      }
    }
    if (group === 'equip') {
      if (sub === 'rod') { const r = await equipRod(uid, interaction.options.getString('rod')); return interaction.reply({ content: r.ok ? `🎣 Equipped ${r.rod.emoji} **${r.rod.name}**.` : `❌ ${r.reason}`, ephemeral: !r.ok }); }
      if (sub === 'pet') { const raw = interaction.options.getString('pet'); const pid = (!raw || raw === 'none') ? '' : raw; const r = await equipPet(uid, pid); return interaction.reply({ content: r.ok ? (r.pet ? `🐾 Equipped ${r.pet.emoji} **${r.pet.name}**.` : '🐾 Unequipped your pet.') : `❌ ${r.reason}`, ephemeral: !r.ok }); }
      if (sub === 'travel') { const r = await travel(uid, interaction.options.getString('location')); return interaction.reply({ content: r.ok ? `🚤 You head to ${r.location.emoji} **${r.location.name}**. Tight lines!` : `❌ ${r.reason}`, ephemeral: !r.ok }); }
    }
    if (group === 'gift') {
      if (sub === 'coins') {
        const target = interaction.options.getUser('user');
        if (target.bot) return interaction.reply({ content: 'You can\'t gift a bot.', ephemeral: true });
        const r = await giftCoins(uid, target.id, interaction.options.getInteger('amount'));
        return interaction.reply({ content: r.ok ? `🎁 Gifted **${n(r.amount)}** ${COIN} to <@${target.id}>. Balance: **${n(r.balance)}** ${COIN}` : `❌ ${r.reason}`, ephemeral: !r.ok });
      }
      if (sub === 'fish') {
        const target = interaction.options.getUser('user');
        if (target.bot) return interaction.reply({ content: 'You can\'t gift a bot.', ephemeral: true });
        const r = await giftFish(uid, target.id, interaction.options.getString('fish'), interaction.options.getInteger('amount') || 1);
        return interaction.reply({ content: r.ok ? `🎁 Gave ${r.emoji} **${r.name}** ×${r.qty} to <@${target.id}>.` : `❌ ${r.reason}`, ephemeral: !r.ok });
      }
    }
    if (group === 'tournament') {
      if (sub === 'start') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
          return interaction.reply({ content: '❌ You need **Manage Server** to start a tournament.', ephemeral: true });
        const r = await startTournament(interaction.guildId, interaction.channelId, uid, {
          type: interaction.options.getString('type') || 'biggest',
          minutes: interaction.options.getInteger('minutes') || 60,
          prize: interaction.options.getInteger('prize') ?? 10000,
        });
        if (!r.ok) return interaction.reply({ content: `❌ ${r.reason}`, ephemeral: true });
        const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('🏁 Fishing Tournament started!')
          .setDescription(`**Win condition:** ${r.type === 'most' ? 'Most fish caught' : 'Biggest single catch'}\n**Prize:** ${n(r.prize)} ${COIN}\n**Ends:** <t:${Math.floor(r.endsAt.getTime() / 1000)}:R>\n\nJust \`/fish catch\` here — your catches are counted automatically!`);
        return interaction.reply({ embeds: [embed] });
      }
      if (sub === 'status') return tournamentStatus(interaction);
    }

    // ── top-level subcommands ──
    if (sub === 'catch') return doCast(interaction);

    if (sub === 'inventory') {
      const inv = await getInventory(uid);
      if (!inv.length) return interaction.reply({ content: '🎒 Your bucket is empty. Go `/fish catch` something!', ephemeral: true });
      const p = await getPlayer(uid);
      const locked = new Set(p.lockedKeys || []);
      const total = inv.reduce((s, i) => s + i.totalValue, 0);
      const lines = inv.slice(0, 25).map(i => {
        const r = RARITIES[i.rarity] || RARITIES.common;
        const lock = locked.has(i.key) || locked.has(i.baseKey) ? ' 🔒' : '';
        return `${i.emoji} ${r.emoji} **${metaName(i, i.shiny)}** ×${i.quantity} — \`${n(i.totalValue)}\` ${COIN}${lock}`;
      });
      const embed = new EmbedBuilder().setColor(0x3b82f6).setTitle(`🎒 ${interaction.user.username}'s bucket`)
        .setDescription(lines.join('\n')).setFooter({ text: `Sell value: ${n(total)} ${COIN} · /fish sell` });
      return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fish_sellall').setLabel('Sell all').setEmoji('💰').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('fish_again').setLabel('Catch again').setEmoji('🎣').setStyle(ButtonStyle.Primary),
      )] });
    }

    if (sub === 'sell' || sub === 'sellone') {
      const targetKey = sub === 'sellone' ? interaction.options.getString('fish') : 'all';
      const r = await sell(uid, sub === 'sellone' ? await resolveKeyForSell(uid, targetKey) : 'all', interaction.guildId);
      if (!r.sold) return interaction.reply({ content: r.skippedLocked ? '🔒 Everything in your bucket is locked — nothing sold.' : '🪣 Nothing to sell.', ephemeral: true });
      let msg = `💰 Sold **${n(r.sold)}** fish for **${n(r.coins)}** ${COIN}\nNew balance: **${n(r.balance)}** ${COIN}`;
      if (r.quest?.justRewarded) msg += `\n🎯 Quest complete: **+${n(r.quest.justRewarded)}** ${COIN}`;
      return interaction.reply({ content: msg });
    }

    if (sub === 'lock' || sub === 'unlock') {
      const r = await toggleLock(uid, interaction.options.getString('fish'), sub === 'lock');
      return interaction.reply({ content: r.ok ? `${sub === 'lock' ? '🔒 Locked' : '🔓 Unlocked'} ${r.fish.meta.emoji} **${metaName(r.fish.meta, r.fish.shiny)}**${sub === 'lock' ? ' — safe from "sell all".' : '.'}` : `❌ ${r.reason}`, ephemeral: !r.ok });
    }

    if (sub === 'balance') {
      const target = interaction.options.getUser('user') || interaction.user;
      const p = await getPlayer(target.id);
      const rod = RODS_BY_ID[p.rod], loc = LOCATIONS_BY_ID[p.location], pet = p.pet ? PETS_BY_ID[p.pet] : null;
      const big = p.biggestKey ? FISH_INDEX[p.biggestKey.replace('#s', '')] : null;
      const af = getAutofisher(p);
      const nextLvlXp = xpForLevel(p.level + 1);
      const embed = new EmbedBuilder().setColor(0xf59e0b)
        .setAuthor({ name: `${target.username}'s angler card`, iconURL: target.displayAvatarURL() })
        .addFields(
          { name: '🪙 Fishcoins', value: n(p.coins), inline: true },
          { name: '⭐ Level', value: `${p.level} (${n(p.xp)}/${n(nextLvlXp)} XP)`, inline: true },
          { name: '🐟 Total caught', value: n(p.totalCatches), inline: true },
          { name: '🎣 Rod', value: `${rod.emoji} ${rod.name}`, inline: true },
          { name: '📍 Location', value: `${loc.emoji} ${loc.name}`, inline: true },
          { name: '🪱 Bait', value: p.bait ? `${BAITS_BY_ID[p.bait].emoji} ${BAITS_BY_ID[p.bait].name} (${p.baitUses})` : 'None', inline: true },
          { name: '🐾 Pet', value: pet ? `${pet.emoji} ${pet.name}` : 'None', inline: true },
          { name: '🤖 Auto-fisher', value: af.level ? `Lv ${af.level} · ${n(af.pending.coins)} ${COIN} banked` : 'None', inline: true },
          { name: '✨ Shinies', value: n(p.shinyCaught), inline: true },
        );
      if (big) embed.addFields({ name: '🏅 Biggest catch', value: `${big.emoji} ${big.name} — ${p.biggestWeight} kg` });
      if (p.dailyStreak) embed.setFooter({ text: `🔥 Daily streak: ${p.dailyStreak}` });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'bestiary') {
      const target = interaction.options.getUser('user') || interaction.user;
      const { list, totalSpecies, caughtSpecies } = await getRecords(target.id);
      if (!list.length) return interaction.reply({ content: '📖 No fish recorded yet. Go `/fish catch`!', ephemeral: true });
      const byRarity = {};
      for (const r of list.filter(l => l.meta.rarity !== 'junk')) (byRarity[r.meta.rarity] ||= []).push(r);
      const pct = Math.round((caughtSpecies / totalSpecies) * 100);
      const embed = new EmbedBuilder().setColor(0xa855f7).setTitle(`📖 ${target.username}'s Bestiary`)
        .setDescription(`**${caughtSpecies}/${totalSpecies}** species discovered (**${pct}%**)${list.some(l => l.shiny) ? ` · ✨ ${list.filter(l => l.shiny).length} shiny` : ''}`);
      for (const tier of [...RANKS].reverse()) {
        const arr = byRarity[tier]; if (!arr) continue;
        const rm = RARITIES[tier];
        embed.addFields({ name: `${rm.emoji} ${rm.name}`, value: arr.sort((a, b) => b.bestWeight - a.bestWeight).slice(0, 12).map(r => `${r.meta.emoji} ${metaName(r.meta, r.shiny)} ×${n(r.timesCaught)}${r.bestWeight ? ` (best ${r.bestWeight}kg)` : ''}`).join('\n').slice(0, 1024) });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'aquarium') {
      const { list } = await getRecords(uid);
      const best = list.filter(i => i.meta.rarity !== 'junk').sort((a, b) => (b.shiny - a.shiny) || rank(b.meta.rarity) - rank(a.meta.rarity) || b.bestWeight - a.bestWeight).slice(0, 12);
      if (!best.length) return interaction.reply({ content: '🐠 Your aquarium is empty — go catch some prize fish!', ephemeral: true });
      const embed = new EmbedBuilder().setColor(0xa855f7).setTitle(`🐠 ${interaction.user.username}'s Aquarium`)
        .setDescription(best.map(i => `${i.meta.emoji} ${(RARITIES[i.meta.rarity] || RARITIES.common).emoji} **${metaName(i.meta, i.shiny)}** — best ${i.bestWeight} kg (×${n(i.timesCaught)})`).join('\n'))
        .setFooter({ text: 'Trophies are kept forever — selling never removes them.' });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'collect') {
      const r = await collectAutofisher(uid);
      return interaction.reply({ content: r.ok ? `🤖 Collected **${n(r.coins)}** ${COIN} from your auto-fisher.${r.capped ? ' _(it was full — collect more often!)_' : ''}\nBalance: **${n(r.balance)}** ${COIN}` : `❌ ${r.reason}`, ephemeral: !r.ok });
    }

    if (sub === 'weather') {
      const w = getWeather();
      const embed = new EmbedBuilder().setColor(0x60a5fa).setTitle(`${w.emoji} Fishing Weather: ${w.name}`)
        .setDescription(`${w.blurb}\n\nCatch luck this hour: **×${w.luck.toFixed(2)}**`)
        .setFooter({ text: 'Weather changes every hour and affects everyone.' });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'daily') {
      const r = await claimDaily(uid);
      return interaction.reply({ content: r.ok ? `📅 Daily claimed: **+${n(r.reward)}** ${COIN} (🔥 streak ${r.streak})\nBalance: **${n(r.balance)}** ${COIN}` : `❌ ${r.reason}`, ephemeral: !r.ok });
    }

    if (sub === 'quest') {
      const q = await getQuest(uid);
      const embed = new EmbedBuilder().setColor(0xef4444).setTitle('🎯 Today\'s Fishing Quest')
        .setDescription(`**${q.desc}**\nProgress: \`${n(q.progress)}/${n(q.target)}\`${q.claimed ? ' ✅ **Done!**' : ''}`)
        .setFooter({ text: `Reward: ${n(q.reward)} ${COIN}` });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'leaderboard') {
      const scope = interaction.options.getString('scope') || 'global';
      const by = interaction.options.getString('by') || 'coins';
      const medals = ['🥇', '🥈', '🥉'];
      if (scope === 'server') {
        const gb = by === 'catches' ? 'catches' : 'earned';
        const rows = await getGuildLeaderboard(interaction.guildId, gb, 10);
        if (!rows.length) return interaction.reply({ content: 'No anglers have fished in this server yet!', ephemeral: true });
        const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — ${gb === 'catches' ? `${n(r.catches)} caught` : `${n(r.earned)} ${COIN} earned`}`);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle(`🏆 Top Anglers — this server (${gb === 'catches' ? 'fish caught' : 'earned'})`).setDescription(lines.join('\n'))] });
      }
      const rows = await getLeaderboard(by, 10);
      if (!rows.length) return interaction.reply({ content: 'No anglers yet — be the first! `/fish catch`', ephemeral: true });
      const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — ${by === 'catches' ? `${n(r.catches)} caught` : `${n(r.coins)} ${COIN}`}`);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle(`🏆 Top Anglers — global (${by === 'catches' ? 'fish caught' : 'fishcoins'})`).setDescription(lines.join('\n'))] });
    }
  },
};

// resolve a sellone fish name → stored key (bucket)
async function resolveKeyForSell(userId, query) {
  const inv = await getInventory(userId);
  const q = String(query || '').toLowerCase().trim();
  const m = inv.find(i => i.name.toLowerCase() === q) || inv.find(i => i.name.toLowerCase().includes(q));
  return m ? m.key : '__none__';
}
// autocomplete returns the display name as the value (resolvers match by name)
function metaFor_name(x) { return x.name.replace(/^✨ /, ''); }

async function shopView(interaction) {
  const p = await getPlayer(interaction.user.id);
  const rodList = RODS.map(r => `${r.emoji} **${r.name}** — ${r.price ? `${n(r.price)} ${COIN}` : 'starter'}${p.ownedRods.includes(r.id) ? ' ✅' : ''} · max ${r.maxCatch}/cast, luck ×${r.luck}`);
  const baitList = BAITS.map(b => `${b.emoji} **${b.name}** — ${n(b.price)} ${COIN} · ${b.uses} casts, luck ×${b.luck}`);
  const locList = LOCATIONS.map(l => `${l.emoji} **${l.name}** — ${l.price ? `${n(l.price)} ${COIN}` : 'free'}${p.ownedLocations.includes(l.id) ? ' ✅' : ''}`);
  const petList = PETS.map(pt => `${pt.emoji} **${pt.name}** — ${n(pt.price)} ${COIN} · luck ×${pt.luck}, +${Math.round(pt.coinBonus * 100)}% sell${pt.cdReduce ? `, -${pt.cdReduce}ms cd` : ''}${p.ownedPets.includes(pt.id) ? ' ✅' : ''}`);
  const af = getAutofisher(p);
  const nextAf = AUTOFISHER[p.autofisherLevel];
  const embed = new EmbedBuilder().setColor(0x22c55e).setTitle('🛒 Fishing Shop')
    .setDescription(`Your balance: **${n(p.coins)}** ${COIN}`)
    .addFields(
      { name: '🎣 Rods — `/fish shop rod`', value: rodList.join('\n').slice(0, 1024) },
      { name: '🪱 Bait — `/fish shop bait`', value: baitList.join('\n').slice(0, 1024) },
      { name: '🐾 Pets — `/fish shop pet`', value: petList.join('\n').slice(0, 1024) },
      { name: '🗺️ Locations — `/fish shop location` / `/fish equip travel`', value: locList.join('\n').slice(0, 1024) },
      { name: '🤖 Auto-fisher — `/fish shop autofisher`', value: nextAf ? `Now: ${af.level ? `Lv ${af.level}` : 'none'} → **Lv ${nextAf.level}** for ${n(nextAf.price)} ${COIN} (${n(nextAf.perHour)} ${COIN}/hr)` : `Maxed (Lv ${af.level}) ✅` },
    );
  return interaction.reply({ embeds: [embed] });
}

async function tournamentStatus(interaction) {
  const t = await getActiveTournament(interaction.guildId);
  if (!t) return interaction.reply({ content: 'No tournament running here. An admin can start one with `/fish tournament start`.', ephemeral: true });
  const standings = await getTournamentStandings(t.id, 10);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = standings.length ? standings.map((s, i) => `${medals[i] || `**${i + 1}.**`} <@${s.userId}> — ${t.type === 'most' ? `${n(s.catches)} fish` : `${s.score} kg ${s.bestMeta ? `(${s.bestMeta.emoji} ${s.bestMeta.name})` : ''}`}`) : ['_No entries yet — be the first to `/fish catch`!_'];
  const ends = Math.floor(new Date(t.ends_at).getTime() / 1000);
  const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('🏁 Tournament Standings')
    .setDescription(`**${t.type === 'most' ? 'Most fish caught' : 'Biggest single catch'}** · Prize **${n(t.prize)}** ${COIN} · Ends <t:${ends}:R>\n\n${lines.join('\n')}`);
  return interaction.reply({ embeds: [embed] });
}
