/*
 * Cat Bot minigames — pure logic. Every function takes an injectable `rng` so payouts,
 * odds and edge cases are testable without Discord.
 *
 * All stakes are Cat Coins (core/catbot/economy.js). Nothing here touches the DB.
 */

// ── 1. Slots ─────────────────────────────────────────────────────────────────
export const SLOT_REELS = ['🐱', '🐟', '🧶', '🥛', '⭐', '💎'];
// Three of a kind pays this multiple of the bet; two of a kind pays 2×.
const SLOT_TRIPLE = { '🐱': 5, '🐟': 6, '🧶': 8, '🥛': 10, '⭐': 20, '💎': 50 };

export function playSlots(bet, rng = Math.random) {
  const reels = Array.from({ length: 3 }, () => SLOT_REELS[Math.floor(rng() * SLOT_REELS.length)]);
  const [a, b, c] = reels;

  let multiplier = 0;
  if (a === b && b === c) multiplier = SLOT_TRIPLE[a];
  else if (a === b || b === c || a === c) multiplier = 2;

  const payout = Math.floor(bet * multiplier);
  return { reels, multiplier, payout, net: payout - bet, won: payout > bet };
}

// ── 2. Coinflip ──────────────────────────────────────────────────────────────
export function playCoinflip(bet, call, rng = Math.random) {
  const result = rng() < 0.5 ? 'heads' : 'tails';
  const won = result === call;
  return { result, won, payout: won ? bet * 2 : 0, net: won ? bet : -bet };
}

// ── 3. Roulette ──────────────────────────────────────────────────────────────
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export function spinRoulette(bet, wager, rng = Math.random) {
  const number = Math.floor(rng() * 37); // 0–36; 0 is green
  const colour = number === 0 ? 'green' : (RED.has(number) ? 'red' : 'black');

  let multiplier = 0;
  if (wager === 'red' || wager === 'black') multiplier = colour === wager ? 2 : 0;
  else if (wager === 'green') multiplier = colour === 'green' ? 14 : 0;
  else if (wager === 'even') multiplier = number !== 0 && number % 2 === 0 ? 2 : 0;
  else if (wager === 'odd') multiplier = number % 2 === 1 ? 2 : 0;
  else if (/^\d+$/.test(String(wager))) multiplier = Number(wager) === number ? 36 : 0;

  const payout = bet * multiplier;
  return { number, colour, payout, net: payout - bet, won: payout > 0 };
}

// ── 4. Scratch card ──────────────────────────────────────────────────────────
const SCRATCH_SYMBOLS = ['🐾', '🐟', '🧶', '⭐', '💎', '🗑️'];
const SCRATCH_PRIZE = { '🐾': 2, '🐟': 3, '🧶': 5, '⭐': 12, '💎': 30, '🗑️': 0 };

export function playScratch(bet, rng = Math.random) {
  const grid = Array.from({ length: 9 }, () => SCRATCH_SYMBOLS[Math.floor(rng() * SCRATCH_SYMBOLS.length)]);
  const tally = new Map();
  for (const s of grid) tally.set(s, (tally.get(s) || 0) + 1);

  let multiplier = 0;
  for (const [symbol, n] of tally) {
    if (n >= 3) multiplier = Math.max(multiplier, SCRATCH_PRIZE[symbol] * (n - 2));
  }
  const payout = Math.floor(bet * multiplier);
  return { grid, multiplier, payout, net: payout - bet, won: payout > bet };
}

// ── 5. Rock paper scissors ───────────────────────────────────────────────────
export const RPS = ['rock', 'paper', 'scissors'];
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

export function playRps(bet, choice, rng = Math.random) {
  const bot = RPS[Math.floor(rng() * 3)];
  if (bot === choice) return { bot, outcome: 'draw', payout: bet, net: 0, won: false };
  const won = RPS_BEATS[choice] === bot;
  return { bot, outcome: won ? 'win' : 'loss', payout: won ? bet * 2 : 0, net: won ? bet : -bet, won };
}

// ── 6. Blackjack ─────────────────────────────────────────────────────────────
const CARD_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

