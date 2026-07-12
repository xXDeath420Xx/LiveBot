/*
 * Cat Bot minigames — the Discord layer.
 *
 * Pure rules live in minigames.js; this file stakes coins, renders, and settles. The three
 * stateful games (blackjack, pig, tic-tac-toe) keep their table in memory keyed by the
 * message id, and their buttons are ignored once the table has expired — so a restart
 * never leaves a half-played hand that could pay out twice.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';
import {
  getWallet, addCoins, spendCoins, recordGame, getGameProfile, updateGameProfile, bumpGameProfile,
} from './economy.js';
import { advance as advanceQuests, questLine } from './battlepass.js';
import {
  playSlots, playCoinflip, spinRoulette, playScratch, playRps, rollChaos,
  startBlackjack, blackjackHit, blackjackStand, handValue,
  pigRoll, pigPayout, tttWinner, tttBotMove,
  castLine, FISH, FISH_COOLDOWN_MS, cookieClick,
  bakeryCost, bakeryRate, bakeryCollect, BAKERY_MAX_LEVEL,
} from './minigames.js';

export const COLOR = 0xF2A65A;
export const MIN_BET = 10;
export const MAX_BET = 100_000;
/** Staked when someone just types `/cat game slots` or `!slots` with no number. */
export const DEFAULT_BET = 50;

/** Anything that isn't a usable whole number of coins becomes the default stake. */
export function normalizeBet(bet) {
  const n = Number(bet);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BET;
}
const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const SESSION_TTL_MS = 5 * 60 * 1000;

// ── Sessions ─────────────────────────────────────────────────────────────────
// messageId -> { userId, guildId, game, state, timer }
const sessions = new Map();

function openSession(messageId, session) {
  const timer = setTimeout(() => sessions.delete(messageId), SESSION_TTL_MS);
  if (timer.unref) timer.unref();
  sessions.set(messageId, { ...session, timer });
}

function closeSession(messageId) {
  const s = sessions.get(messageId);
  if (s?.timer) clearTimeout(s.timer);
  sessions.delete(messageId);
}

/** The session, but only for the player it belongs to. */
function claimSession(interaction, game) {
  const s = sessions.get(interaction.message.id);
  if (!s || s.game !== game) return null;
  if (s.userId !== interaction.user.id) return 'not-yours';
  return s;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Take the stake up front. Returns null when they can't cover it — the atomic
 * `coins >= ?` guard means two simultaneous bets can't both spend the same balance.
 */
async function stake(interaction, bet) {
  // Slash commands enforce the range, but `!slots` through the prefix bridge can arrive
  // with no bet at all.
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET) {
    await interaction.reply({ content: `Bets run from **${MIN_BET}** to **${MAX_BET.toLocaleString()}** Cat Coins.`, ...EPHEMERAL });
    return false;
  }
  if (!await spendCoins(interaction.guildId, interaction.user.id, bet)) {
    const { coins } = await getWallet(interaction.guildId, interaction.user.id);
    await interaction.reply({ content: `🪙 You only have **${coins.toLocaleString()}** Cat Coins.`, ...EPHEMERAL });
    return false;
  }
  return true;
}

/** Pay out, record the play, and advance the game quests. Returns the quest line. */
async function settle(guildId, userId, game, { bet, payout, won }) {
  if (payout > 0) await addCoins(guildId, userId, payout);
  await recordGame(guildId, userId, game, { won, net: payout - bet });
  return questLine(await advanceQuests(guildId, userId, [
    ['game_play', 1],
    ...(won ? [['game_win', 1]] : []),
  ]));
}

async function balanceFooter(guildId, userId) {
  const { coins } = await getWallet(guildId, userId);
  return { text: `Balance: ${coins.toLocaleString()} 🪙` };
}

const resultColour = net => (net > 0 ? 0x57F287 : net < 0 ? 0xED4245 : COLOR);
const sign = n => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());

// ── Instant games ────────────────────────────────────────────────────────────

