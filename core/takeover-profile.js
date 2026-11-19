/*
 * Derive a guild's takeover profile by reading its own history.
 *
 * This is the part that used to be me, with a REST client and an afternoon. Everything the takeover
 * needs but cannot guess — which streamer the incumbent announces, where the role panels live, what
 * `!commands` people type — is written down somewhere in the server's past. This reads it.
 *
 * THE CENTRAL HONESTY RULE: derivation is a research assistant, not an oracle. Every field carries a
 * confidence and the evidence it was drawn from, because the fields are genuinely not equal:
 *
 *   certain  — the datum is stated outright. A Twitch handle inside "<name> is live at
 *              twitch.tv/<name>" is not an inference.
 *   likely   — strongly implied but not stated. A `!pp` in chat followed by a bot reply is almost
 *              certainly a custom command, but it could be a coincidence.
 *   guess    — genuinely inferred and genuinely fallible. WHICH Discord role a Carl-bot panel's 🧡
 *              button grants appears NOWHERE in the message; Carl-bot keeps that in its own
 *              database. We can only match the panel's emoji against role names and hope. This is
 *              the field that will be wrong, so it is the field a human must actually look at.
 *
 * A profile is `proposed` until a human approves it, and only an approved profile may drive apply().
 * Handing 'guess' data straight to something that writes to a live server would be indefensible.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { walkComponents } from './guild-analyzer.js';
import { resolveBotMeta, featuresOf } from './takeover-bots.js';

/**
 * Which bot posted this?
 *
 * By id AND by name, because a bot id alone is not enough: plenty of bots post through WEBHOOKS, and
 * a webhook message's `author.id` is the webhook's, not the bot's. FreeStuff and Dyno both do it in
 * real servers we have scanned. Matching on id alone silently skips them, and a silent skip here is a profile
 * that quietly omits a whole feature.
 *
 * The name check is deliberately narrow — anchored, not a substring sweep — so a member nicknamed
 * "carl" cannot be mistaken for Carl-bot.
 */
const BOT_MATCHERS = {
  stream:  { ids: new Set(['282286160494067712', '375805687529209857']), name: /^(pingcord|streamcord)/i },
  panel:   { ids: new Set(['235148962103951360', '155149108183695360', '204255221017214977']),
             name: /^(carl-?bot|dyno|yagpdb)/i },
  command: { ids: new Set(['83010416610906112', '159985870458322944']), name: /^(nightbot|mee6)/i },
};

/** Which catalog feature each derivation is looking for. */
const KIND_FEATURE = { stream: 'streams', panel: 'reaction_roles', command: 'custom_commands' };

function isBot(msg, kind) {
  const m = BOT_MATCHERS[kind];
  if (!msg?.author) return false;
  if (m.ids.has(msg.author.id)) return true;

  // Ask the catalog. The hand-typed id/name lists above predate it and only knew about four bots
  // between them — a server whose role panels are run by Zira, or whose streams come from Nova, had
  // its entire panel or streamer set derived as empty. The catalog resolves by id AND by name, so it
  // also covers a panel posted through a webhook.
  const meta = resolveBotMeta(msg.author.id, msg.author.username);
  const wanted = KIND_FEATURE[kind];
  if (meta && wanted && featuresOf(meta).includes(wanted)) return true;

  // A webhook persona only counts if it IS a webhook — otherwise any member could rename themselves
  // "Pingcord" and inject a fake streamer into the profile.
  return !!(msg.webhookId || msg.author.bot) && m.name.test(msg.author.username ?? '');
}

const field = (value, confidence, evidence) => ({ value, confidence, evidence });

/** Every readable text channel, oldest message first is irrelevant — we want all of them. */
async function readable(guild) {
  return [...guild.channels.cache.values()].filter(c =>
    c.isTextBased?.() && c.viewable && c.permissionsFor(guild.members.me)?.has('ReadMessageHistory'));
}

/** Full history of one channel, capped. Sampling under-counts, and an under-count here is a wrong profile. */
async function history(channel, cap = 2000) {
  const out = [];
  let before;
  while (out.length < cap) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  return out;
}

/** Everything a message actually says — content, embeds, AND Components V2 (which the other two miss). */
function textOf(msg) {
  const { text } = walkComponents(msg.components ?? []);
  return [
    msg.content,
    ...msg.embeds.flatMap(e => [e.title, e.description, e.url, ...(e.fields ?? []).map(f => `${f.name} ${f.value}`)]),
    ...text,
  ].filter(Boolean).join('\n');
}

// ── the derivations ──────────────────────────────────────────────────────────

/**
 * Who does the incumbent announce, where, and does it ping?
 *
 * CERTAIN: the platform handle comes out of the announcement's own URL. The channel is the channel
 * the message is in. Whether it pings @everyone is whether it contains @everyone. Nothing inferred.
 */