export function newDeck(rng = Math.random) {
  const deck = [];
  for (const s of SUITS) for (const r of CARD_RANKS) deck.push(`${r}${s}`);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Aces count 11 until that would bust, then 1. */
export function handValue(cards) {
  let total = 0, aces = 0;
  for (const card of cards) {
    const rank = card.slice(0, -1);
    if (rank === 'A') { aces++; total += 11; }
    else if (['J', 'Q', 'K', '10'].includes(rank)) total += 10;
    else total += Number(rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

export function startBlackjack(bet, rng = Math.random) {
  const deck = newDeck(rng);
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];
  return { deck, player, dealer, bet, done: false };
}

export function blackjackHit(state) {
  const player = [...state.player, state.deck.pop()];
  const value = handValue(player);
  if (value > 21) return settleBlackjack({ ...state, player }, true);
  return { ...state, player };
}

/** Dealer draws to 17 (standing on soft 17). */
export function blackjackStand(state) {
  const deck = [...state.deck];
  const dealer = [...state.dealer];
  while (handValue(dealer) < 17) dealer.push(deck.pop());
  return settleBlackjack({ ...state, deck, dealer }, false);
}

function settleBlackjack(state, playerBusted) {
  const p = handValue(state.player);
  const d = handValue(state.dealer);
  let outcome;
  if (playerBusted || p > 21) outcome = 'bust';
  else if (d > 21) outcome = 'dealer-bust';
  else if (p > d) outcome = 'win';
  else if (p < d) outcome = 'loss';
  else outcome = 'push';

  const won = outcome === 'win' || outcome === 'dealer-bust';
  const blackjack = won && p === 21 && state.player.length === 2;
  const payout = blackjack ? Math.floor(state.bet * 2.5) : (won ? state.bet * 2 : (outcome === 'push' ? state.bet : 0));
  return { ...state, done: true, outcome, playerValue: p, dealerValue: d, payout, net: payout - state.bet, won, blackjack };
}

// ── 7. Pig (press-your-luck dice) ────────────────────────────────────────────
export function pigRoll(pot, rng = Math.random) {
  const die = 1 + Math.floor(rng() * 6);
  if (die === 1) return { die, pot: 0, busted: true };
  return { die, pot: pot + die, busted: false };
}
/** Banking pays the pot as a multiple of the bet: 10 pot ≈ 1× bet. */
export function pigPayout(bet, pot) {
  return Math.floor(bet * (pot / 10));
}

// ── 8. Tic-tac-toe (vs the bot) ──────────────────────────────────────────────
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export function tttWinner(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  return board.every(Boolean) ? 'draw' : null;
}

/** Perfect play via minimax, so the bot never loses — a draw is the best you can do. */
export function tttBotMove(board, bot = 'O', human = 'X') {
  const best = minimax(board, bot, bot, human);
  return best.index;
}

function minimax(board, turn, bot, human, depth = 0) {
  const winner = tttWinner(board);
  if (winner === bot) return { score: 10 - depth };
  if (winner === human) return { score: depth - 10 };
  if (winner === 'draw') return { score: 0 };

  const moves = [];
  for (let i = 0; i < 9; i++) {
    if (board[i]) continue;
    const next = [...board];
    next[i] = turn;
    const { score } = minimax(next, turn === bot ? human : bot, bot, human, depth + 1);
    moves.push({ index: i, score });
  }
  return turn === bot
    ? moves.reduce((a, b) => (b.score > a.score ? b : a))
    : moves.reduce((a, b) => (b.score < a.score ? b : a));
}

// ── 9. Fishing ───────────────────────────────────────────────────────────────
export const FISH = Object.freeze([
  { name: 'Boot', emoji: '🥾', weight: 200, coins: 1 },
  { name: 'Sardine', emoji: '🐟', weight: 400, coins: 8 },
  { name: 'Salmon', emoji: '🐠', weight: 250, coins: 20 },
  { name: 'Pufferfish', emoji: '🐡', weight: 90, coins: 45 },
  { name: 'Squid', emoji: '🦑', weight: 40, coins: 90 },
  { name: 'Octopus', emoji: '🐙', weight: 15, coins: 200 },
  { name: 'Whale', emoji: '🐋', weight: 4, coins: 600 },
  { name: 'Mermaid', emoji: '🧜', weight: 1, coins: 2500 },
]);
export const FISH_COOLDOWN_MS = 60_000;

export function castLine(rng = Math.random) {
  const total = FISH.reduce((s, f) => s + f.weight, 0);
  let r = rng() * total;
  for (const fish of FISH) {
    r -= fish.weight;
    if (r < 0) return fish;
  }
  return FISH[0];
}

// ── 10. Cookie (clicker) ─────────────────────────────────────────────────────
export function cookieClick(bakeryLevel, rng = Math.random) {
  const base = 1 + bakeryLevel;
  const crit = rng() < 0.05;
  return { cookies: crit ? base * 10 : base, crit };
}

// ── 11. Bakery (idle generator) ──────────────────────────────────────────────
export const BAKERY_MAX_LEVEL = 10;
export const BAKERY_TICK_MS = 60_000;
export function bakeryCost(level) { return 500 * Math.pow(2, level); }
export function bakeryRate(level) { return level * 5; } // cookies per minute

/** Cookies accrued since `sinceMs`, capped at 12 hours of idle time. */
export function bakeryCollect(level, sinceMs, nowMs = Date.now()) {
  if (level <= 0 || !sinceMs) return 0;
  const elapsed = Math.min(nowMs - sinceMs, 12 * 3600_000);
  return Math.floor((elapsed / BAKERY_TICK_MS) * bakeryRate(level));
}

// ── 12. Chaos ────────────────────────────────────────────────────────────────
export const CHAOS_OUTCOMES = Object.freeze([
  { id: 'nothing', weight: 300, text: 'Absolutely nothing happens.', multiplier: 1 },
  { id: 'small', weight: 250, text: 'A cat drops a coin at your feet.', multiplier: 1.2 },
  { id: 'refund', weight: 150, text: 'The cat looks unimpressed and gives it back.', multiplier: 1 },
  { id: 'loss', weight: 200, text: 'A cat knocks your coins off the table.', multiplier: 0 },
  { id: 'double', weight: 80, text: 'The cats approve. Your coins double.', multiplier: 2 },
  { id: 'jackpot', weight: 18, text: 'THE CATS ASCEND. Ten times your stake.', multiplier: 10 },
  { id: 'void', weight: 2, text: 'A void cat devours your entire wallet.', multiplier: 0, voidsWallet: true },
]);

export function rollChaos(bet, rng = Math.random) {
  const total = CHAOS_OUTCOMES.reduce((s, o) => s + o.weight, 0);
  let r = rng() * total;
  for (const outcome of CHAOS_OUTCOMES) {
    r -= outcome.weight;
    if (r < 0) {
      const payout = Math.floor(bet * outcome.multiplier);
      return { ...outcome, payout, net: payout - bet, won: payout > bet };
    }
  }
  return { ...CHAOS_OUTCOMES[0], payout: bet, net: 0, won: false };
}

export const GAMES = Object.freeze([
  'slots', 'coinflip', 'roulette', 'scratch', 'rps', 'blackjack',
  'pig', 'tictactoe', 'fish', 'cookie', 'bakery', 'chaos',
]);
