/*
 * What was this message FOR?
 *
 * The retirement gate asks one question of every distinct message shape a bot posted: do we do this
 * too? Until now the answer came from a flat list of regexes per feature, and it left 382 shapes in
 * one ordinary server for a human to tick by hand — 179 of them Streamcord go-live announcements,
 * 175 of them YAGPDB go-live announcements, 247 of them Dyno writing "joined voice channel" over and
 * over. Not one of those needed a human. They needed the classifier to actually read them.
 *
 * HOW THIS IS DIFFERENT
 *
 * 1. It SCORES rather than matches. Every signal carries a weight, so "is now live on Twitch" is
 *    worth more than the word "live" appearing somewhere. A shape is attributed when the winner is
 *    both above a floor and clearly ahead of the runner-up — never on a single lucky word.
 *
 * 2. It only considers what the bot ACTUALLY DOES. A stream bot cannot be running a starboard, so
 *    `starboard` is not in the running for its messages. That is what lets a weak-but-correct match
 *    win: for a single-purpose bot there is barely anything to be confused with.
 *
 * 3. It recognises things that are NOT a feature. A vendor's own product announcements, Discord's
 *    admin broadcasts, a posted meme with no functional text — these were being counted as
 *    unexplained behaviour blocking a retirement, which is nonsense. They are now a verdict of their
 *    own, and they do not gate anything.
 *
 * 4. It SHOWS ITS WORKING. Every verdict carries the signals that produced it, so the page can say
 *    "attributed because it says 'is now live on Twitch'" instead of asking anyone to trust a
 *    checkbox. A classifier nobody can audit is worse than no classifier, because it is believed.
 *
 * A wrong verdict here is more dangerous than a missing one: it marks a shape explained when nobody
 * explained it, and the evidence gate is the last thing standing between that and a removed bot. So
 * the thresholds are deliberately conservative and anything under them says `unknown` and goes to a
 * person, which is exactly what the checkbox is for.
 */
import { FEATURES } from './takeover-bots.js';

/**
 * Verdicts that are not one of our features.
 *
 * These are real answers to "what was this for?", and each one means the shape does NOT have to be
 * explained before its bot can be retired.
 */
export const NON_FEATURES = Object.freeze({
  vendor_news: {
    label: 'The bot\'s own announcements',
    detail: 'the vendor talking about its own product — changelogs, feature launches, outages. '
      + 'Nothing this server configured, and nothing we replace.',
  },
  platform_news: {
    label: 'Discord\'s own announcements',
    detail: "Discord's admin/mod broadcasts. Not a bot doing a job in this server.",
  },
  media: {
    label: 'A posted image or link',
    detail: 'a message whose whole content is an image, a link or a caption, with no functional '
      + 'text — someone ran a fun command. Nothing to configure and nothing to carry across.',
  },
  chatter: {
    label: 'One-off chatter',
    detail: 'a reply with no recognisable feature behind it. Usually a manual message, a test, or a '
      + 'command someone ran once.',
  },
});

/**
 * The signals.
 *
 * `w` is how strongly the phrase identifies the feature ON ITS OWN:
 *   3 — unambiguous. Only this feature produces this sentence.
 *   2 — strong. Would need an odd coincidence to mean anything else.
 *   1 — supporting. True of this feature, but also of others; useful for breaking a tie.
 *
 * `says` is the plain-English name for the BEHAVIOUR, not the regex. It becomes the family heading
 * on the page ("Go-live announcements ×174"), so it has to read like something a person would say.
 *
 * Everything here is written against message shapes read out of real scans. Where a pattern came
 * from a specific observation, the comment says which — a signal nobody can trace back to a real
 * message is a guess wearing a lab coat.
 */