function deriveStreamers(messages) {
  const found = new Map();

  for (const m of messages) {
    if (!isBot(m, 'stream')) continue;
    const text = textOf(m);

    const hits = [
      [/twitch\.tv\/([a-z0-9_]{3,25})/i, 'twitch'],
      [/youtube\.com\/(?:@|channel\/|c\/)([a-z0-9_.-]{2,})/i, 'youtube'],
      [/kick\.com\/([a-z0-9_-]{3,25})/i, 'kick'],
    ];

    for (const [re, platform] of hits) {
      const hit = text.match(re);
      if (!hit) continue;
      const username = hit[1].toLowerCase();
      const key = `${platform}/${username}`;
      const prev = found.get(key);
      found.set(key, {
        platform,
        username,
        channelId: m.channelId,
        // @everyone in the announcement means the incumbent pings everyone. Preserve that: quietly
        // dropping the ping would be a visible downgrade the day we take over.
        pingRoleId: /@everyone/.test(text) ? 'everyone' : (text.match(/<@&(\d+)>/) ?? [])[1] ?? null,
        seen: (prev?.seen ?? 0) + 1,
      });
    }
  }

  const list = [...found.values()].sort((a, b) => b.seen - a.seen);
  return field(
    list.map(({ seen, ...s }) => s),
    list.length ? 'certain' : 'none',
    list.length ? `${list.length} streamer(s) across ${list.reduce((a, s) => a + s.seen, 0)} announcements`
                : 'no stream announcements found');
}

/**
 * The role panels, and where they live.
 *
 * The panel's TITLE and its EMOJI are certain — they are right there in the message. The ROLE each
 * emoji grants is a GUESS, and an honest one: Carl-bot stores that mapping in its own database and
 * never puts it in the message. All we can do is look at the emoji and the guild's roles and try to
 * match them up. `roleConfidence` is per-option so a reviewer can see exactly which buttons we are
 * unsure about instead of being asked to trust the lot.
 */
/**
 * Read the emoji-to-label pairs out of a panel's own text.
 *
 * A reaction-role panel almost always LISTS its options — "🇪🇺 Europe", "🦅 — North America",
 * ":steam: PC". The previous derivation never looked: it matched the emoji's own name against role
 * names and nothing else, which resolves a `:steam:` and none of the unicode, so a region panel came
 * back as seven buttons that do nothing.
 *
 * Everything after the emoji up to the end of the line is the label, minus the punctuation people
 * put between the two. A line with a ROLE MENTION in it is handled separately and beats this outright.
 */
/*
 * Shortcode ↔ unicode.
 *
 * A panel's text and its reactions do not have to be written the same way, and routinely are not.
 * The message that prompted this reads:
 *
 *   "…by selecting either :purple_circle: for Affiliate or :white_circle: for Non-Affiliate"
 *
 * — because an embed built by a bot does NOT convert shortcodes the way a typed message does, so the
 * description contains the literal text `:purple_circle:`. The reaction sitting on that same message
 * is the character 🟣. Keyed as written, the two never meet: the panel says in plain English what
 * each emoji grants and we resolved neither.
 *
 * Only the families panels actually use. A complete emoji table is a dependency and a maintenance
 * burden for no gain — nobody builds a role panel out of 🥐.
 */
const SHORTCODES = {
  red_circle: '🔴', orange_circle: '🟠', yellow_circle: '🟡', green_circle: '🟢',
  blue_circle: '🔵', large_blue_circle: '🔵', purple_circle: '🟣', brown_circle: '🟤',
  black_circle: '⚫', white_circle: '⚪',
  red_square: '🟥', orange_square: '🟧', yellow_square: '🟨', green_square: '🟩',
  blue_square: '🟦', purple_square: '🟪', brown_square: '🟫',
  black_large_square: '⬛', white_large_square: '⬜',
  heart: '❤️', red_heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
  blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', white_heart: '🤍', brown_heart: '🤎',
  white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️',
  x: '❌', negative_squared_cross_mark: '❎', o: '⭕',
  '+1': '👍', thumbsup: '👍', thumbs_up: '👍', '-1': '👎', thumbsdown: '👎', thumbs_down: '👎',
  star: '⭐', star2: '🌟', sparkles: '✨', tada: '🎉', gift: '🎁', bell: '🔔', no_bell: '🔕',
  question: '❓', grey_question: '❔', exclamation: '❗', warning: '⚠️',
  calendar: '📅', date: '📆', clock: '🕰️', alarm_clock: '⏰',
  video_game: '🎮', joystick: '🕹️', headphones: '🎧', musical_note: '🎵', notes: '🎶',
  art: '🎨', camera: '📷', movie_camera: '🎥', tv: '📺', books: '📚', book: '📖',
  computer: '💻', desktop: '🖥️', iphone: '📱', robot: '🤖', speech_balloon: '💬',
  crown: '👑', gem: '💎', fire: '🔥', zap: '⚡', rocket: '🚀', wave: '👋', handshake: '🤝',
  aries: '♈', taurus: '♉', gemini: '♊', cancer: '♋', leo: '♌', virgo: '♍',
  libra: '♎', scorpius: '♏', scorpio: '♏', sagittarius: '♐', capricorn: '♑',
  aquarius: '♒', pisces: '♓',
};

/** A regional indicator letter, so `flag_eu` and `regional_indicator_a` need no table of their own. */
const RI = (ch) => String.fromCodePoint(0x1F1E6 + (ch.toLowerCase().charCodeAt(0) - 97));

/**
 * Every way one emoji can be written, so a label parsed from the text can be found by a reaction's
 * own name — whichever notation each of them happened to use.
 */
function emojiAliases(key) {
  const k = String(key ?? '').toLowerCase();
  const out = new Set([key, k]);

  if (SHORTCODES[k]) out.add(SHORTCODES[k]);

  const flag = /^flag[_-]([a-z]{2})$/.exec(k);
  if (flag) out.add(RI(flag[1][0]) + RI(flag[1][1]));

  const ri = /^regional_indicator_([a-z])$/.exec(k);
  if (ri) out.add(RI(ri[1]));

  // And the other direction: given the character, add its shortcode name(s).
  for (const [name, char] of Object.entries(SHORTCODES)) {
    if (char === key || char.replace(/\uFE0F/g, '') === String(key).replace(/\uFE0F/g, '')) out.add(name);
  }
  // Variation selectors are invisible and inconsistently present. Match with and without.
  out.add(String(key).replace(/\uFE0F/g, ''));
  return [...out].filter(Boolean);
}