export async function runSlots(interaction, bet) {
  if (!await stake(interaction, bet)) return;
  const r = playSlots(bet);
  const quests = await settle(interaction.guildId, interaction.user.id, 'slots', { bet, payout: r.payout, won: r.won });

  const embed = new EmbedBuilder().setColor(resultColour(r.net))
    .setTitle('🎰 Slots')
    .setDescription(`# ${r.reels.join(' │ ')}\n${r.won ? `**${r.multiplier}×** — you win **${r.payout.toLocaleString()}** 🪙` : 'No match.'}\n**${sign(r.net)}** 🪙${quests}`)
    .setFooter(await balanceFooter(interaction.guildId, interaction.user.id));
  return interaction.reply({ embeds: [embed] });
}

export async function runCoinflip(interaction, bet, call) {
  if (!await stake(interaction, bet)) return;
  const r = playCoinflip(bet, call);
  const quests = await settle(interaction.guildId, interaction.user.id, 'coinflip', { bet, payout: r.payout, won: r.won });

  const embed = new EmbedBuilder().setColor(resultColour(r.net))
    .setTitle('🪙 Coinflip')
    .setDescription(`It landed **${r.result}**. You called **${call}**.\n${r.won ? 'You win!' : 'You lose.'} **${sign(r.net)}** 🪙${quests}`)
    .setFooter(await balanceFooter(interaction.guildId, interaction.user.id));
  return interaction.reply({ embeds: [embed] });
}

export async function runRoulette(interaction, bet, wager) {
  if (!await stake(interaction, bet)) return;
  const r = spinRoulette(bet, wager);
  const quests = await settle(interaction.guildId, interaction.user.id, 'roulette', { bet, payout: r.payout, won: r.won });

  const dot = { red: '🔴', black: '⚫', green: '🟢' }[r.colour];
  const embed = new EmbedBuilder().setColor(resultColour(r.net))
    .setTitle('🎡 Roulette')
    .setDescription(`The ball lands on ${dot} **${r.number}**. You bet **${wager}**.\n${r.won ? `You win **${r.payout.toLocaleString()}** 🪙` : 'House takes it.'}\n**${sign(r.net)}** 🪙${quests}`)
    .setFooter(await balanceFooter(interaction.guildId, interaction.user.id));
  return interaction.reply({ embeds: [embed] });
}

export async function runScratch(interaction, bet) {
  if (!await stake(interaction, bet)) return;
  const r = playScratch(bet);
  const quests = await settle(interaction.guildId, interaction.user.id, 'scratch', { bet, payout: r.payout, won: r.won });

  const grid = [0, 3, 6].map(i => r.grid.slice(i, i + 3).join(' ')).join('\n');
  const embed = new EmbedBuilder().setColor(resultColour(r.net))
    .setTitle('🎫 Scratch Card')
    .setDescription(`# ${grid.split('\n').join('\n# ')}\n${r.won ? `Three or more matched — **${r.multiplier}×**!` : 'Nothing matched three times.'}\n**${sign(r.net)}** 🪙${quests}`)
    .setFooter(await balanceFooter(interaction.guildId, interaction.user.id));
  return interaction.reply({ embeds: [embed] });
}

export async function runRps(interaction, bet, choice) {
  if (!await stake(interaction, bet)) return;
  const r = playRps(bet, choice);
  // A draw returns the stake, so it isn't a win but it isn't a loss either.
  const quests = await settle(interaction.guildId, interaction.user.id, 'rps', { bet, payout: r.payout, won: r.won });

  const icon = { rock: '🪨', paper: '📄', scissors: '✂️' };
  const embed = new EmbedBuilder().setColor(resultColour(r.net))
    .setTitle('✂️ Rock Paper Scissors')
    .setDescription(`You ${icon[choice]} **${choice}** vs ${icon[r.bot]} **${r.bot}** 🐱\n**${r.outcome === 'draw' ? "It's a draw — stake returned." : (r.won ? 'You win!' : 'You lose.')}** ${sign(r.net)} 🪙${quests}`)
    .setFooter(await balanceFooter(interaction.guildId, interaction.user.id));
  return interaction.reply({ embeds: [embed] });
}

