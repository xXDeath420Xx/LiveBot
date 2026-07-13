/*
 * The questions we put to the server owner, and the ONLY answers the server will accept.
 *
 * This file is the single source of truth for both ends. The page renders from it, and the save
 * endpoint validates against it — an unauthenticated form on a public URL must never be able to
 * write a key or a value we did not author. `note` is the one place free text is allowed, and it is
 * length-capped and stored as text, never interpreted.
 *
 * Nothing answered here is applied automatically. These are intentions; a human still runs the step.
 */

export const QUESTIONS = Object.freeze([
  {
    key: 'kofi',
    section: 'Decisions',
    q: 'Ko-fi supporter roles',
    why: 'Ko-fi keeps a token that only you can copy out of your own Ko-fi settings — no bot can fetch it. '
       + 'It is the one thing in this whole plan we genuinely cannot do for you.',
    options: [
      { v: 'token', label: "I'll get the token", detail: 'Kabbot takes over supporter roles automatically' },
      { v: 'keep',  label: 'Leave Ko-fi Bot alone', detail: 'It stays in the server, nothing changes' },
      { v: 'drop',  label: "Drop it — I don't use it", detail: 'Ko-fi Bot leaves, no supporter roles' },
    ],
    note: 'Anything else about Ko-fi?',
  },
  {
    key: 'disboard',
    section: 'Decisions',
    q: 'DISBOARD server listing',
    why: 'DISBOARD lists the server on a public "find a server" site. It is not something we would replace — '
       + 'it is really a question of whether you want the listing at all.',
    options: [
      { v: 'keep',   label: 'Keep the listing', detail: 'DISBOARD stays' },
      { v: 'remove', label: 'Take us off it',   detail: 'DISBOARD leaves; the server goes back to word of mouth' },
    ],
  },
  {
    key: 'blerp',
    section: 'Decisions',
    q: 'Blerp soundboard',
    why: 'Kabbot has a soundboard — upload clips, get a panel of buttons. What it does not have is Blerp\'s big '
       + 'hosted library of sounds nobody here uploaded.',
    options: [
      { v: 'keep',   label: 'Keep Blerp',   detail: 'People use it for the library' },
      { v: 'move',   label: 'Move our clips over', detail: "It's really only a few clips — Blerp leaves" },
      { v: 'unsure', label: "Not sure — I'll ask", detail: "Let me check who actually uses it" },
    ],
  },
  {
    key: 'tree',
    section: 'Decisions',
    q: 'The tree',
    why: 'We can read your tree live: it is called "Kababi", it is 193ft tall, and we know who watered it last. '
       + 'So starting over is a choice, not something forced on you.',
    options: [
      { v: 'carry', label: 'Carry it over at 193ft', detail: 'Same tree, same height, nobody loses progress' },
      { v: 'fresh', label: 'Start fresh from a sapling', detail: 'A clean 3ft start for everyone' },
      { v: 'keep',  label: 'Leave the old bot', detail: 'Grow a Tree stays; we do not run a tree' },
    ],
    note: 'If you want a "natural disaster" story for the reset, tell us what to say.',
  },
  {
    key: 'owo',
    section: 'Decisions',
    q: 'Your OwO progress',
    why: 'From your profile we can read Level 29, 30,491 XP, and your three team animals at level 26. '
       + 'Your cowoncy balance is the one thing OwO has never printed anywhere, so it cannot be read.',
    options: [
      { v: 'carry',  label: 'Carry over what we can read', detail: 'Level 29, XP and your team come across' },
      { v: 'fresh',  label: 'Everyone starts fresh', detail: 'A clean slate for the whole server' },
      { v: 'keep',   label: 'Leave OwO alone', detail: 'The real OwO stays; we do not run it' },
    ],
    note: 'Roughly how much cowoncy did you have? We can set it if you tell us.',
  },
  {
    key: 'spare_roles',
    section: 'Roles',
    q: 'Seven spare roles',
    why: 'The tidy-up leaves 7 empty roles going spare. They would make good game or interest roles, but you know '
       + 'what this server actually plays and we do not.',
    options: [
      { v: 'names',  label: "I'll name them", detail: 'Write them below and we will build a pick-a-role panel' },
      { v: 'skip',   label: 'Leave them empty for now', detail: 'We will not touch them' },
    ],
    note: 'One per line — e.g. Fortnite, Minecraft, Movie Nights…',
  },
  {
    key: 'roles_ok',
    section: 'Roles',
    q: 'The role clean-up',
    why: 'Renaming 21 empty duplicate roles into regions, timezones, colours and ping roles. Nothing with a person '
       + 'in it is touched, and nothing is deleted.',
    options: [
      { v: 'go',    label: 'Go ahead' },
      { v: 'hold',  label: 'Hold off for now' },
    ],
  },
  {
    key: 'panels_ok',
    section: 'Roles',
    q: 'Replacing the role panels',
    why: 'The new button panels go up and Carl-bot\'s old reaction panels come down in the same step. Once Carl-bot '
       + 'leaves, its old panels still show their reactions but silently do nothing, so leaving them up is worse.',
    options: [
      { v: 'go',   label: 'Go ahead' },
      { v: 'hold', label: 'Hold off for now' },
    ],
  },
  {
    key: 'sec_alt',
    section: 'Security',
    q: 'The ALT role',
    why: 'A role called ALT carries most of the admin powers (kick, ban, manage roles and channels) and sits on one '
       + 'account. It may well be deliberate — you would know better than us.',
    options: [
      { v: 'intended', label: "That's intentional", detail: 'Leave it alone' },
      { v: 'strip',    label: 'Strip its powers',   detail: 'It should not have those' },
      { v: 'unsure',   label: 'Not sure what it is', detail: "We'll dig into it before touching anything" },
    ],
  },
  {
    key: 'sec_2fa',
    section: 'Security',
    q: 'Require 2FA for moderators',
    why: 'Discord has a toggle that requires two-factor auth on any account with moderation powers. It is currently off.',
    options: [
      { v: 'on',   label: 'Turn it on' },
      { v: 'off',  label: 'Leave it off' },
    ],
  },
  {
    key: 'sec_verify',
    section: 'Security',
    q: 'Verification level',
    why: 'Currently Low, which lets a brand-new account post the moment it joins. Raising it is the usual first '
       + 'defence against a raid.',
    options: [
      { v: 'raise', label: 'Raise it' },
      { v: 'keep',  label: 'Leave it as it is' },
    ],
  },
  // ── Free text. No options on purpose: these exist to catch everything the questions above did
  //    not think to ask. A plan built only from our own questions only ever confirms our own
  //    assumptions.
  {
    key: 'qcc_questions',
    section: 'Questions, comments, concerns',
    q: 'Questions',
    why: 'Anything you want explained before you agree to any of it. No such thing as too small.',
    options: [],
    note: 'What do you want to know?',
  },
  {
    key: 'qcc_comments',
    section: 'Questions, comments, concerns',
    q: 'Comments',
    why: 'Anything the bots do that matters to you, anything you have always wanted, anything we got wrong above.',
    options: [],
    note: 'Tell us anything.',
  },
  {
    key: 'qcc_concerns',
    section: 'Questions, comments, concerns',
    q: 'Concerns',
    why: 'Anything that worries you about changing this over — the server, the members, the timing, us. '
       + 'We would much rather hear it now than after.',
    options: [],
    note: "What are you worried about?",
  },
]);

