// OwO's *native* prefix: `owo` itself, with no space required.
//
// Upstream OwO (src/commands/command.js `checkPrefix`) does literally:
//     content.slice(prefix.length).trim().split(/ +/g)
// so `owoh`, `owo h`, `owo   hunt` and `owolb all` are all the same thing — the
// command is just "whatever follows `owo`". That's why people type `owoh`.
//
// Two more upstream behaviors we copy exactly:
//   • Any message *containing* "owo" or "uwu" silently earns a point (10s cooldown).
//   • `owo` alone, or `owo <unknown>`, replies with NOTHING — it only counts a point.
//     This matters: without it, "owo that's cute" would spam a help message.
//
// This runs alongside the guild's normal `!` prefix (core/prefix-command-manager.js),
// which already exposes `!owo <sub>`; both funnel into handlers/owo-prefix.js.
import { MessageContextAdapter } from './message-context-adapter.js';
import { isEnabled } from './owo/manager.js';
import { claimPointSlot, addPoint } from './owo/points.js';
import logger from '../utils/logger.js';

const PREFIX = 'owo';
// `uwu` earns points but is NOT a command prefix — matching upstream.
const POINTS_RE = /owo|uwu/i;

// alias -> the subcommand handleOwoRouter understands.
// Upstream alias lists are preserved where we have an equivalent command.
const ALIASES = new Map(Object.entries({
  // zoo / hunting
  hunt: 'hunt', h: 'hunt', catch: 'hunt',
  zoo: 'zoo', z: 'zoo',
  sell: 'sell',
  sacrifice: 'sacrifice', sac: 'sacrifice', sc: 'sacrifice', essence: 'sacrifice', butcher: 'sacrifice',
  catalog: 'catalog', catalogue: 'catalog', owodex: 'catalog', od: 'catalog', dex: 'catalog', d: 'catalog',
  // battle
  battle: 'battle', b: 'battle', fight: 'battle',
  team: 'team', squad: 'team', tm: 'team',
  'team-add': 'team-add', teamadd: 'team-add',
  weapon: 'weapon', w: 'weapon', weapons: 'weapon', wep: 'weapon',
  inventory: 'weapon', inv: 'weapon', // closest analogue we have
  equip: 'equip',
  crate: 'crate', weaponcrate: 'crate', wc: 'crate',
  // gems & lootboxes. `use` activates a gem and `lb` opens a lootbox, as upstream — NOT equip
  // and NOT the leaderboard. `owo top` still reaches the leaderboard, which is upstream's name
  // for it, so nothing becomes unreachable.
  lootbox: 'lootbox', lb: 'lootbox', lootboxes: 'lootbox', box: 'lootbox',
  gem: 'gems', gems: 'gems',
  use: 'use',
  // economy
  balance: 'balance', bal: 'balance', money: 'balance', cowoncy: 'balance',
  currency: 'balance', cash: 'balance', credit: 'balance',
  daily: 'daily',
  give: 'give', send: 'give', gift: 'give', trade: 'give', tr: 'give',
  quest: 'quest', quests: 'quest', q: 'quest',
  // social / meta
  stats: 'stats', profile: 'stats', me: 'stats', my: 'stats',
  level: 'stats', lvl: 'stats', levels: 'stats', xp: 'stats',
  leaderboard: 'leaderboard', top: 'leaderboard', rank: 'leaderboard', ranking: 'leaderboard',
  owoify: 'owoify', ify: 'owoify',
  count: 'count', points: 'count', owocount: 'count',
  help: 'help', commands: 'help',
}));

const MENTION_RE = /^<@!?(\d+)>$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
// Amounts are small; a 17+ digit token is an id, not a quantity.
const AMOUNT_RE = /^\d{1,15}$/;

/**
 * Spread the remaining tokens across every option name the OwO handlers read,
 * so `readArg(ctx, 'pos', 'rank')`-style lookups resolve without a slash command.
 */