export async function runChaos(interaction, bet) {
  if (!await stake(interaction, bet)) return;
  const r = rollChaos(bet);

  let extra = '';
  if (r.voidsWallet) {
    // The stake is already gone; take whatever else is left.
    const { coins } = await getWallet(interaction.guildId, interaction.user.id);
    if (coins > 0) {
      await addCoins(interaction.guildId, interaction.user.id, -coins);
      extra = `\n💀 It took **${coins.toLocaleString()}** more coins with it.`;
    }
  }
  const quests = await settle(interaction.guildId, interaction.user.id, 'chaos', { bet, payout: r.payout, won: r.won });

  const embed = new EmbedBuilder().setColor(resultColour(r.net))
    .setTitle('🌀 Chaos')
    .setDescription(`${r.text}\n**${sign(r.net)}** 🪙${extra}${quests}`)
    .setFooter(await balanceFooter(interaction.guildId, interaction.user.id));
  return interaction.reply({ embeds: [embed] });
}

// ── Fishing ──────────────────────────────────────────────────────────────────

export async function runFish(interaction) {
  const guildId = interaction.guildId, userId = interaction.user.id;
  const profile = await getGameProfile(guildId, userId);
  const since = Date.now() - Number(profile.last_fish_at || 0);
  if (since < FISH_COOLDOWN_MS) {
    const ready = Math.round((Date.now() + (FISH_COOLDOWN_MS - since)) / 1000);
    return interaction.reply({ content: `🎣 The fish have scattered. Cast again <t:${ready}:R>.`, ...EPHEMERAL });
  }

  const fish = castLine();
  await updateGameProfile(guildId, userId, { last_fish_at: Date.now() });
  await bumpGameProfile(guildId, userId, 'fish_caught', 1);
  await addCoins(guildId, userId, fish.coins);

  let record = '';
  const bestCoins = FISH.find(f => f.name === profile.best_fish)?.coins ?? 0;
  if (fish.coins > bestCoins) {
    await updateGameProfile(guildId, userId, { best_fish: fish.name });
    if (bestCoins > 0) record = '\n🏅 A new personal best!';
  }
  const quests = await settle(guildId, userId, 'fish', { bet: 0, payout: fish.coins, won: fish.coins > 1 });

  const embed = new EmbedBuilder().setColor(COLOR)
    .setTitle('🎣 Fishing')
    .setDescription(`You reel in a ${fish.emoji} **${fish.name}** — worth **${fish.coins.toLocaleString()}** 🪙${record}${quests}`)
    .setFooter(await balanceFooter(guildId, userId));
  return interaction.reply({ embeds: [embed] });
}

// ── Cookie + bakery ──────────────────────────────────────────────────────────

export async function runCookie(interaction) {
  const guildId = interaction.guildId, userId = interaction.user.id;
  const profile = await getGameProfile(guildId, userId);
  const { cookies, crit } = cookieClick(Number(profile.bakery_level));
  await bumpGameProfile(guildId, userId, 'cookies', cookies);
  const quests = await settle(guildId, userId, 'cookie', { bet: 0, payout: 0, won: crit });

  const total = Number(profile.cookies) + cookies;
  return interaction.reply({
    content: `🍪 ${crit ? '**CRITICAL BAKE!** ' : ''}+**${cookies}** cookies. You have **${total.toLocaleString()}**.${quests}`,
  });
}