/**
 * Everything else the bot can do, offered as a menu.
 *
 * The questions above are about REPLACING what she already has. This is the opposite: things her
 * server has never had, that she can simply switch on. Nothing here is implied by the takeover and
 * nothing here happens unless she asks for it.
 *
 * Three answers, and the third one matters most: 'explain' means "I don't know what this is". A menu
 * that only offers yes/no quietly punishes not knowing, and the honest answer to half of these — for
 * anyone who has not run them — is "what does that actually do in practice?".
 *
 * `have` marks the handful already covered by the takeover, so she can see them without being asked
 * to choose something she is already getting.
 */
export const CATALOGUE = Object.freeze([
  // ── Keeping the server safe. She currently has almost none of this. ──────────
  { key: 'feat_antinuke',     group: 'Keeping the server safe', name: 'Anti-nuke',
    what: 'If someone with power goes rogue — mass-deleting channels, mass-banning — it stops them mid-way and strips their roles.' },
  { key: 'feat_antiraid',     group: 'Keeping the server safe', name: 'Raid protection',
    what: 'Spots a flood of new accounts joining at once and locks the door until you look at it.' },
  { key: 'feat_antispam',     group: 'Keeping the server safe', name: 'Anti-spam',
    what: 'Catches someone posting the same thing over and over, across channels, and times them out.' },
  { key: 'feat_phishing',     group: 'Keeping the server safe', name: 'Scam link detection',
    what: 'Deletes "free Nitro" and Steam-scam links before anyone clicks them.' },
  { key: 'feat_scamimage',    group: 'Keeping the server safe', name: 'Scam image detection',
    what: 'Reads the text inside images, so a scam posted as a screenshot is caught too.' },
  { key: 'feat_automod',      group: 'Keeping the server safe', name: 'Word filters & automod',
    what: 'Your own banned-word list, link rules and invite blocking.' },
  { key: 'feat_globalban',    group: 'Keeping the server safe', name: 'Shared ban list',
    what: 'Someone banned for scamming elsewhere in our network cannot walk into your server.' },
  { key: 'feat_verify',       group: 'Keeping the server safe', name: 'Verification gate',
    what: 'New members click "I agree" before they can see or say anything.' },

  // ── Running the place ───────────────────────────────────────────────────────
  { key: 'feat_tickets',      group: 'Running the place', name: 'Support tickets',
    what: 'A button that opens a private channel between a member and your staff.' },
  { key: 'feat_warnings',     group: 'Running the place', name: 'Warnings that escalate',
    what: 'Warn someone; repeat offences automatically step up to mute, then kick, on your rules.' },
  { key: 'feat_welcome',      group: 'Running the place', name: 'Welcome messages',
    what: 'Greet people when they join, in your own words, with an image if you want one.' },
  { key: 'feat_suggestions',  group: 'Running the place', name: 'Suggestions box',
    what: 'Members suggest things, everyone votes, staff approve or decline with a reason.' },
  { key: 'feat_starboard',    group: 'Running the place', name: 'Starboard',
    what: 'Funny messages that get enough ⭐ get reposted to a hall-of-fame channel.' },
  { key: 'feat_serverstats',  group: 'Running the place', name: 'Live stat channels',
    what: 'Voice channels that show your member count, or a live clock in your timezone.' },
  { key: 'feat_announce',     group: 'Running the place', name: 'Scheduled announcements',
    what: 'Write it once, it posts every Friday at 8pm — or whenever you like.' },
  { key: 'feat_afk',          group: 'Running the place', name: 'AFK',
    what: 'Set yourself away; anyone who pings you is told why you are not answering.' },

  // ── Giving people a reason to hang around ───────────────────────────────────
  { key: 'feat_leveling',     group: 'Giving people a reason to stay', name: 'Levels & XP',
    what: 'People earn XP for chatting, level up, and can unlock roles for it. Comes with rank cards.' },
  { key: 'feat_achievements', group: 'Giving people a reason to stay', name: 'Achievements',
    what: 'Unlockable badges for doing things in the server.' },
  { key: 'feat_giveaways',    group: 'Giving people a reason to stay', name: 'Giveaways',
    what: 'Timed giveaways with a button to enter and a fair random draw.' },
  { key: 'feat_polls',        group: 'Giving people a reason to stay', name: 'Polls',
    what: 'Proper polls with live results.' },
  { key: 'feat_qotd',         group: 'Giving people a reason to stay', name: 'Question of the day',
    what: 'A new question posted every day to get the chat moving.' },
  { key: 'feat_events',       group: 'Giving people a reason to stay', name: 'Event schedule',
    what: 'A visual timetable of what is on and when — good for stream schedules.' },
  { key: 'feat_reminders',    group: 'Giving people a reason to stay', name: 'Reminders',
    what: '"Remind me in 3 hours" and it does.' },
  { key: 'feat_tags',         group: 'Giving people a reason to stay', name: 'Tags / FAQ snippets',
    what: 'Save a canned answer and pull it up with one word.' },

  // ── Games ───────────────────────────────────────────────────────────────────
  { key: 'feat_fishing',      group: 'Games', name: 'Fishing',
    what: 'A full fishing game — rods, rare catches, a bestiary, tournaments and pets.' },
  { key: 'feat_pokemon',      group: 'Games', name: 'Pokémon',
    what: 'Pokémon spawn in chat and people race to catch them.' },
  { key: 'feat_rpg',          group: 'Games', name: 'Dungeons & Dragons',
    what: 'A proper D&D game with an AI dungeon master, characters, parties and campaigns.' },
  { key: 'feat_cah',          group: 'Games', name: 'Cards Against Humanity',
    what: 'Play in Discord or in a browser. You can write your own cards.' },
  { key: 'feat_trivia',       group: 'Games', name: 'Trivia & quizzes',
    what: 'Trivia, hangman, word games, a music quiz.' },
  { key: 'feat_economy',      group: 'Games', name: 'Coins, shop & gambling',
    what: 'A server currency people earn and spend — a shop, pets, and gambling if you want it.' },
  { key: 'feat_lfg',          group: 'Games', name: 'Looking-for-group',
    what: 'Post that you want people for a game; others click to join.' },

  // ── Music and voice ─────────────────────────────────────────────────────────
  { key: 'feat_music',        group: 'Music & voice', name: 'Music player',
    what: 'Play music in voice from Spotify, YouTube or SoundCloud, with a control panel.' },
  { key: 'feat_soundboard',   group: 'Music & voice', name: 'Soundboard',
    what: 'Upload your own clips and play them into voice with a button panel. This is the Blerp replacement.' },
  { key: 'feat_vcguard',      group: 'Music & voice', name: 'Locked voice channels',
    what: 'A voice channel only certain people can sit in — anyone else is removed automatically.' },
  { key: 'feat_tts',          group: 'Music & voice', name: 'Text to speech',
    what: 'Type it, the bot says it in voice.' },

  // ── For the stream ──────────────────────────────────────────────────────────
  { key: 'feat_selfpromo',    group: 'For the stream', name: 'Member stream promotion',
    what: 'Members sign themselves up and get announced when they go live — no work for you.' },
  { key: 'feat_socialfeeds',  group: 'For the stream', name: 'Social feeds',
    what: 'Auto-post your new YouTube, TikTok, Twitter, Bluesky or Reddit posts into the server.' },
  { key: 'feat_twitchsched',  group: 'For the stream', name: 'Twitch schedule',
    what: 'Your Twitch schedule, mirrored into Discord and kept up to date.' },
  { key: 'feat_gamepatch',    group: 'For the stream', name: 'Game update watcher',
    what: 'Tells the server when a game you follow gets patched.' },

  // ── Money ───────────────────────────────────────────────────────────────────
  { key: 'feat_bmac',         group: 'Money', name: 'Buy Me a Coffee',
    what: 'Supporter roles, same as Ko-fi but for BMAC.' },
  { key: 'feat_fourthwall',   group: 'Money', name: 'Fourthwall shop',
    what: 'Announce orders from your merch store and give buyers a role.' },

  // ── Odds and ends ───────────────────────────────────────────────────────────
  { key: 'feat_grow',         group: 'Odds & ends', name: 'Grow journal',
    what: 'A proper grow tracker — log your plants, stages, feeding, photos, with reminders and stats.' },
  { key: 'feat_confessions',  group: 'Odds & ends', name: 'Anonymous confessions',
    what: 'Members post anonymously; staff can still trace abuse.' },
  { key: 'feat_weather',      group: 'Odds & ends', name: 'Weather & lookups',
    what: 'Weather, translation, QR codes, colour tools, unit conversion.' },
  { key: 'feat_selfcare',     group: 'Odds & ends', name: 'Self-care nudges',
    what: 'Gentle "drink water / stand up" reminders. Some servers love it, some find it annoying.' },
]);

