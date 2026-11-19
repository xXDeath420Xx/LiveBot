/*
 * What the owner actually asked for.
 *
 * The questionnaire was pointless if nothing reads it. This turns the owner's answers into the gates
 * the plan runs on, so a step they declined cannot be applied by someone clicking "apply all" — the
 * refusal lives in the plan itself rather than in whoever happens to be holding the mouse.
 *
 * The line this module will not cross: it reads the STRUCTURED answers (the option they picked) and
 * acts on them. It does not read their prose and guess. Every question has a fixed set of options
 * precisely so intent is machine-readable; a note is a human talking to a human, and code that
 * regex-greps free text to decide whether to post a panel will eventually silently do the opposite
 * of what they wrote. So notes are ATTACHED to the step they concern and shown to the operator, and
 * where a note carries a real instruction it becomes reviewed per-guild data with those words quoted
 * beside it — never a pattern match at runtime.
 *
 * The two exceptions are the fields that were explicitly asked for AS lists: the spare role names
 * ("one per line") and the Ko-fi token. Both are validated by shape and echoed back, so a bad parse
 * is visible rather than silent.
 */
import pool from '../utils/db.js';
import { getQuestionnaire } from './takeover-questionnaire.js';
import { QUESTIONS, CATALOGUE } from './takeover-questions.js';

const QUESTION_KEYS = new Set(QUESTIONS.map(q => q.key));
const FEATURE_KEYS = new Set(CATALOGUE.map(c => c.key));
const CAT_BY_KEY = new Map(CATALOGUE.map(c => [c.key, c]));

/**
 * Which answer governs which plan step.
 *
 * A step with no entry here is not something we asked about, so it is not gated — silence is not
 * consent, but it is also not refusal, and inventing a "no" from a question we never put to them
 * would be its own kind of lie.
 */
export const STEP_DECISION = Object.freeze({
  growtree: 'tree',
  owo: 'owo',
  kofi: 'kofi',
  carlbot_panels: 'panels_ok',
  platform_emoji: 'panels_ok',   // the emoji exist only to be used BY those panels
});

/**
 * The generated questionnaire asks about a bot per FEATURE — `bot_streams`, `bot_logging` — so a
 * step's gate has to be found by feature too.
 *
 * Without this, an owner could answer "Keep Streamcord" on their own form and the plan would still
 * offer to take its streams over: the answer was recorded under a key no gate was looking for. The
 * stable keys above still win where both exist, because those questions are worded to gate one
 * specific step rather than a whole bot.
 */
const STEP_FEATURE_KEY = Object.freeze({
  counting: 'counting', logging: 'logging', timezone: 'timezone', catbot: 'catbot',
  growtree: 'growtree', owo: 'owo', birthday: 'birthday', kofi: 'kofi',
  protection: 'moderation', free_games: 'free_games', throne: 'throne', streams: 'streams',
  leveling: 'leveling', custom_commands: 'custom_commands',
  nightbot_commands: 'custom_commands', nightbot_autoresponses: 'custom_commands',
  carlbot_panels: 'reaction_roles', emoji_ready: 'emoji', cannabis_ready: 'cannabis',
});

/** `setup_welcome` / `have_music` — the sweep's own keys carry their feature in the name. */
function featureOfStep(stepKey) {
  const m = /^(?:setup|have)_(.+)$/.exec(stepKey);
  return m ? m[1] : STEP_FEATURE_KEY[stepKey] ?? null;
}

/** Answers that mean "don't do this step". Everything else is a go. */
const DECLINE = Object.freeze({
  tree: ['keep'],          // leave the old Grow a Tree bot in place
  owo: ['keep'],           // leave the real OwO in place
  kofi: ['keep', 'drop'],  // leave Ko-fi Bot alone / drop Ko-fi entirely
  panels_ok: ['hold'],
  roles_ok: ['hold'],
});

/** On a generated `bot_<feature>` question, "keep the old bot" is the refusal. */
const BOT_DECLINE = Object.freeze(['keep', 'remove', 'hold']);