/** `action` is 'view' | 'collect' | 'upgrade'. Cookies convert 1:1 to coins on sale. */
export async function runBakery(interaction, action) {
  const guildId = interaction.guildId, userId = interaction.user.id;
  const profile = await getGameProfile(guildId, userId);
  const level = Number(profile.bakery_level);

  if (action === 'upgrade') {
    if (level >= BAKERY_MAX_LEVEL) {
      return interaction.reply({ content: `🏭 Your bakery is already at level **${BAKERY_MAX_LEVEL}**.`, ...EPHEMERAL });
    }
    const cost = bakeryCost(level);
    if (!await spendCoins(guildId, userId, cost)) {
      const { coins } = await getWallet(guildId, userId);
      return interaction.reply({
        content: `🏭 Upgrading to level **${level + 1}** costs **${cost.toLocaleString()}** 🪙 — you have **${coins.toLocaleString()}**.`,
        ...EPHEMERAL,
      });
    }
    // Bank what the old level produced before the rate changes.
    const pending = bakeryCollect(level, Number(profile.bakery_at));
    await updateGameProfile(guildId, userId, {
      bakery_level: level + 1,
      bakery_at: Date.now(),
      cookies: Number(profile.cookies) + pending,
    });
    return interaction.reply({
      content: `🏭 Bakery upgraded to level **${level + 1}** — **${bakeryRate(level + 1)}** cookies/min.` +
        (pending ? ` Banked **${pending.toLocaleString()}** cookies from the old line.` : ''),
    });
  }

  if (action === 'collect') {
    if (!level) return interaction.reply({ content: '🏭 You have no bakery yet. `/cat game bakery action:upgrade`.', ...EPHEMERAL });
    const pending = bakeryCollect(level, Number(profile.bakery_at));
    if (!pending) return interaction.reply({ content: '🏭 Nothing baked yet. Come back in a minute.', ...EPHEMERAL });
    // Sell the cookies as they come out of the oven.
    await updateGameProfile(guildId, userId, { bakery_at: Date.now() });
    await bumpGameProfile(guildId, userId, 'cookies', pending);
    await addCoins(guildId, userId, pending);
    return interaction.reply({
      content: `🏭 Collected **${pending.toLocaleString()}** cookies and sold them for **${pending.toLocaleString()}** 🪙.`,
    });
  }

  const pending = bakeryCollect(level, Number(profile.bakery_at));
  const embed = new EmbedBuilder().setColor(COLOR)
    .setTitle('🏭 Your bakery')
    .setDescription(level
      ? `Level **${level}** — **${bakeryRate(level)}** cookies/min.\nWaiting to collect: **${pending.toLocaleString()}** 🍪 *(idle caps at 12h)*`
      : 'You have no bakery. Build one with `action:upgrade`.')
    .addFields({
      name: level >= BAKERY_MAX_LEVEL ? 'Maxed' : `Upgrade to level ${level + 1}`,
      value: level >= BAKERY_MAX_LEVEL ? '—' : `**${bakeryCost(level).toLocaleString()}** 🪙`,
    })
    .setFooter(await balanceFooter(guildId, userId));
  return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

/**
 * Key a session on the message the buttons will arrive on. If we can't resolve that
 * message the table can never be played, so hand the stake straight back.
 */
async function attachSession(interaction, session, bet) {
  const msg = await interaction.fetchReply().catch(() => null);
  if (!msg?.id) {
    await addCoins(interaction.guildId, interaction.user.id, bet);
    await interaction.followUp({ content: 'Could not open the table — your stake was returned.', ...EPHEMERAL }).catch(() => {});
    return false;
  }
  openSession(msg.id, { userId: interaction.user.id, guildId: interaction.guildId, ...session });
  return true;
}

// ── Blackjack ────────────────────────────────────────────────────────────────

function blackjackEmbed(state, { reveal }) {
  const dealer = reveal ? state.dealer.join(' ') : `${state.dealer[0]} ❔`;
  const dealerValue = reveal ? ` (**${handValue(state.dealer)}**)` : '';
  const embed = new EmbedBuilder().setColor(state.done ? resultColour(state.net) : COLOR)
    .setTitle('🃏 Blackjack')
    .addFields(
      { name: 'Your hand', value: `${state.player.join(' ')} (**${handValue(state.player)}**)` },
      { name: 'Dealer', value: `${dealer}${dealerValue}` },
    );
  if (state.done) {
    const verdict = {
      bust: 'You busted.', 'dealer-bust': 'Dealer busted — you win!',
      win: 'You win!', loss: 'Dealer wins.', push: 'Push — stake returned.',
    }[state.outcome];
    embed.setDescription(`${state.blackjack ? '**BLACKJACK!** ' : ''}${verdict}\n**${sign(state.net)}** 🪙`);
  } else {
    embed.setDescription(`Bet: **${state.bet.toLocaleString()}** 🪙`);
  }
  return embed;
}

const bjRow = (disabled = false) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('cbg:bj:hit').setLabel('Hit').setStyle(ButtonStyle.Primary).setDisabled(disabled),
  new ButtonBuilder().setCustomId('cbg:bj:stand').setLabel('Stand').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
);