const SIGNALS = {
  streams: [
    // Streamcord: "xXDeath420Xx is now live on Twitch"; YAGPDB: "is currently streaming some X".
    { re: /is now live on (twitch|youtube|kick)/i, w: 3, says: 'Go-live announcements' },
    { re: /is (currently )?streaming\b/i, w: 3, says: 'Go-live announcements' },
    { re: /\bis (now |back )?live\b/i, w: 2, says: 'Go-live announcements' },
    { re: /is live again with some/i, w: 3, says: 'Go-live announcements' },
    { re: /\bwent live\b/i, w: 2, says: 'Go-live announcements' },
    { re: /check (it|them) out over at/i, w: 2, says: 'Go-live announcements' },
    // The other half of the pair, and the half every previous pattern set forgot.
    { re: /has finished streaming/i, w: 3, says: 'Stream-ended notices' },
    { re: /(is no longer|stopped) (live|streaming)/i, w: 3, says: 'Stream-ended notices' },
    { re: /streams live on twitch/i, w: 2, says: 'Go-live announcements' },
    { re: /\b(twitch|kick)\.tv\b/i, w: 1, says: 'Go-live announcements' },
    { re: /playing\s+\*\*/i, w: 1, says: 'Go-live announcements' },
  ],

  logging: [
    // Dyno's webhook, 247 shapes of it, all of them one of these three sentences.
    { re: /(joined|left) voice channel/i, w: 3, says: 'Voice join/leave logs' },
    { re: /switched voice channels/i, w: 3, says: 'Voice join/leave logs' },
    { re: /was (given|removed from) the .{0,60}role/i, w: 3, says: 'Role change logs' },
    { re: /\brole (added|removed|updated)\b/i, w: 2, says: 'Role change logs' },
    // Server-structure logs. Same module, same log channel, same replacement — and every one of
    // these was reported as unexplained because the patterns only knew about MEMBER role changes.
    { re: /\brole (created|deleted|renamed)\b/i, w: 3, says: 'Role & server change logs' },
    { re: /\brole colou?r changed\b/i, w: 3, says: 'Role & server change logs' },
    { re: /\brole .{0,40}changed:/i, w: 2, says: 'Role & server change logs' },
    { re: /\b(server|guild) (settings )?updated\b/i, w: 2, says: 'Role & server change logs' },
    { re: /message (sent by .{0,40})?(deleted|edited)/i, w: 3, says: 'Message delete/edit logs' },
    { re: /\bbulk delete\b/i, w: 3, says: 'Message delete/edit logs' },
    { re: /image sent by .{0,40}deleted/i, w: 3, says: 'Message delete/edit logs' },
    { re: /nickname changed/i, w: 3, says: 'Member update logs' },
    // "Member Joined | <user> | Account Age" — a log embed, not a welcome message. The account-age
    // field is what distinguishes the two, and it is the reason this outranks `welcome`.
    { re: /^embed:member (joined|left)\b/i, w: 3, says: 'Join/leave logs' },
    { re: /member (joined|left)\b/i, w: 2, says: 'Join/leave logs' },
    { re: /\baccount age\b/i, w: 1, says: 'Join/leave logs' },
    { re: /\bchannel (created|deleted|updated)\b/i, w: 2, says: 'Channel logs' },
    { re: /^embed:.{0,40}\|\*\*.{0,80}\*\*$/i, w: 1, says: 'Audit log entries' },
  ],

  moderation: [
    // "Case {n} | Ban | <user>" is how the mainstream mod bots title a case embed.
    { re: /case \{n\} ?\|/i, w: 3, says: 'Moderation case logs' },
    { re: /\bwas (banned|unbanned|kicked|muted|warned|timed out)\b/i, w: 3, says: 'Moderation actions' },
    { re: /\b(ban|kick|mute|warn|timeout|softban)\b.{0,30}\breason\b/i, w: 3, says: 'Moderation actions' },
    { re: /\|user\|moderator\|reason/i, w: 3, says: 'Moderation case logs' },
    { re: /has been (banned|kicked|muted|timed out|warned)/i, w: 3, says: 'Moderation actions' },
    // "Member Banned | <user>" — the other half of the case embed, posted to the log channel.
    { re: /^embed:member (banned|unbanned|kicked|muted|warned|timed out)/i, w: 3, says: 'Moderation actions' },
    { re: /member (banned|unbanned|kicked|muted|timed out)\b/i, w: 3, says: 'Moderation actions' },
    { re: /\bwarning \{n\}\b/i, w: 2, says: 'Warnings' },
    { re: /\b(automod|auto-?moderation)\b/i, w: 2, says: 'Automod actions' },
    { re: /\b(banned|kicked|muted|warned)\b/i, w: 1, says: 'Moderation actions' },
  ],

  welcome: [
    { re: /welcome to (the )?\S/i, w: 3, says: 'Welcome messages' },
    { re: /welcome,? \{user\}/i, w: 3, says: 'Welcome messages' },
    { re: /^embed:welcome/i, w: 3, says: 'Welcome messages' },
    { re: /thanks for joining/i, w: 2, says: 'Welcome messages' },
    { re: /(glad|great) to have you/i, w: 2, says: 'Welcome messages' },
    { re: /we now have \{n\} members/i, w: 2, says: 'Member-count greetings' },
    // Rules / info embeds are posted by the same module and are the same job: the standing text a
    // new member reads. Carried across as a message, not as config.
    { re: /^embed:(community )?rules/i, w: 3, says: 'Rules & info posts' },
    { re: /\bno racism\b|\bbe respectful\b|\bhate speech\b/i, w: 2, says: 'Rules & info posts' },
  ],

  reaction_roles: [
    { re: /^ui:/, w: 2, says: 'Role panels' },
    { re: /(select|react with|click).{0,40}(to get|for) .{0,30}role/i, w: 3, says: 'Role panels' },
    { re: /by selecting either/i, w: 3, says: 'Role panels' },
    { re: /self-?assign/i, w: 3, says: 'Role panels' },
    { re: /pick (a|your) (colour|color|role|pronoun)/i, w: 3, says: 'Role panels' },
    { re: /\{role\}/, w: 1, says: 'Role panels' },
  ],

  leveling: [
    { re: /has reached level \*?\*?\{n\}/i, w: 3, says: 'Level-up announcements' },
    { re: /(leveled|levelled) up/i, w: 3, says: 'Level-up announcements' },
    { re: /\bis now level \{n\}/i, w: 3, says: 'Level-up announcements' },
    { re: /leaderboard/i, w: 3, says: 'Rank & leaderboard cards' },
    { re: /view top \{n\}/i, w: 3, says: 'Rank & leaderboard cards' },
    { re: /\brank #?\{n\}/i, w: 2, says: 'Rank & leaderboard cards' },
    { re: /\b\{n\} ?xp\b/i, w: 2, says: 'Rank & leaderboard cards' },
  ],

  counting: [
    { re: /^\{n\}$/, w: 3, says: 'The count itself' },
    { re: /ruined it/i, w: 3, says: 'Wrong-number replies' },
    { re: /next number/i, w: 3, says: 'Wrong-number replies' },
    { re: /two numbers in a row/i, w: 3, says: 'Wrong-number replies' },
    { re: /deleted their number/i, w: 3, says: 'Wrong-number replies' },
    { re: /\bsaves?\b/i, w: 1, says: 'Wrong-number replies' },
  ],

  tickets: [
    { re: /\bticket #?\{n\}/i, w: 3, says: 'Ticket lifecycle' },
    { re: /(opened|closed) (a|your|this) ticket/i, w: 3, says: 'Ticket lifecycle' },
    { re: /\btranscript\b/i, w: 3, says: 'Ticket transcripts' },
    { re: /support team will be with you/i, w: 3, says: 'Ticket panels' },
    { re: /create a ticket/i, w: 3, says: 'Ticket panels' },
    { re: /\bticket\b/i, w: 1, says: 'Ticket lifecycle' },
  ],

  starboard: [
    { re: /jump to message/i, w: 2, says: 'Starred messages' },
    { re: /⭐\s*\{n\}/, w: 3, says: 'Starred messages' },
    { re: /\bstarboard\b/i, w: 3, says: 'Starred messages' },
  ],

  suggestions: [
    { re: /^embed:suggestion/i, w: 3, says: 'Suggestions' },
    { re: /\bsuggestion #?\{n\}/i, w: 3, says: 'Suggestions' },
    { re: /(approved|denied|implemented) by/i, w: 2, says: 'Suggestion decisions' },
    { re: /\b(upvotes?|downvotes?)\b/i, w: 2, says: 'Suggestion voting' },
  ],

  giveaways: [
    { re: /\bgiveaway\b/i, w: 3, says: 'Giveaways' },
    { re: /congratulations.{0,40}you won/i, w: 3, says: 'Giveaway winners' },
    { re: /\bhosted by\b/i, w: 2, says: 'Giveaways' },
    { re: /\brerolled?\b/i, w: 2, says: 'Giveaway winners' },
    { re: /react with .{0,6} to enter/i, w: 3, says: 'Giveaways' },
  ],

  polls: [
    { re: /^embed:poll\b/i, w: 3, says: 'Polls' },
    { re: /\bstrawpoll\b/i, w: 3, says: 'Polls' },
    { re: /\bvotes?: \{n\}/i, w: 2, says: 'Polls' },
  ],

  music: [
    { re: /now playing/i, w: 3, says: 'Playback' },
    { re: /added .{0,40}to (the )?queue/i, w: 3, says: 'Queue management' },
    { re: /queue is empty/i, w: 3, says: 'Queue management' },
    { re: /\b(skipped|paused|resumed) (the )?(song|track)/i, w: 3, says: 'Playback' },
    { re: /left the voice channel/i, w: 1, says: 'Playback' },
  ],

  economy: [
    { re: /\b(wallet|bank) balance\b/i, w: 3, says: 'Balances' },
    { re: /you (won|lost) \*?\*?\{n\}/i, w: 3, says: 'Gambling & payouts' },
    { re: /daily (reward|bonus)/i, w: 3, says: 'Daily rewards' },
    { re: /you don.t have enough/i, w: 2, says: 'Balances' },
    { re: /\bcoins?\b|\bcurrency\b/i, w: 1, says: 'Balances' },
    { re: /\binventory\b/i, w: 1, says: 'Inventory' },
  ],

  custom_commands: [
    { re: /^WWW$/i, w: 3, says: 'Custom replies' },
    { re: /[⣿⡏⢸⠉]/, w: 3, says: 'Custom replies' },
    { re: /inch pp/i, w: 3, says: 'Custom replies' },
  ],

  birthday: [
    { re: /\bhappy birthday\b/i, w: 3, says: 'Birthday announcements' },
    { re: /\bbirthday\b/i, w: 2, says: 'Birthday announcements' },
    { re: /🎂/, w: 2, says: 'Birthday announcements' },
  ],

  timezone: [
    { re: /time ?zone/i, w: 3, says: 'Timezone conversions' },
    { re: /it is currently \{n\}/i, w: 3, says: 'Timezone conversions' },
    { re: /converted times/i, w: 3, says: 'Timezone conversions' },
  ],

  free_games: [
    { re: /\*\*free(?: to play)?\*\* until/i, w: 3, says: 'Free-game posts' },
    { re: /open in (browser|steam client|epic games launcher)/i, w: 3, says: 'Free-game posts' },
    { re: /prime gaming/i, w: 3, says: 'Free-game posts' },
    { re: /\bfreestuff\b/i, w: 3, says: 'Free-game posts' },
  ],

  throne: [
    { re: /\bwishlist\b/i, w: 3, says: 'Wishlist activity' },
    { re: /has (gifted|contributed)/i, w: 3, says: 'Wishlist activity' },
  ],

  kofi: [
    { re: /\bko-?fi\b/i, w: 3, says: 'Supporter alerts' },
    { re: /supported us/i, w: 2, says: 'Supporter alerts' },
  ],

  catbot: [
    { re: /\bcats?\b.{0,30}(spawned|appeared|caught)/i, w: 3, says: 'Cat spawns' },
    { re: /achievement get/i, w: 3, says: 'Achievements' },
  ],

  growtree: [
    { re: /\btree\b.{0,30}(grew|watered|is now)/i, w: 3, says: 'Tree growth' },
    { re: /\bwatered\b/i, w: 2, says: 'Tree growth' },
  ],

  owo: [
    { re: /\bcowoncy\b/i, w: 3, says: 'OwO economy' },
    { re: /goes into battle/i, w: 3, says: 'Battles' },
    { re: /hunt is empowered/i, w: 3, says: 'Hunting' },
    { re: /\blootbox\b|\bweapon crate\b/i, w: 3, says: 'Lootboxes' },
    { re: /guild boss/i, w: 3, says: 'Guild boss' },
  ],

  cannabis: [
    { re: /smoke circle/i, w: 3, says: 'Smoke circles' },
    { re: /\b(toke|puff|joint)\b/i, w: 2, says: 'Toke commands' },
  ],

  emoji: [
    { re: /^\{emoji\}$/, w: 2, says: 'Emoji replies' },
    { re: /\bemoji\b.{0,20}(added|stolen|uploaded)/i, w: 3, says: 'Emoji management' },
  ],

  autorole: [
    { re: /auto-?role/i, w: 3, says: 'Auto-role on join' },
  ],

  qotd: [
    { re: /question of the day/i, w: 3, says: 'Question of the day' },
  ],

  events: [
    { re: /\brsvp\b/i, w: 3, says: 'Event RSVPs' },
    { re: /event (starts|begins) (at|in)/i, w: 3, says: 'Event reminders' },
  ],

  soundboard: [
    { re: /\bsoundboard\b/i, w: 3, says: 'Soundboard clips' },
  ],
};

/**
 * Signals for the verdicts that are NOT a feature.
 *
 * These are always in the running, whatever the bot does — any bot can post its own changelog, and
 * the alternative is treating a vendor's product announcement as unexplained behaviour that blocks
 * a retirement.
 */
const NON_FEATURE_SIGNALS = {
  platform_news: [
    // NOT anchored at the start. Discord's broadcasts open with a markdown heading and an emoji
    // ("## 👀 What's that tag? Hey Admins and Mods!"), so an anchored pattern matched barely half of
    // them and the rest were reported as unexplained behaviour by a bot that is not a bot.
    // "Hey Community Admins and Moderators" — the word Community sits between the greeting and the
    // audience, so a pattern that demanded them adjacent missed a third of these.
    { re: /\bhey,? (community )?(admins?|mods?|moderators?),? (and|&) (community )?(mods?|admins?|moderators?)/i, w: 3, says: "Discord's admin broadcasts" },
    { re: /\bhey,? community (admins?|mods?|moderators?)/i, w: 3, says: "Discord's admin broadcasts" },
    { re: /\bfor all (servers|communities)\b/i, w: 2, says: "Discord's admin broadcasts" },
    { re: /is now live to all (communities|servers)/i, w: 3, says: "Discord's admin broadcasts" },
    { re: /\bhello,? admins?,? (and|&) mods?/i, w: 3, says: "Discord's admin broadcasts" },
    { re: /official discord announcements/i, w: 3, says: "Discord's admin broadcasts" },
    { re: /\byour communit(y|ies)\b/i, w: 2, says: "Discord's admin broadcasts" },
    { re: /\bcommunity servers?\b/i, w: 2, says: "Discord's admin broadcasts" },
    { re: /we(?:'|’)?re rolling out|today,? we(?:'|’)?re/i, w: 2, says: "Discord's admin broadcasts" },
    { re: /\bserver guide\b|\bforum channels\b|\bsoundboard\b.{0,40}\broll(ing)? out/i, w: 2, says: "Discord's admin broadcasts" },
  ],
  vendor_news: [
    { re: /@updates\b/i, w: 3, says: 'Product announcements' },
    { re: /^#{1,3} announcing\b/i, w: 3, says: 'Product announcements' },
    { re: /we(?:'|’)?re (very )?excited to (announce|introduce)/i, w: 2, says: 'Product announcements' },
    { re: /scheduled maintenance/i, w: 3, says: 'Status & maintenance notices' },
    { re: /\bchangelog\b/i, w: 3, says: 'Product announcements' },
    { re: /\bnewest,? and free,? module\b/i, w: 3, says: 'Product announcements' },
    { re: /is available right now on every server/i, w: 3, says: 'Product announcements' },
    // Marketing. A vendor selling its premium tier in a followed channel is not a feature this
    // server configured, and it should never have been gating a retirement.
    { re: /\b(black friday|cyber monday)\b/i, w: 3, says: 'Sales & marketing' },
    { re: /premium (plans?|gifting|tiers?)/i, w: 3, says: 'Sales & marketing' },
    { re: /\bfor a limited time\b|\bepic discounts?\b|\{n\}% off\b/i, w: 3, says: 'Sales & marketing' },
    { re: /level up your discord server/i, w: 3, says: 'Sales & marketing' },
    // The setup line Discord posts when a channel is first followed — literally the source's name.
    { re: /^\S+™?\s+#[a-z0-9_-]+$/i, w: 3, says: 'The followed channel itself' },
    // A release-notes embed: a title that lists the release's headline items, then the same items
    // again as field names. "…, and More!" is the shape's own signature.
    { re: /^embed:.{0,100}\band more!/i, w: 3, says: 'Product announcements' },
    { re: /\band more!/i, w: 1, says: 'Product announcements' },
  ],
  media: [
    { re: /^attachment$/i, w: 3, says: 'Posted images' },
    { re: /^embed:\{url\}$/i, w: 3, says: 'Posted links' },
  ],
};

/**
 * What a COMMAND tells us, when the message itself does not.
 *
 * The scan records the command that produced each reply — the slash command name straight off the
 * interaction, or the prefix command a human typed just before it. That is the strongest evidence
 * in the whole dataset and the classifier was throwing it away: Dank Memer's two "unreadable" meme
 * captions were both stamped `/meme`, which is not a guess about what they are, it is the answer.
 *
 * Matched against the command NAME with the prefix stripped, so `/rank`, `!rank` and `pls rank` all
 * land on the same rule.
 */
const TRIGGER_FEATURE = [
  [/^(rank|level|levels|xp|leaderboard|lb|top|profile)$/i, 'leveling', 'Rank & leaderboard cards'],
  [/^(queue|play|skip|np|nowplaying|pause|resume|stop|loop|shuffle|lyrics)$/i, 'music', 'Playback'],
  [/^(bal|balance|daily|weekly|work|beg|deposit|withdraw|shop|buy|inventory|inv|gamble|bet|slots)$/i, 'economy', 'Economy commands'],
  [/^(ticket|new|close|open|support)$/i, 'tickets', 'Ticket lifecycle'],
  [/^(giveaway|gstart|gend|greroll|gcreate)$/i, 'giveaways', 'Giveaways'],
  [/^(suggest|suggestion)$/i, 'suggestions', 'Suggestions'],
  [/^(poll|strawpoll)$/i, 'polls', 'Polls'],
  [/^(warn|ban|unban|kick|mute|unmute|timeout|purge|clear|softban|warnings|cases|case)$/i, 'moderation', 'Moderation actions'],
  [/^(birthday|bday|birthdays)$/i, 'birthday', 'Birthday announcements'],
  [/^(time|timezone|tz)$/i, 'timezone', 'Timezone conversions'],
  [/^(count|counting)$/i, 'counting', 'The count itself'],
  [/^(qotd)$/i, 'qotd', 'Question of the day'],
  [/^(event|events|rsvp)$/i, 'events', 'Event reminders'],
  [/^(emoji|emote|steal|jumbo|enlarge)$/i, 'emoji', 'Emoji management'],
  [/^(tree|water|plant)$/i, 'growtree', 'Tree growth'],
  [/^(cat|catch)$/i, 'catbot', 'Cat spawns'],
  [/^(sound|soundboard|clip)$/i, 'soundboard', 'Soundboard clips'],
  [/^(wishlist|throne)$/i, 'throne', 'Wishlist activity'],
  [/^(role|roles|iam|iamnot|selfrole|rr)$/i, 'reaction_roles', 'Role panels'],
  [/^(welcome|greet)$/i, 'welcome', 'Welcome messages'],
  [/^(fm|np|chart|artist|album|scrobbles?)$/i, 'lastfm', 'Last.fm lookups'],
];

/**
 * Commands that produce a bit of fun and nothing configurable. Not a feature to take over — but a
 * definite ANSWER to "what was this for?", which is what stops it sitting in the retirement gate.
 */
const FUN_TRIGGERS = /^(meme|joke|8ball|dog|cat|gif|pp|ship|rate|roast|hug|pat|slap|say|echo|ascii|coinflip|flip|roll|dice|rps|fortune|advice|quote|inspire)$/i;

/** Prefixes a command can wear. `pls meme`, `!rank`, `/level`, `owo hunt`, `m!play`. */
const stripPrefix = (t) => String(t ?? '')
  .trim()
  .replace(/^(?:[!?$.\-+>~%&*\/]+|\b(?:pls|owo|please)\s+)/i, '')
  .split(/\s+/)[0]
  .toLowerCase();

/**
 * Where a message was posted, as a weak hint.
 *
 * A log entry in #server-logs and a welcome in #welcome are each a little more likely for having
 * been posted there. Weight 1 on purpose: channel names are a convention, not a contract, and
 * plenty of servers put everything in #general. This breaks ties; it never decides anything alone.
 */
const CHANNEL_FEATURE = [
  [/\blogs?\b|audit|modlog/i, 'logging'],
  [/welcome|greet|arrival|lobby/i, 'welcome'],
  [/live|stream|going-?live|notif/i, 'streams'],
  [/count/i, 'counting'],
  [/birthday/i, 'birthday'],
  [/suggest/i, 'suggestions'],
  [/ticket|support|help-?desk/i, 'tickets'],
  [/star(board)?/i, 'starboard'],
  [/level|rank/i, 'leveling'],
  [/music|song|tunes/i, 'music'],
  [/giveaway/i, 'giveaways'],
  [/free-?game|deals/i, 'free_games'],
  [/rules|info|read-?me/i, 'welcome'],
  [/role|self-?assign|pick/i, 'reaction_roles'],
];

/** A shape with no letters in it at all cannot be classified by reading it. */
const hasWords = (s) => /[a-z]{3}/i.test(String(s ?? ''));

/** Order-preserving unique — the head stays the strongest signal's wording. */
const dedupe = (xs) => [...new Set(xs)];

/** The scan stores triggers/channels as a JSON column, which arrives as text or already parsed. */
export function asList(v) {
  const p = parseJson(v);
  if (Array.isArray(p)) return p;
  // `channels` is {channelId: postCount}; its keys are the list.
  if (p && typeof p === 'object') return Object.keys(p);
  return [];
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * Where a shape was posted, and how often, busiest first.
 *
 * Scans taken before the analyzer recorded this store a plain array (or nothing), so a count of 1
 * stands in — enough to keep every caller working, and honest about knowing no more than "it was
 * seen here".
 */
export function channelCounts(v) {
  const p = parseJson(v);
  if (Array.isArray(p)) return p.map(id => ({ id: String(id), count: 1 }));
  if (p && typeof p === 'object') {
    return Object.entries(p)
      .map(([id, count]) => ({ id, count: Number(count) || 0 }))
      .sort((a, b) => b.count - a.count);
  }
  return [];
}

/**
 * Score one sample against one signal set.
 * @returns {{score:number, says:Set<string>}}
 */
function score(sample, signals) {
  let total = 0;
  const hits = [];
  for (const sig of signals) {
    if (!sig.re.test(sample)) continue;
    total += sig.w;
    hits.push(sig);
  }
  // Strongest first. The head of this list becomes the family heading, and taking it in array order
  // instead split one behaviour across two headings — the same 121 Dyno voice logs appeared as
  // "Voice join/leave logs" and "Join/leave logs" depending on which regex happened to be declared
  // first. Same messages, same feature, two rows, and it read like two different things.
  hits.sort((a, b) => b.w - a.w);
  return { total, says: hits.map(h => h.says) };
}

/**
 * Classify one message shape.
 *
 * @param {string} sample          the template, as stored by the analyzer
 * @param {string[]} candidates    the features this bot actually covers. An empty list means "we do
 *                                 not know what this bot does" — only the non-feature verdicts are
 *                                 then available, which is the honest answer.
 * @param {object} [ctx]
 * @param {string[]} [ctx.triggers]     the commands that produced this reply, from the scan
 * @param {string[]} [ctx.channelNames] the channels it was posted in
 * @returns {{feature:string|null, kind:'feature'|'non-feature'|'unknown', confidence:'certain'|'likely'|'unsure',
 *            says:string, matched:string[], score:number, runnerUp:number, command:string|null}}
 */
export function classifyTemplate(sample, candidates = [], ctx = {}) {
  const text = String(sample ?? '');
  const unknown = {
    feature: null, kind: 'unknown', confidence: 'unsure',
    says: 'Not recognised', matched: [], score: 0, runnerUp: 0, command: null,
  };
  if (!text.trim()) return unknown;

  // A truncation marker is the analyzer telling us it ran out of room. It is not a message and must
  // never be auto-cleared: clearing it would hide the fact that the bot's evidence is incomplete.
  if (/^⚠ more than/.test(text)) return unknown;

  const triggers = (ctx.triggers ?? []).filter(t => typeof t === 'string' && t && !/^\{/.test(t));
  const commands = triggers.map(stripPrefix).filter(Boolean);
  const channels = ctx.channelNames ?? [];

  const runners = [];
  const bump = (key, kind, w, says) => {
    const found = runners.find(r => r.key === key && r.kind === kind);
    if (found) { found.total += w; found.says.unshift(says); found.says = dedupe(found.says); }
    else runners.push({ key, kind, total: w, says: [says] });
  };

  for (const f of new Set(candidates)) {
    const signals = SIGNALS[f];
    if (!signals) continue;
    const { total, says } = score(text, signals);
    if (total > 0) runners.push({ key: f, kind: 'feature', total, says: dedupe(says) });
  }
  for (const [k, signals] of Object.entries(NON_FEATURE_SIGNALS)) {
    const { total, says } = score(text, signals);
    if (total > 0) runners.push({ key: k, kind: 'non-feature', total, says: dedupe(says) });
  }

  // ── The command that produced it. The strongest evidence we hold. ──────────
  //
  // Weight 4 — above anything a phrase can score — because it is not a reading of the text at all.
  // Somebody typed `/leaderboard` and this came back; there is no interpretation involved. It is
  // only credited to a feature the bot actually covers, so a stray `/play` cannot invent a music
  // module for a logging bot.
  for (const cmd of commands) {
    for (const [re, feature, says] of TRIGGER_FEATURE) {
      if (!re.test(cmd) || !candidates.includes(feature)) continue;
      bump(feature, 'feature', 4, says);
    }
    if (FUN_TRIGGERS.test(cmd)) bump('media', 'non-feature', 4, `The \`${cmd}\` command`);
  }

  // ── Where it was posted. A tiebreaker, never a decision. ───────────────────
  for (const name of channels) {
    for (const [re, feature] of CHANNEL_FEATURE) {
      if (!re.test(name) || !candidates.includes(feature)) continue;
      const existing = runners.find(r => r.key === feature && r.kind === 'feature');
      // Only ever strengthens a reading the TEXT already supports. On its own, a channel name is
      // not evidence of anything — plenty of servers post everything into #general.
      if (existing) existing.total += 1;
    }
  }

  // ── A reply to a command we cannot otherwise explain IS a custom command. ──
  //
  // This is the whole shape of the thing: somebody types `!foo`, the bot answers with arbitrary
  // text, and no feature signature will ever match it because the text is whatever the server
  // decided it should be. The evidence that it is a custom command is not in the reply — it is in
  // the fact that a command produced it. Recording it is also the only way to take the system over:
  // a bot's command list is private to it, so this is the sole copy that exists.
  if (!runners.length && commands.length && candidates.includes('custom_commands')) {
    return {
      feature: 'custom_commands', kind: 'feature', confidence: 'likely',
      says: 'Custom replies', matched: [`answers \`${triggers[0]}\``],
      score: 3, runnerUp: 0, command: triggers[0],
    };
  }

  // A shape with no words at all — a bare emoji, a lone number, an attachment — is a posted thing,
  // not a behaviour. Treat it as media rather than sending someone off to interpret punctuation.
  if (!runners.length) {
    return hasWords(text) ? unknown
      : { ...unknown, kind: 'non-feature', feature: 'media', confidence: 'likely', says: NON_FEATURES.media.label };
  }

  runners.sort((a, b) => b.total - a.total);
  const [best, second] = runners;
  const runnerUp = second?.total ?? 0;

  // Two thresholds, both required. The floor stops a single weak word deciding anything; the margin
  // stops a coin-flip between two features being reported as a fact.
  const clear = best.total - runnerUp;
  const confidence = best.total >= 3 && clear >= 2 ? 'certain'
    : best.total >= 2 && clear >= 1 ? 'likely'
      : 'unsure';

  if (confidence === 'unsure') {
    return { ...unknown, matched: best.says, score: best.total, runnerUp };
  }

  return {
    feature: best.key,
    kind: best.kind,
    confidence,
    says: best.says[0] ?? (best.kind === 'feature' ? FEATURES[best.key]?.label ?? best.key : NON_FEATURES[best.key]?.label ?? best.key),
    matched: best.says,
    score: best.total,
    runnerUp,
    command: triggers[0] ?? null,
  };
}

/**
 * What did this bot actually do in this server?
 *
 * Groups a bot's message shapes into BEHAVIOUR families rather than listing them one by one. The
 * grouping key is the verdict itself — two shapes that matched the same signals came from the same
 * code path in the bot, whatever names and game titles happen to be in them. This is the difference
 * between "179 things to read" and "two things: go-live announcements and stream-ended notices".
 *
 * @param {Array<{id:number,sample:string,occurrences:number,attributed:number|boolean}>} templates
 * @param {string[]} candidates  the features the bot covers
 * @returns {{families:Array, unexplained:number, explained:number}}
 */
export function summariseBot(templates, candidates = []) {
  const families = new Map();

  for (const t of templates ?? []) {
    const verdict = classifyTemplate(t.sample, candidates, {
      triggers: asList(t.triggers),
      channelNames: asList(t.channelNames),
    });
    const key = `${verdict.kind}:${verdict.feature ?? 'unknown'}:${verdict.says}`;

    const fam = families.get(key) ?? {
      key,
      feature: verdict.feature,
      kind: verdict.kind,
      says: verdict.says,
      confidence: verdict.confidence,
      // What we offer instead. Null for a non-feature — there is nothing to offer, and saying
      // "replaced by /x" about a changelog would be a lie with a command name in it.
      replacement: verdict.kind === 'feature' ? (FEATURES[verdict.feature]?.replacement ?? null) : null,
      detail: verdict.kind === 'non-feature' ? NON_FEATURES[verdict.feature]?.detail ?? null : null,
      shapes: 0,
      occurrences: 0,
      attributed: 0,
      templateIds: [],
      examples: [],
      // The commands that produced this behaviour. For custom replies this IS the takeover: a bot's
      // command list is private to it, so the pairs we caught on camera are the only copy anywhere.
      commands: [],
      // channelId -> posts. A server that splits its logs across six channels is doing something we
      // can reproduce exactly, but only if we know which behaviour went where.
      channels: new Map(),
    };

    fam.shapes += 1;
    fam.occurrences += Number(t.occurrences) || 0;
    if (t.attributed) fam.attributed += 1;
    fam.templateIds.push(t.id);
    if (fam.examples.length < 3) fam.examples.push(String(t.sample).slice(0, 180));
    for (const c of asList(t.triggers)) if (!fam.commands.includes(c)) fam.commands.push(c);
    for (const { id, count } of channelCounts(t.channels)) {
      fam.channels.set(id, (fam.channels.get(id) ?? 0) + count);
    }
    // A family is only as confident as its least confident member.
    if (verdict.confidence === 'unsure') fam.confidence = 'unsure';
    else if (verdict.confidence === 'likely' && fam.confidence === 'certain') fam.confidence = 'likely';

    families.set(key, fam);
  }

  const list = [...families.values()]
    .map(f => ({
      ...f,
      channels: [...f.channels.entries()]
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.occurrences - a.occurrences);
  return {
    families: list,
    explained: list.filter(f => f.kind !== 'unknown').reduce((n, f) => n + f.shapes, 0),
    unexplained: list.filter(f => f.kind === 'unknown').reduce((n, f) => n + f.shapes, 0),
    // Command → reply, recovered from the scan. The one thing in a takeover that cannot be read
    // from any API and cannot be reconstructed later: once the bot leaves, this is gone.
    customCommands: recoverCommands(templates, candidates),
  };
}

/**
 * Custom commands, recovered from what the bot was seen answering.
 *
 * Only from shapes NOTHING else explains. A reply to `/rank` is the levelling module answering, not
 * a custom command somebody wrote — attributing it here would have us "recreate" a command that was
 * never written, which is worse than missing one.
 */
export function recoverCommands(templates, candidates = []) {
  const out = new Map();
  for (const t of templates ?? []) {
    const triggers = asList(t.triggers).filter(x => typeof x === 'string' && x && !/^\{/.test(x));
    if (!triggers.length) continue;

    const v = classifyTemplate(t.sample, candidates, { triggers, channelNames: asList(t.channelNames) });
    if (v.feature !== 'custom_commands') continue;

    for (const trigger of triggers) {
      const prev = out.get(trigger);
      out.set(trigger, {
        trigger,
        name: stripPrefix(trigger),
        prefix: (trigger.match(/^[^a-z0-9]+/i) ?? [''])[0] || null,
        response: String(t.sample ?? '').slice(0, 500),
        occurrences: (prev?.occurrences ?? 0) + (Number(t.occurrences) || 0),
      });
    }
  }
  return [...out.values()].sort((a, b) => b.occurrences - a.occurrences);
}

export default { classifyTemplate, summariseBot, NON_FEATURES };