/** A Ko-fi verification token is a UUID. Anything else in that box is a note, not a token. */
const KOFI_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A leading list marker — "- ", "* ", "• ", "1. ", "2) ".
 *
 * The trailing \s+ is doing real work. An earlier version of this stripped the character CLASS
 * [-*•\d.)] and destroyed the answer it was given: "18-20" is entirely digits and a hyphen, so it
 * was eaten down to nothing and vanished, and "21+" came out as "+". Two of the seven roles the owner
 * asked for were silently wrong. A marker is only a marker when something follows it.
 */
const LIST_MARKER = /^(?:[-*•]|\d{1,2}[.)])\s+/;

/**
 * Split a "one per line" answer into names.
 *
 * The owner was invited to write a list, so parsing one is not guesswork. Commas and newlines both,
 * because people do both and being pedantic about which would just lose the answer.
 *
 * Nothing here may quietly change what they typed. A name that survives stripping is used as-is; if
 * stripping would empty it, the original wins — because a role called "21+" is a perfectly good role
 * name and our tidying is worth less than their answer.
 */
export function parseRoleNames(note) {
  if (!note) return [];
  return note
    .split(/[\n,]+/)
    .map(s => {
      const raw = s.trim();
      const stripped = raw.replace(LIST_MARKER, '').trim();
      return stripped || raw;
    })
    .filter(Boolean)
    .slice(0, 25);
}

/**
 * Read the owner's answers for a guild.
 *
 * Returns a plain object even when nothing has been answered — an absent questionnaire means "nobody has
 * not told us", which every caller must handle anyway, and making them null-check first would just
 * mean they forget to.
 */