const EMOJI_RE = /(<a?:(\w+):\d+>|:(\w+):|(\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}))/gu;

/** The name we key an emoji by: the custom emoji's name, or the unicode character itself. */
const emojiKey = (hit) => hit[2] ?? hit[3] ?? hit[4];

const tidyLabel = (str) => String(str)
  .replace(/<@&\d+>/g, ' ')                        // the mention is read separately; it is not the label
  .replace(/^[\s\-–—:=>|·•*_~`"']+/, '')
  .replace(/[\s*_~`"'.!]+$/, '')
  .trim();

/**
 * "…selecting either 🟣 for Affiliate or ⚪ for Non-Affiliate."
 *
 * Panels do not always lay their options out one per line. Plenty of them explain the mapping in a
 * SENTENCE, and the line-leading parser below skipped every one of those — which is how a panel that
 * says in plain English what each emoji grants came back as two unresolved buttons.
 *
 * A connector is required. That is what separates a mapping from prose that merely contains an
 * emoji: "🟣 for Affiliate" is a mapping, "we had a 🎉 party" is not. The label then runs to the next
 * emoji or the next "or"/comma/full stop, whichever comes first.
 */
function parseInlineMappings(text) {
  const out = new Map();
  if (!text) return out;

  const CONNECTOR = /^\s*(?:for|=|->|→|:|means|if\s+you(?:'|’)?re|if\s+you\s+are|if\s+you|to\s+get|to\s+receive|to\s+join|to\s+agree|to\s+accept|\(\s*)/i;
  const STOP = /\s+(?:or|and)\s|[,.;]|\)|$/;

  const str = String(text);
  EMOJI_RE.lastIndex = 0;
  const hits = [...str.matchAll(EMOJI_RE)];

  for (const [i, hit] of hits.entries()) {
    const after = str.slice(hit.index + hit[0].length, hits[i + 1]?.index ?? str.length);
    const conn = CONNECTOR.exec(after);
    if (!conn) continue;

    const rest = after.slice(conn[0].length);
    const stop = STOP.exec(rest);
    const label = tidyLabel(rest.slice(0, stop ? stop.index : rest.length));
    if (!label || label.length > 60) continue;

    for (const alias of emojiAliases(emojiKey(hit))) {
      if (!out.has(alias)) out.set(alias, { label, line: str, how: 'inline' });
    }
  }
  return out;
}

/**
 * Read the emoji-to-label pairs out of a panel's own text.
 *
 * Two passes, because panels are written two ways. Options listed one per line — "🇪🇺 Europe" — and
 * options explained in a sentence. The line pass wins where both fire: a list is a deliberate
 * mapping, a sentence is a description of one.
 */
function parseEmojiLabels(text) {
  const out = new Map();
  if (!text) return out;

  // NOTE: both passes below store each mapping under EVERY alias of its emoji (shortcode, character,
  // with and without the variation selector), so a reaction can be looked up by whatever notation it
  // carries regardless of how the panel's author wrote it.
  //
  // Prose FIRST, because a one-line description is both. "select 🟣 for Affiliate or ⚪ for
  // Non-Affiliate" leads with an emoji at index 7, so the line pass claims it and reads the label as
  // "for Affiliate or" — connector and all. The inline pass requires a connector and knows to stop
  // at the "or", so it is the one that understands this shape; the line pass then fills the gaps.
  //
  // A genuine list is untouched by this: "🇪🇺 Europe" has no connector after the emoji, so the
  // inline pass declines it and the line pass reads it exactly as before.
  for (const [key, v] of parseInlineMappings(text)) out.set(key, v);

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    EMOJI_RE.lastIndex = 0;
    const hits = [...line.matchAll(EMOJI_RE)];
    if (!hits.length) continue;

    // The line has to LEAD with an emoji to be an option line. Without this, "some prose about 🎉
    // parties" is read as an option granting a role called "parties".
    if (hits[0].index > 8) continue;

    // Several options can share a line — panels are routinely laid out two or three across. Each
    // label runs from its own emoji to the start of the next one, so a row of zodiac signs comes
    // back as twelve options rather than one option labelled with all the others.
    for (const [i, hit] of hits.entries()) {
      const from = hit.index + hit[0].length;
      const to = hits[i + 1]?.index ?? line.length;
      const label = tidyLabel(line.slice(from, to));
      if (!label || label.length > 60) continue;
      for (const alias of emojiAliases(emojiKey(hit))) {
        if (!out.has(alias)) out.set(alias, { label, line, how: 'listed' });
      }
    }
  }

  return out;
}

/** Every role id mentioned on the same line as a given emoji. The only zero-inference signal there is. */
function roleIdOnLine(line) {
  return (String(line ?? '').match(/<@&(\d+)>/) ?? [])[1] ?? null;
}

/** Strip decoration people put in role names — emoji, brackets, separators — down to words. */
const roleWords = (name) => String(name ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9+/ ]/gi, ' ')
  .split(/\s+/)
  .filter(Boolean);

const assignable = (guild) => guild.roles.cache.filter(r => !r.managed && r.id !== guild.id);

/**
 * Does this name negate itself? "Non-Affiliate", "Not Verified", "Unverified".
 *
 * Load-bearing. Without it, a label of "Affiliate" matches a role called "Non-Affiliate Live" just
 * as well as one called "Affiliate Live" — every word of the label is present in both — so the two
 * options on a yes/no panel either collapse onto the same role or cancel each other out as
 * ambiguous. A negation is the whole meaning of the option; it cannot be treated as noise.
 */
const NEGATED = /^(non|not|un|anti|no|never|without)$/i;
const isNegated = (name) => roleWords(name).some(w => NEGATED.test(w))
  || /\bnon-|\bun(verified|affiliated)\b/i.test(String(name ?? ''));

/**
 * Find the role a label refers to.
 *
 * Three rungs, because role names in the wild are not the labels people write next to them. A panel
 * that says "🟣 for Affiliate" in a server whose role is called "Affiliate Live" resolved to nothing
 * under an exact-match-only rule, which is a dead button on a panel that told us the answer in
 * plain English.
 *
 * @returns {{role, how:'exact'|'subset'|'overlap'}|null}
 */
function roleByName(guild, name) {
  const want = roleWords(name);
  if (!want.length) return null;
  const pool = [...assignable(guild).values()];

  // 1. The same words, in any decoration. "She/Her" matches "💛 She/Her".
  const exact = pool.find(r => roleWords(r.name).join(' ') === want.join(' '));
  if (exact) return { role: exact, how: 'exact' };

  // A label and a role have to agree about negation before anything below can compare them.
  const wantNeg = isNegated(name);
  const agrees = (r) => isNegated(r.name) === wantNeg;

  // 2. One name's words are wholly contained in the other's — "Affiliate" ⊂ "Affiliate Live".
  //    Only when exactly ONE role qualifies: two candidates means we do not know, and picking
  //    either would be inventing an answer.
  const subset = pool.filter(r => {
    if (!agrees(r)) return false;
    const have = roleWords(r.name);
    return want.every(w => have.includes(w)) || have.every(w => want.includes(w));
  });
  if (subset.length === 1) return { role: subset[0], how: 'subset' };

  // 3. A single distinctive word in common, and only one role has it. "Non-Affiliate" → the one
  //    role carrying "affiliate" — but only if rung 2 did not already find two of them.
  const meaningful = want.filter(w => w.length > 3 && !STOPWORDS.has(w) && !NEGATED.test(w));
  if (meaningful.length) {
    const overlap = pool.filter(r => {
      if (!agrees(r)) return false;
      const have = roleWords(r.name);
      return meaningful.some(w => have.includes(w));
    });
    if (overlap.length === 1) return { role: overlap[0], how: 'overlap' };
  }
  return null;
}

const STOPWORDS = new Set(['role', 'roles', 'the', 'and', 'for', 'you', 'your', 'here', 'get', 'member']);

/**
 * Is this panel a rules/verification gate, and what does agreeing grant?
 *
 * The single most common panel in Discord and the one that resolves worst, because there is no
 * lexical bridge at all between 👍 and a role called "Members" — the meaning is entirely in what the
 * post SAYS. "React 👍 to agree to the rules" grants access, and access in almost every server is
 * one baseline role.
 *
 * Deliberately narrow: it needs the agreement language AND a single option AND a role that is
 * plainly the access role. Any panel offering a choice is not a gate, and guessing "Members" onto a
 * region panel would be far worse than leaving it unresolved.
 */
const ACCESS_ROLE = /^(members?|verified|access|approved|entry|entrant|accepted|citizen|survivor|regular)$/i;
const GATE_LANGUAGE = /\b(agree|accept|abide|read (and|&) accept|rules?|terms|verify|verification|to gain access|unlock the server|get access)\b/i;

function agreementRole(guild, { title, body, optionCount }) {
  if (optionCount !== 1) return null;                        // a choice is not a gate
  if (!GATE_LANGUAGE.test(`${title ?? ''}\n${body ?? ''}`)) return null;

  const named = [...assignable(guild).values()].filter(r => ACCESS_ROLE.test(roleWords(r.name).join(' ')));
  if (named.length === 1) {
    return { role: named[0], how: 'named', why: `a rules/agreement gate, and "${named[0].name}" is this server's access role` };
  }
  if (named.length > 1) {
    // Several candidates — take the one most members actually hold. Still `likely`, never certain.
    const top = named.sort((a, b) => (b.members?.size ?? 0) - (a.members?.size ?? 0))[0];
    return { role: top, how: 'named', why: `a rules/agreement gate; of ${named.length} access-looking roles, `
      + `"${top.name}" is the one ${top.members?.size ?? 0} members actually hold` };
  }
  return null;
}

/** Say, in one clause, HOW a label was matched to a role — so a reader can judge it. */
function describeMatch(label, { role, how }) {
  if (how === 'exact') return `and a role called "${role.name}" exists`;
  if (how === 'subset') return `and "${role.name}" is the only role whose name contains it`;
  return `and "${role.name}" is the only role sharing a word with it — check this one`;
}

/**
 * Which role does the crowd that pressed this emoji actually hold?
 *
 * The last resort, and the most interesting one. Nothing in the message says what 🧡 grants — the
 * mapping lives in the old bot's own database. But the PEOPLE who reacted are still here, and they
 * are still wearing whatever they were given. If forty members reacted with 🧡 and thirty-eight of
 * them have "He/Him" while only six percent of the server does, that is not a guess.
 *
 * Reported as `likely`, never `certain`: a role can correlate for other reasons (everyone in the
 * region panel is also a Member), which is exactly what the LIFT test is for — the role has to be far
 * more common among reactors than in the server at large, not merely common.
 */
async function roleFromReactors(reaction, guild, { minReactors = 4, minShare = 0.7, minLift = 3 } = {}) {
  const users = await reaction.users.fetch({ limit: 100 }).catch(() => null);
  if (!users?.size) return null;

  const humans = [...users.values()].filter(u => !u.bot);
  if (humans.length < minReactors) return null;

  const counts = new Map();
  let sampled = 0;
  for (const u of humans) {
    const member = guild.members.cache.get(u.id);
    if (!member) continue;
    sampled++;
    for (const r of member.roles.cache.values()) {
      if (r.managed || r.id === guild.id) continue;
      counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    }
  }
  if (sampled < minReactors) return null;

  const population = Math.max(guild.members.cache.size, 1);
  let best = null;
  for (const [roleId, n] of counts) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    const share = n / sampled;                       // how many reactors hold it
    const baseline = (role.members?.size ?? 0) / population;  // how many of the server holds it
    const lift = baseline > 0 ? share / baseline : Infinity;
    if (share < minShare || lift < minLift) continue;
    if (!best || share > best.share) best = { role, share, lift, sampled };
  }
  return best;
}