export async function runBlackjack(interaction, bet) {
  if (!await stake(interaction, bet)) return;
  const state = startBlackjack(bet);

  // A natural 21 pays immediately — there's nothing to decide.
  if (handValue(state.player) === 21) {
    const final = blackjackStand(state);
    const quests = await settle(interaction.guildId, interaction.user.id, 'blackjack',
      { bet, payout: final.payout, won: final.won });
    const embed = blackjackEmbed(final, { reveal: true });
    embed.setDescription(`${embed.data.description}${quests}`);
    return interaction.reply({ embeds: [embed] });
  }

  await interaction.reply({ embeds: [blackjackEmbed(state, { reveal: false })], components: [bjRow()] });
  await attachSession(interaction, { game: 'blackjack', state }, bet);
}

export async function handleBlackjackButton(interaction, action) {
  const session = claimSession(interaction, 'blackjack');
  if (!session) return interaction.reply({ content: 'That hand has already been settled.', ...EPHEMERAL });
  if (session === 'not-yours') return interaction.reply({ content: "That's not your hand.", ...EPHEMERAL });

  await interaction.deferUpdate().catch(() => {});
  const next = action === 'hit' ? blackjackHit(session.state) : blackjackStand(session.state);

  if (!next.done) {
    session.state = next;
    return interaction.editReply({ embeds: [blackjackEmbed(next, { reveal: false })], components: [bjRow()] });
  }

  closeSession(interaction.message.id);
  const quests = await settle(session.guildId, session.userId, 'blackjack',
    { bet: next.bet, payout: next.payout, won: next.won });
  const embed = blackjackEmbed(next, { reveal: true });
  embed.setDescription(`${embed.data.description}${quests}`);
  embed.setFooter(await balanceFooter(session.guildId, session.userId));
  return interaction.editReply({ embeds: [embed], components: [bjRow(true)] });
}

// ── Pig ──────────────────────────────────────────────────────────────────────

const pigRow = (disabled = false) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('cbg:pig:roll').setLabel('Roll').setStyle(ButtonStyle.Primary).setDisabled(disabled),
  new ButtonBuilder().setCustomId('cbg:pig:bank').setLabel('Bank').setStyle(ButtonStyle.Success).setDisabled(disabled),
);

function pigEmbed(state, extra = '') {
  return new EmbedBuilder().setColor(COLOR)
    .setTitle('🐷 Pig')
    .setDescription(
      `Bet **${state.bet.toLocaleString()}** 🪙 · pot **${state.pot}**\n` +
      `Banking now pays **${pigPayout(state.bet, state.pot).toLocaleString()}** 🪙.\n` +
      'Roll a **1** and you lose everything.' + (extra ? `\n\n${extra}` : ''));
}

export async function runPig(interaction, bet) {
  if (!await stake(interaction, bet)) return;
  const state = { bet, pot: 0 };
  await interaction.reply({ embeds: [pigEmbed(state)], components: [pigRow()] });
  await attachSession(interaction, { game: 'pig', state }, bet);
}

export async function handlePigButton(interaction, action) {
  const session = claimSession(interaction, 'pig');
  if (!session) return interaction.reply({ content: 'That game has already ended.', ...EPHEMERAL });
  if (session === 'not-yours') return interaction.reply({ content: "That's not your game.", ...EPHEMERAL });

  await interaction.deferUpdate().catch(() => {});
  const { bet } = session.state;

  if (action === 'roll') {
    const r = pigRoll(session.state.pot);
    if (!r.busted) {
      session.state.pot = r.pot;
      return interaction.editReply({ embeds: [pigEmbed(session.state, `🎲 You rolled a **${r.die}**.`)], components: [pigRow()] });
    }
    closeSession(interaction.message.id);
    const quests = await settle(session.guildId, session.userId, 'pig', { bet, payout: 0, won: false });
    const embed = new EmbedBuilder().setColor(0xED4245).setTitle('🐷 Pig')
      .setDescription(`🎲 You rolled a **1**. The pig eats it all.\n**${sign(-bet)}** 🪙${quests}`)
      .setFooter(await balanceFooter(session.guildId, session.userId));
    return interaction.editReply({ embeds: [embed], components: [pigRow(true)] });
  }

  // Bank.
  closeSession(interaction.message.id);
  const payout = pigPayout(bet, session.state.pot);
  const won = payout > bet;
  const quests = await settle(session.guildId, session.userId, 'pig', { bet, payout, won });
  if (session.state.pot > Number((await getGameProfile(session.guildId, session.userId)).best_pig)) {
    await updateGameProfile(session.guildId, session.userId, { best_pig: session.state.pot });
  }
  const embed = new EmbedBuilder().setColor(resultColour(payout - bet)).setTitle('🐷 Pig')
    .setDescription(`🏦 You bank a pot of **${session.state.pot}** for **${payout.toLocaleString()}** 🪙.\n**${sign(payout - bet)}** 🪙${quests}`)
    .setFooter(await balanceFooter(session.guildId, session.userId));
  return interaction.editReply({ embeds: [embed], components: [pigRow(true)] });
}

