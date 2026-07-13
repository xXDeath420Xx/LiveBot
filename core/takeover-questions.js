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

/** Fast lookups for the save endpoint. Built once; the questions never change at runtime. */
const BY_KEY = new Map(QUESTIONS.map(q => [q.key, q]));

export const MAX_NOTE = 2000;

/**
 * Is this a write we are willing to accept from an unauthenticated page?
 *
 * Returns a reason string when it is not. A key we did not author, or a value that is not one of the
 * options we offered, is rejected outright — the form is public, so the server must not trust it.
 */
export function validateAnswer(key, value, note) {
  const q = BY_KEY.get(key);
  if (!q) return 'unknown question';

  if (value !== null && value !== undefined && value !== '') {
    if (!q.options.some(o => o.v === value)) return 'not one of the offered answers';
  }
  // A note is accepted on EVERY question, even ones that do not prompt for one. If she wants to
  // explain an answer we did not invite an explanation for, that explanation is the most valuable
  // thing on the page and refusing it on a technicality would be absurd.
  if (note != null && typeof note !== 'string') return 'note must be text';
  if (typeof note === 'string' && note.length > MAX_NOTE) return `note is longer than ${MAX_NOTE} characters`;

  return null;
}

export default { QUESTIONS, validateAnswer, MAX_NOTE };