/**
 * The role panels, and where they live.
 *
 * Resolution runs as a LADDER, strongest evidence first, and every option records which rung it came
 * from. That matters more here than anywhere else in the takeover: a panel posted with an unresolved
 * option is a button that silently does nothing when a member clicks it, and a panel posted with a
 * WRONG option hands somebody the wrong role — worse, because it looks like it worked.
 *
 *   certain — a role id we did not have to interpret: a role mention on the option's own line, or a
 *             snowflake inside a button's customId.
 *   likely  — the panel's own text names the role ("🇪🇺 Europe" and a role called Europe exists), or
 *             the people who pressed it overwhelmingly wear one role and the rest of the server does not.
 *   guess   — the emoji's name happens to match a role name.
 *   unknown — nothing. Dropped before posting rather than shipped as a dead button.
 */
async function derivePanels(messages, guild) {
  const panels = [];
  const channels = new Map();

  for (const m of messages) {
    if (!isBot(m, 'panel')) continue;

    const reactions = [...(m.reactions?.cache?.values() ?? [])];
    const buttons = collectButtons(m);
    if (!reactions.length && !buttons.length) continue;   // not a panel

    const title = m.embeds[0]?.title?.trim() || m.content?.split(/\r?\n/)[0]?.trim();
    if (!title) continue;

    // Everything the panel says about itself: the embed body, its fields, and the plain content.
    const body = [
      m.content,
      ...(m.embeds ?? []).flatMap(e => [e.description, ...(e.fields ?? []).map(f => `${f.name} ${f.value}`)]),
    ].filter(Boolean).join('\n');
    const labels = parseEmojiLabels(body);

    const options = [];

    // ── Button panels. Skipped entirely before, which lost every modern panel. ──
    for (const b of buttons) {
      // Most panel bots put the role id straight in the customId (`rr:role:123`, `role_123`).
      const embedded = (String(b.custom_id ?? '').match(/(\d{17,20})/) ?? [])[1];
      const byId = embedded && guild.roles.cache.get(embedded);
      const byLabel = roleByName(guild, b.label);
      const chosen = byId || byLabel?.role;

      options.push({
        emoji: b.emoji?.id ? `:${b.emoji.name}:` : (b.emoji?.name ?? null),
        emojiId: b.emoji?.id ?? null,
        animated: !!b.emoji?.animated,
        roleId: chosen?.id ?? null,
        label: chosen?.name ?? b.label ?? null,
        roleConfidence: byId ? 'certain' : byLabel ? (byLabel.how === 'exact' ? 'likely' : 'guess') : 'unknown',
        evidence: byId ? `the button's own customId carries role ${embedded}`
          : byLabel ? describeMatch(b.label, byLabel)
            : 'the button carries no role id and its label matches no role',
      });
    }

    // ── Reaction panels. ──
    for (const r of reactions) {
      // Every notation this reaction could appear as in the panel's text.
      const fromText = emojiAliases(r.emoji.name).map(a => labels.get(a)).find(Boolean) ?? null;

      let roleId = null, label = fromText?.label ?? null, confidence = 'unknown', evidence = null;

      // 1. A role mention on the same line. Nothing to interpret.
      const mentioned = fromText && roleIdOnLine(fromText.line);
      if (mentioned && guild.roles.cache.has(mentioned)) {
        roleId = mentioned;
        label = guild.roles.cache.get(mentioned).name;
        confidence = 'certain';
        evidence = `the panel names the role directly on the "${r.emoji.name}" line`;
      }

      // 2. The panel's own text labels it — either listed one per line, or explained in a sentence
      //    ("selecting either 🟣 for Affiliate or ⚪ for Non-Affiliate").
      if (!roleId && fromText) {
        const byLabel = roleByName(guild, fromText.label);
        if (byLabel) {
          roleId = byLabel.role.id;
          label = byLabel.role.name;
          confidence = byLabel.how === 'exact' ? 'likely' : 'guess';
          const said = fromText.how === 'inline'
            ? `the panel says "${r.emoji.name} for ${fromText.label}"`
            : `the panel reads "${r.emoji.name} ${fromText.label}"`;
          evidence = `${said}, ${describeMatch(fromText.label, byLabel)}`;
        }
      }

      // 3. A rules/agreement gate. There is no lexical bridge between 👍 and "Members" — the meaning
      //    is in what the post says, not in the emoji.
      if (!roleId) {
        const gate = agreementRole(guild, { title, body, optionCount: reactions.length + buttons.length });
        if (gate) {
          roleId = gate.role.id;
          label = gate.role.name;
          confidence = 'likely';
          evidence = gate.why;
        }
      }

      // 4. Who actually pressed it, and what are they wearing?
      if (!roleId) {
        const crowd = await roleFromReactors(r, guild).catch(() => null);
        if (crowd) {
          roleId = crowd.role.id;
          label = crowd.role.name;
          confidence = 'likely';
          evidence = `${Math.round(crowd.share * 100)}% of the ${crowd.sampled} members who reacted with `
            + `${r.emoji.name} hold "${crowd.role.name}" — ${Math.round(crowd.lift)}× more often than the server at large`;
        }
      }

      // 5. The emoji's own name matches a role. Weak, and labelled as such.
      if (!roleId) {
        const byEmojiName = roleByName(guild, r.emoji.name);
        if (byEmojiName?.how === 'exact') {
          roleId = byEmojiName.role.id;
          label = byEmojiName.role.name;
          confidence = 'guess';
          evidence = `the emoji is called "${r.emoji.name}" and so is a role — that is the only reason`;
        }
      }

      if (!roleId) {
        evidence = fromText
          ? `the panel reads "${r.emoji.name} ${fromText.label}" but no role is called that`
          : 'the panel does not say what this emoji grants, and nobody who reacted shares a distinctive role';
      }

      options.push({
        emoji: r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name,
        emojiId: r.emoji.id ?? null,
        animated: !!r.emoji.animated,
        roleId,
        label,
        roleConfidence: confidence,
        evidence,
      });
    }

    panels.push({
      name: title,
      channelId: m.channelId,
      messageId: m.id,
      mode: 'multiple',
      kind: buttons.length ? 'buttons' : 'reactions',
      // The panel's OWN words, kept verbatim.
      //
      // A role picker's text is usually disposable. A rules post's text is the entire point of the
      // message — and rebuilding one from a template replaced ten house rules with "Pick as many as
      // you like", which is not a takeover, it is deleting the thing we were asked to preserve.
      // Anything with a body keeps its body; only a panel that never had one gets boilerplate.
      description: (m.embeds?.[0]?.description ?? m.content ?? '').trim() || null,
      fields: (m.embeds?.[0]?.fields ?? []).map(f => ({ name: f.name, value: f.value })),
      color: m.embeds?.[0]?.color ?? null,
      options,
    });
    channels.set(m.channelId, (channels.get(m.channelId) ?? 0) + 1);
  }

  // The self-assign channel is simply wherever most of the panels are.
  const top = [...channels.entries()].sort((a, b) => b[1] - a[1])[0];
  const all = panels.flatMap(p => p.options);
  const by = (c) => all.filter(o => o.roleConfidence === c).length;
  const resolved = all.filter(o => o.roleId).length;

  // The panel field's own confidence is the WEAKEST rung anything landed on, not an average. A panel
  // is posted as a unit, and one dead button in it is a member clicking something that does nothing.
  const overall = !panels.length ? 'none'
    : by('unknown') ? 'guess'
      : by('guess') ? 'guess'
        : by('likely') ? 'likely'
          : 'certain';

  return {
    panels: field(panels, overall,
      panels.length
        ? `${panels.length} panel(s), ${all.length} option(s): ${by('certain')} resolved from a role id in the `
          + `panel itself, ${by('likely')} from its wording or from what the members who pressed it are `
          + `wearing, ${by('guess')} from an emoji name alone, ${all.length - resolved} not resolved at all. `
          + (all.length - resolved
            ? 'The unresolved ones are dropped before posting — a button with no role does nothing when clicked.'
            : 'Check the ones marked likely or guess before approving.')
        : 'no role panels found'),
    selfAssignChannel: field(top?.[0] ?? null, top ? 'certain' : 'none',
      top ? `${top[1]} panel(s) live here` : 'no panel channel found'),
  };
}