// ── Tic-tac-toe ──────────────────────────────────────────────────────────────

const MARK = { X: '❌', O: '⭕' };

function tttRows(board, disabled = false) {
  return [0, 3, 6].map(start => new ActionRowBuilder().addComponents(
    ...board.slice(start, start + 3).map((cell, i) => {
      const idx = start + i;
      return new ButtonBuilder()
        .setCustomId(`cbg:ttt:${idx}`)
        .setLabel(cell ? MARK[cell] : '​')
        .setStyle(cell === 'X' ? ButtonStyle.Primary : cell === 'O' ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(disabled || !!cell);
    })));
}

function tttEmbed(bet, body, net = null) {
  return new EmbedBuilder().setColor(net === null ? COLOR : resultColour(net))
    .setTitle('⭕ Tic-Tac-Toe')
    .setDescription(`Bet **${bet.toLocaleString()}** 🪙 — you are ❌.\n${body}`);
}

export async function runTicTacToe(interaction, bet) {
  if (!await stake(interaction, bet)) return;
  const board = Array(9).fill(null);
  await interaction.reply({
    embeds: [tttEmbed(bet, 'The cat plays perfectly. A **draw** returns your stake; a **win** is impossible… probably.')],
    components: tttRows(board),
  });
  await attachSession(interaction, { game: 'tictactoe', state: { board, bet } }, bet);
}

export async function handleTicTacToeButton(interaction, cellRaw) {
  const session = claimSession(interaction, 'tictactoe');
  if (!session) return interaction.reply({ content: 'That game has already ended.', ...EPHEMERAL });
  if (session === 'not-yours') return interaction.reply({ content: "That's not your game.", ...EPHEMERAL });

  const cell = Number(cellRaw);
  const { board, bet } = session.state;
  if (!Number.isInteger(cell) || cell < 0 || cell > 8 || board[cell]) {
    return interaction.reply({ content: 'That square is taken.', ...EPHEMERAL });
  }

  await interaction.deferUpdate().catch(() => {});
  board[cell] = 'X';

  let winner = tttWinner(board);
  if (!winner) {
    board[tttBotMove(board)] = 'O';
    winner = tttWinner(board);
  }
  if (!winner) return interaction.editReply({ embeds: [tttEmbed(bet, 'Your move.')], components: tttRows(board) });

  closeSession(interaction.message.id);
  // A draw refunds; a loss keeps the stake. Perfect play means 'X' shouldn't happen.
  const payout = winner === 'X' ? bet * 3 : (winner === 'draw' ? bet : 0);
  const quests = await settle(session.guildId, session.userId, 'tictactoe', { bet, payout, won: winner === 'X' });

  const body = {
    X: '🎉 You **beat** the cat. That should not be possible.',
    O: '😼 The cat wins.',
    draw: '🤝 A draw — stake returned.',
  }[winner];
  const embed = tttEmbed(bet, `${body}\n**${sign(payout - bet)}** 🪙${quests}`, payout - bet)
    .setFooter(await balanceFooter(session.guildId, session.userId));
  return interaction.editReply({ embeds: [embed], components: tttRows(board, true) });
}

// ── Button router ────────────────────────────────────────────────────────────

/** customId: `cbg:<game>:<action>` */
export async function handleCatGameButton(interaction) {
  try {
    const [, game, action] = interaction.customId.split(':');
    if (game === 'bj') return handleBlackjackButton(interaction, action);
    if (game === 'pig') return handlePigButton(interaction, action);
    if (game === 'ttt') return handleTicTacToeButton(interaction, action);
  } catch (err) {
    logger.error(`[CatBot] game button failed: ${err.message}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong with that game.', ...EPHEMERAL }).catch(() => {});
    }
  }
}

export const _internals = { sessions, openSession, closeSession };