/** The answers a catalogue row will accept. Anything else is a rejected write. */
export const CATALOGUE_VALUES = Object.freeze(['yes', 'no', 'explain']);

/** Fast lookups for the save endpoint. Built once; neither list changes at runtime. */
const BY_KEY = new Map(QUESTIONS.map(q => [q.key, q]));
const CAT_BY_KEY = new Map(CATALOGUE.map(c => [c.key, c]));

export const MAX_NOTE = 2000;

/**
 * Is this a write we are willing to accept from an unauthenticated page?
 *
 * Returns a reason string when it is not. A key we did not author, or a value that is not one of the
 * options we offered, is rejected outright — the form is public, so the server must not trust it.
 */
export function validateAnswer(key, value, note) {
  const q = BY_KEY.get(key) ?? CAT_BY_KEY.get(key);
  if (!q) return 'unknown question';

  // A catalogue row has no `options` — its answers are the fixed three.
  const allowed = q.options ? q.options.map(o => o.v) : CATALOGUE_VALUES;

  if (value !== null && value !== undefined && value !== '') {
    if (!allowed.includes(value)) return 'not one of the offered answers';
  }
  // A note is accepted on EVERY question, even ones that do not prompt for one. If she wants to
  // explain an answer we did not invite an explanation for, that explanation is the most valuable
  // thing on the page and refusing it on a technicality would be absurd.
  if (note != null && typeof note !== 'string') return 'note must be text';
  if (typeof note === 'string' && note.length > MAX_NOTE) return `note is longer than ${MAX_NOTE} characters`;

  return null;
}

export default { QUESTIONS, CATALOGUE, CATALOGUE_VALUES, validateAnswer, MAX_NOTE };