/**
 * Every button on a message, from either the raw REST shape or discord.js's wrappers.
 *
 * Link buttons are excluded: they open a URL and grant nothing, so treating one as an unresolved
 * role option would report a panel as broken when it is working exactly as intended.
 */
function collectButtons(msg, out = [], depth = 0) {
  if (depth > 6) return out;
  for (const row of msg?.components ?? []) {
    const kids = row?.components ?? row?.data?.components ?? [];
    for (const c of kids) {
      const d = c?.data ?? c;
      if (d?.type === 2 && d?.style !== 5 && (d?.custom_id ?? d?.customId)) {
        out.push({
          custom_id: d.custom_id ?? d.customId,
          label: d.label ?? null,
          emoji: d.emoji ?? null,
        });
      }
    }
    if (kids.length) collectButtons({ components: kids }, out, depth + 1);
  }
  return out;
}

/**
 * Custom chat commands — the `!pp`s of the world.
 *
 * LIKELY, not certain: we look for a member message starting with a prefix, immediately followed by
 * a bot reply in the same channel. That is what a custom command looks like from the outside. It
 * could also be a coincidence, so the RESPONSE is captured verbatim and a human confirms it.
 */
function deriveCustomCommands(messages) {
  const byChannel = new Map();
  for (const m of messages) {
    if (!byChannel.has(m.channelId)) byChannel.set(m.channelId, []);
    byChannel.get(m.channelId).push(m);
  }

  const cmds = new Map();
  for (const list of byChannel.values()) {
    // Discord hands us newest-first; walk oldest-first so "the reply follows the trigger" is true.
    const ordered = [...list].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (let i = 0; i < ordered.length - 1; i++) {
      const trigger = ordered[i];
      const reply = ordered[i + 1];
      if (trigger.author?.bot) continue;
      // ANY bot's reply, not just a named custom-command bot.
      //
      // This used to require the responder to be Nightbot or MEE6. Dyno, Carl-bot and YAGPDB all
      // run custom commands too, and in a server using one of those the whole system was invisible
      // — we would have retired the bot and silently taken every custom command with it. The real
      // filter is the shape of the exchange, not the name of the bot: a human types a prefixed
      // command, and a bot answers within seconds.
      if (!reply.author?.bot && !reply.webhookId) continue;

      const hit = trigger.content?.match(/^([!?$.])([a-z0-9_-]{1,24})\s*$/i);
      if (!hit) continue;
      // A reply more than 10s later is a different conversation, not an answer to this.
      if (reply.createdTimestamp - trigger.createdTimestamp > 10_000) continue;

      const name = hit[2].toLowerCase();
      const response = textOf(reply).trim();
      if (!response) continue;

      const prev = cmds.get(name);
      cmds.set(name, {
        name, prefix: hit[1], response,
        // Which bot answered. Needed to know WHICH incumbent's command list this belongs to — two
        // bots in the same server can each own commands, and they retire separately.
        answeredBy: reply.author?.username ?? null,
        seen: (prev?.seen ?? 0) + 1,
      });
    }
  }

  const list = [...cmds.values()].sort((a, b) => b.seen - a.seen);
  return field(
    list.map(({ seen, ...c }) => c),
    list.length ? 'likely' : 'none',
    list.length
      ? `${list.length} command(s) caught on camera: ${list.map(c => c.prefix + c.name).join(', ')}. `
        + 'This is the ONLY copy — a bot\'s command list is private to it, so anything it never '
        + 'answered in a channel we can read is unrecoverable once it leaves.'
      : 'no custom commands seen — either the server has none, or none were used in the history we read');
}