export async function loadDecisions(guildId) {
  const [rows] = await pool.execute(
    'SELECT item_key, value, note, updated_at FROM takeover_questionnaire WHERE guild_id = ?', [guildId]);
  const by = new Map(rows.map(r => [r.item_key, r]));

  // THIS guild's own questions, not the static list.
  //
  // The static list is the set hand-written for the first server this tool touched. Counting a
  // generated questionnaire against it reports "9 of 16 answered" for a form that has 11 questions;
  // worse, every `bot_*` answer the owner actually gave is invisible, because none of those keys
  // exist in the static set. An owner could answer every question on their page and the plan would
  // show none of it — while confidently displaying three answers about bots that are not in their
  // server at all, left over from an older form.
  const set = await getQuestionnaire(guildId).catch(() => null);
  const questionSet = set?.decisions?.length ? set.decisions : QUESTIONS;
  const catalogueSet = set?.catalogue?.length ? set.catalogue : CATALOGUE;
  const askedKeys = new Set([...questionSet, ...catalogueSet].map(q => q.key));

  const value = key => by.get(key)?.value ?? null;
  const note = key => {
    const n = by.get(key)?.note;
    return n && String(n).trim() ? String(n).trim() : null;
  };

  // Counted separately, because they are different things. Lumping the 45 catalogue rows in with the
  // 16 questions is how you end up reporting "61 of 16 answered".
  const answeredQuestions = questionSet.filter(q => value(q.key) || note(q.key)).length;
  const answeredFeatures = catalogueSet.filter(c => value(c.key)).length;

  const features = { yes: [], no: [], explain: [] };
  for (const c of catalogueSet) {
    const v = value(c.key);
    if (v && features[v]) features[v].push(c);
  }

  // Only trust the token box when the owner actually picked "I'll get the token", and only when what they
  // pasted IS one. Otherwise a note like "I'll find it later" would be stored as a webhook secret.
  const kofiNote = note('kofi');
  const kofiToken = value('kofi') === 'token' && kofiNote && KOFI_TOKEN_RE.test(kofiNote) ? kofiNote : null;
  const kofiTokenMalformed = value('kofi') === 'token' && kofiNote && !kofiToken ? kofiNote : null;

  const spareRoleNames = value('spare_roles') === 'names' ? parseRoleNames(note('spare_roles')) : [];

  const updatedAt = rows.reduce((max, r) => {
    const t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    return t > max ? t : max;
  }, 0);

  return {
    guildId,
    // Answers to questions THIS owner was actually shown. An orphan — a row left over from an older
    // form, about a bot that is not in this server — is not a decision anybody made here.
    any: rows.some(r => askedKeys.has(r.item_key)),
    questionSet,
    catalogueSet,
    orphans: rows.filter(r => !askedKeys.has(r.item_key)).map(r => r.item_key),
    questions: { answered: answeredQuestions, total: questionSet.length },
    catalogue: { answered: answeredFeatures, total: catalogueSet.length },
    complete: answeredQuestions === questionSet.length && answeredFeatures === catalogueSet.length,
    updatedAt: updatedAt || null,

    value,
    note,

    /** 'yes' | 'no' | 'explain' | null */
    feature: key => (catalogueSet.some(c => c.key === key) ? value(key) : null),
    wants: key => value(key) === 'yes',
    declined: key => value(key) === 'no',

    features,
    /** Things the owner said yes to that this server does not already have. */
    wanted: features.yes,
    /** Things the owner explicitly does NOT want. Do not switch these on because they seemed nice. */
    unwanted: features.no,
    /** "I don't know what this is" — these are questions back to us, not answers. */
    needsExplaining: features.explain,

    kofiToken,
    kofiTokenMalformed,
    spareRoleNames,

    /**
     * Did the owner tell us not to do this step?
     * @returns {{declined:boolean, key:string|null, value:string|null, note:string|null}}
     */
    forStep(stepKey) {
      // A step-specific question first, then the generated per-bot one for the same feature.
      const stable = STEP_DECISION[stepKey];
      if (stable && value(stable) !== null) {
        const v = value(stable);
        return { declined: !!v && (DECLINE[stable] ?? []).includes(v), key: stable, value: v, note: note(stable) };
      }

      const feature = featureOfStep(stepKey);
      const botKey = feature ? `bot_${feature}` : null;
      if (botKey && value(botKey) !== null) {
        const v = value(botKey);
        return { declined: BOT_DECLINE.includes(v), key: botKey, value: v, note: note(botKey) };
      }

      // Nothing was asked. Silence is not consent, but it is not refusal either.
      return { declined: false, key: stable ?? botKey, value: null, note: stable ? note(stable) : (botKey ? note(botKey) : null) };
    },

    raw: rows,
  };
}

/**
 * A short human summary of everything the owner asked for, for the top of the plan.
 *
 * This exists so the operator reads those intentions before the step list rather than after — the plan
 * is a list of things WE can do, and it is very easy to work down it having never noticed the owner said
 * no to two of them.
 */
export function summarizeDecisions(d) {
  if (!d.any) return null;
  const set = d.questionSet ?? QUESTIONS;
  const pick = key => {
    const q = set.find(x => x.key === key);
    const v = d.value(key);
    const opt = q?.options?.find(o => o.v === v);
    return { key, q: q?.q ?? key, answer: opt?.label ?? v ?? null, note: d.note(key) };
  };
  return {
    complete: d.complete,
    questions: d.questions,
    catalogue: d.catalogue,
    updatedAt: d.updatedAt,
    decisions: set.map(q => pick(q.key)).filter(x => x.answer || x.note),
    wanted: d.wanted.map(c => ({ key: c.key, name: c.name, group: c.group })),
    unwanted: d.unwanted.map(c => ({ key: c.key, name: c.name, group: c.group })),
    needsExplaining: d.needsExplaining.map(c => ({ key: c.key, name: c.name, what: c.what })),
    spareRoleNames: d.spareRoleNames,
    kofiToken: d.kofiToken ? 'supplied' : d.kofiTokenMalformed ? 'malformed' : 'missing',
  };
}

export default { loadDecisions, summarizeDecisions, parseRoleNames, STEP_DECISION };