function buildArgs(subcommand, rest) {
  const t0 = rest[0] ?? null;
  const t1 = rest[1] ?? null;
  const mention = rest.find(t => MENTION_RE.test(t) || SNOWFLAKE_RE.test(t)) ?? null;
  const amount = rest.find(t => AMOUNT_RE.test(t)) ?? null;
  const text = rest.join(' ') || null;

  return {
    subcommand,
    // positional-ish names
    rank: t0, animal: t0, action: t0, pos: t0,
    slot: t1, uwid: t1,
    // user-ish names
    user: mention, opponent: mention,
    // number-ish names
    amount, count: amount, id: amount, pgid: amount,
    text,
  };
}

/**
 * Pure parse of a raw message body.
 * @returns {{points: boolean, subcommand: string|null, rest: string[]}}
 *   points     — does this message earn an owo point?
 *   subcommand — the OwO command to run, or null to stay silent.
 */
export function parseOwo(content) {
  const lower = String(content || '').toLowerCase();
  const points = POINTS_RE.test(lower);
  if (!points || !lower.startsWith(PREFIX)) return { points, subcommand: null, rest: [] };

  const rest = content.slice(PREFIX.length).trim().split(/ +/g).filter(Boolean);
  if (!rest.length) return { points, subcommand: null, rest: [] }; // bare `owo`

  const raw = rest.shift().toLowerCase();
  const subcommand = ALIASES.get(raw);

  // `owo owo <text>` is owoify upstream; bare `owo owo` is just another point.
  if (!subcommand) {
    if (raw === PREFIX && rest.length) return { points, subcommand: 'owoify', rest };
    return { points, subcommand: null, rest: [] }; // unknown -> silent, like upstream
  }
  if (subcommand === 'owoify' && !rest.length) return { points, subcommand: null, rest: [] };
  return { points, subcommand, rest };
}

/**
 * Handles a message that starts with `owo` (any casing, space optional), plus the
 * silent owo/uwu point counter.
 * @returns {Promise<boolean>} true only if an OwO command actually ran (i.e. consume it).
 */
export async function handleOwoNaturalPrefix(message) {
  try {
    if (!message.guild || message.author?.bot || !message.content) return false;

    // Cheap reject before touching the DB: most messages contain neither.
    const { points, subcommand, rest } = parseOwo(message.content);
    if (!points) return false;
    if (!(await isEnabled(message.guild.id))) return false;

    // Silent point, on cooldown, for ANY message containing owo/uwu.
    if (claimPointSlot(message.author.id)) {
      addPoint(message.guild.id, message.author.id).catch(err =>
        logger.debug(`[OwO] point insert failed: ${err.message}`));
    }

    if (!subcommand) return false;
    return dispatch(message, subcommand, rest);
  } catch (err) {
    logger.error(`[OwO] natural prefix error: ${err.message}`);
    return false;
  }
}

/**
 * `owo team add :bee:` is how upstream words it, but our router dispatches on a single flat
 * subcommand. Fold the action word back in so both `owo team add` and `owo team-add` work —
 * without this, `owo team add :bee:` would silently just SHOW the team.
 */
const TEAM_ACTIONS = new Set(['add', 'remove', 'create', 'switch', 'rename']);

function foldTeamAction(subcommand, rest) {
  if (subcommand !== 'team' || !TEAM_ACTIONS.has(String(rest[0] ?? '').toLowerCase())) {
    return { subcommand, rest };
  }
  return { subcommand: `team-${rest[0].toLowerCase()}`, rest: rest.slice(1) };
}

async function dispatch(message, subcommand, rest) {
  const folded = foldTeamAction(subcommand, rest);
  const { handleOwoRouter } = await import('../handlers/owo-prefix.js');
  const ctx = new MessageContextAdapter(message, 'owo', buildArgs(folded.subcommand, folded.rest));
  await handleOwoRouter(ctx);
  return true;
}

// Exposed for tests.
export const _internals = { ALIASES, buildArgs, PREFIX };