/** The birthday role. CERTAIN if a role is literally named for birthdays; otherwise we do not guess. */
function deriveBirthdayRole(guild) {
  const role = guild.roles.cache.find(r => /birthday/i.test(r.name) && !r.managed);
  return field(role?.id ?? null, role ? 'certain' : 'none',
    role ? `role "${role.name}"` : 'no role named for birthdays');
}

/**
 * Custom emoji THE PANELS need that this guild does not have.
 *
 * A bot may only use an emoji from a guild it is IN — Administrator does not help. Carl-bot hosts
 * its platform emoji on its own emoji server, so rebuilding those panels needs them re-uploaded
 * here first, or the buttons render blank.
 *
 * Reads the derived PANELS, not every message a panel-bot ever posted. Scanning all of Dyno's
 * messages swept up emoji from ordinary reactions that have nothing to do with any panel, and
 * reported them as things we must re-upload. A false "you must upload 3 emoji" is a step that can
 * never go green.
 */
function deriveMissingEmoji(panels, guild) {
  const need = new Map();
  for (const p of panels) {
    for (const o of p.options) {
      if (!o.emojiId) continue;                                        // unicode is always available
      if (guild.emojis.cache.some(e => e.name === o.emoji.replaceAll(':', ''))) continue; // already ours
      const name = o.emoji.replaceAll(':', '');
      need.set(name, { name, sourceId: o.emojiId, animated: o.animated });
    }
  }
  const list = [...need.values()];
  return field(list, list.length ? 'certain' : 'none',
    list.length ? `${list.length} emoji live on the old bot's server and must be re-uploaded here`
                : 'no external emoji needed');
}

/**
 * Empty duplicate roles, and what they could become.
 *
 * We PROPOSE renames but never names: which spare roles should become timezones and which should
 * become game roles is a judgment about what the server is for, and we do not know that. What we can
 * do — reliably — is find the roles that are safe to touch: zero members, not managed, and a name
 * that already exists elsewhere.
 */
function deriveRoleHygiene(guild) {
  const counts = new Map();
  for (const m of guild.members.cache.values()) {
    for (const id of m.roles.cache.keys()) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const byName = new Map();
  for (const r of guild.roles.cache.values()) {
    if (r.managed || r.id === guild.id) continue;
    const k = r.name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }

  const duplicates = [];
  for (const [name, roles] of byName) {
    if (roles.length < 2) continue;
    // Keep the one people are actually in; the empties are the corpses.
    const empties = roles.filter(r => !(counts.get(r.id) > 0));
    const live = roles.filter(r => counts.get(r.id) > 0);
    // If NONE of them has members we still keep one, so the name does not vanish from the server.
    const spare = live.length ? empties : empties.slice(1);
    for (const r of spare) duplicates.push({ id: r.id, name: r.name, position: r.position });
    if (spare.length) {
      logger.debug(`[TakeoverProfile] "${name}" exists ${roles.length}x; ${spare.length} spare`);
    }
  }

  const empty = [...guild.roles.cache.values()].filter(r =>
    !r.managed && r.id !== guild.id && !(counts.get(r.id) > 0)
    && !duplicates.some(d => d.id === r.id));

  return field(
    { duplicates, empty: empty.map(r => ({ id: r.id, name: r.name, position: r.position })) },
    'certain',
    `${duplicates.length} empty duplicate role(s) safe to repurpose; ${empty.length} other empty role(s). `
    + 'What they should BECOME is a judgment about this server — we do not guess at that.');
}

// ── the whole thing ──────────────────────────────────────────────────────────

/**
 * Read a guild and propose its profile. Read-only: touches nothing, posts nothing.
 *
 * Returns the profile with every field's confidence attached. Stored as `proposed`; a human has to
 * approve it before apply() will act on any of it.
 */
export async function deriveProfile(guild, { onProgress } = {}) {
  const started = Date.now();
  const channels = await readable(guild);

  // Members are needed for role-hygiene counts and are NOT in the cache by default.
  await guild.members.fetch().catch(() => logger.warn('[TakeoverProfile] could not fetch members'));

  const messages = [];
  for (const [i, ch] of channels.entries()) {
    onProgress?.({ done: i, total: channels.length, channel: ch.name });
    messages.push(...await history(ch));
  }
  logger.info(`[TakeoverProfile] read ${messages.length} messages across ${channels.length} channels in ${guild.name}`);

  const { panels, selfAssignChannel } = await derivePanels(messages, guild);

  const profile = {
    guildId: guild.id,
    guildName: guild.name,
    streamers: deriveStreamers(messages),
    panels,
    selfAssignChannel,
    customCommands: deriveCustomCommands(messages),
    birthdayRole: deriveBirthdayRole(guild),
    platformEmoji: deriveMissingEmoji(panels.value, guild),
    roleHygiene: deriveRoleHygiene(guild),
    stats: {
      messagesRead: messages.length,
      channelsRead: channels.length,
      channelsSkipped: guild.channels.cache.filter(c => c.isTextBased?.()).size - channels.length,
      tookMs: Date.now() - started,
    },
  };

  await pool.execute(
    `INSERT INTO takeover_profiles (guild_id, data, status) VALUES (?, ?, 'proposed')
     ON DUPLICATE KEY UPDATE data = VALUES(data), status = 'proposed',
                             derived_at = CURRENT_TIMESTAMP, approved_by = NULL, approved_at = NULL`,
    [guild.id, JSON.stringify(profile)]);

  return profile;
}

/** The stored profile, whatever its state. Null if we have never studied this guild. */
export async function getProfile(guildId) {
  const [[row]] = await pool.execute(
    'SELECT data, status, derived_at, approved_by, approved_at FROM takeover_profiles WHERE guild_id = ?',
    [guildId]);
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return { ...data, status: row.status, derivedAt: row.derived_at, approvedBy: row.approved_by };
}

/**
 * A human has checked it. Only now may apply() use it.
 *
 * `edits` lets the reviewer correct what derivation got wrong — above all the emoji-to-role mapping,
 * which is a guess by construction and is the field most likely to be wrong.
 */
export async function approveProfile(guildId, userId, edits = null) {
  const current = await getProfile(guildId);
  if (!current) throw new Error('there is no profile for this server yet — derive one first');

  const merged = edits ? { ...current, ...edits } : current;
  delete merged.status; delete merged.derivedAt; delete merged.approvedBy;

  await pool.execute(
    `UPDATE takeover_profiles SET data = ?, status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?`,
    [JSON.stringify(merged), userId, guildId]);

  logger.info(`[TakeoverProfile] ${userId} approved the profile for ${guildId}`);
  return merged;
}

/** Every field derivation was NOT sure about. This is the review list, and it is the point. */
export function needsReview(profile) {
  const out = [];
  for (const [key, f] of Object.entries(profile ?? {})) {
    if (!f || typeof f !== 'object' || !('confidence' in f)) continue;
    if (f.confidence === 'guess' || f.confidence === 'likely') {
      out.push({ key, confidence: f.confidence, evidence: f.evidence });
    }
  }
  // Panel options, by rung. Two genuinely different problems, and conflating them was hiding the
  // more dangerous one.
  const opts = (profile?.panels?.value ?? []).flatMap(p => p.options.map(o => ({ ...o, panel: p.name })));

  // A button with no role does NOTHING when clicked. Visible, but harmless.
  const unresolved = opts.filter(o => !o.roleId);
  if (unresolved.length) {
    out.push({
      key: 'panels.unresolved',
      confidence: 'unknown',
      evidence: `${unresolved.length} option(s) we could not match to any role — they would do NOTHING if `
        + `posted: ${unresolved.slice(0, 8).map(o => `${o.panel}: ${o.emoji}`).join(', ')}`
        + (unresolved.length > 8 ? '…' : ''),
    });
  }

  // A button with the WRONG role hands somebody a role they did not ask for, and it looks like it
  // worked. This is the sharper edge of the two and it needs reading one line at a time.
  const guessed = opts.filter(o => o.roleId && o.roleConfidence === 'guess');
  if (guessed.length) {
    out.push({
      key: 'panels.guessed',
      confidence: 'guess',
      evidence: `${guessed.length} option(s) resolved on an emoji name alone — the weakest evidence there `
        + `is. Read each one: ${guessed.slice(0, 6).map(o => `${o.emoji} → "${o.label}"`).join(', ')}`
        + (guessed.length > 6 ? '…' : '') + '. A button pointing at the wrong role looks like it worked.',
    });
  }

  // Inferred from the crowd, or from the panel's own wording. Worth a glance, not an alarm.
  const inferred = opts.filter(o => o.roleId && o.roleConfidence === 'likely');
  if (inferred.length) {
    out.push({
      key: 'panels.inferred',
      confidence: 'likely',
      evidence: `${inferred.length} option(s) read out of the panel's wording or from what the members who `
        + `pressed them are wearing: ${inferred.slice(0, 6).map(o => `${o.emoji} → "${o.label}"`).join(', ')}`
        + (inferred.length > 6 ? '…' : ''),
    });
  }
  return out;
}

export default { deriveProfile, getProfile, approveProfile, needsReview };
