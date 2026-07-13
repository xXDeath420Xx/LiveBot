/*
 * What the owner actually asked for.
 *
 * The questionnaire was pointless if nothing reads it. This turns her answers into the gates the
 * plan runs on, so a step she declined cannot be applied by someone clicking "apply all" — the
 * refusal lives in the plan itself rather than in whoever happens to be holding the mouse.
 *
 * The line this module will not cross: it reads the STRUCTURED answers (the option she picked) and
 * acts on them. It does not read her prose and guess. Every question has a fixed set of options
 * precisely so intent is machine-readable; a note is a human talking to a human, and code that
 * regex-greps free text to decide whether to post a panel will eventually silently do the opposite
 * of what she wrote. So notes are ATTACHED to the step they concern and shown to the operator, and
 * where a note carries a real instruction it becomes reviewed per-guild data with her words quoted
 * beside it — never a pattern match at runtime.
 *
 * The two exceptions are the fields that were explicitly asked for AS lists: the spare role names
 * ("one per line") and the Ko-fi token. Both are validated by shape and echoed back, so a bad parse
 * is visible rather than silent.
 */
import pool from '../utils/db.js';
import { QUESTIONS, CATALOGUE } from './takeover-questions.js';

const QUESTION_KEYS = new Set(QUESTIONS.map(q => q.key));
const FEATURE_KEYS = new Set(CATALOGUE.map(c => c.key));
const CAT_BY_KEY = new Map(CATALOGUE.map(c => [c.key, c]));

/**
 * Which answer governs which plan step.
 *
 * A step with no entry here is not something we asked about, so it is not gated — silence is not
 * consent, but it is also not refusal, and inventing a "no" from a question we never put to her
 * would be its own kind of lie.
 */
export const STEP_DECISION = Object.freeze({
  growtree: 'tree',
  owo: 'owo',
  kofi: 'kofi',
  carlbot_panels: 'panels_ok',
  platform_emoji: 'panels_ok',   // the emoji exist only to be used BY those panels
});

/** Answers that mean "don't do this step". Everything else is a go. */
const DECLINE = Object.freeze({
  tree: ['keep'],          // leave the old Grow a Tree bot in place
  owo: ['keep'],           // leave the real OwO in place
  kofi: ['keep', 'drop'],  // leave Ko-fi Bot alone / drop Ko-fi entirely
  panels_ok: ['hold'],
  roles_ok: ['hold'],
});

/** A Ko-fi verification token is a UUID. Anything else in that box is a note, not a token. */
const KOFI_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A leading list marker — "- ", "* ", "• ", "1. ", "2) ".
 *
 * The trailing \s+ is doing real work. An earlier version of this stripped the character CLASS
 * [-*•\d.)] and destroyed the answer it was given: "18-20" is entirely digits and a hyphen, so it
 * was eaten down to nothing and vanished, and "21+" came out as "+". Two of the seven roles she
 * asked for were silently wrong. A marker is only a marker when something follows it.
 */
const LIST_MARKER = /^(?:[-*•]|\d{1,2}[.)])\s+/;

/**
 * Split a "one per line" answer into names.
 *
 * She was invited to write a list, so parsing one is not guesswork. Commas and newlines both, because
 * people do both and being pedantic about which would just lose her answer.
 *
 * Nothing here may quietly change what she typed. A name that survives stripping is used as-is; if
 * stripping would empty it, the original wins — because a role called "21+" is a perfectly good role
 * name and our tidying is worth less than her answer.
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
 * Returns a plain object even when she has answered nothing — an absent questionnaire means "she has
 * not told us", which every caller must handle anyway, and making them null-check first would just
 * mean they forget to.
 */
export async function loadDecisions(guildId) {
  const [rows] = await pool.execute(
    'SELECT item_key, value, note, updated_at FROM takeover_questionnaire WHERE guild_id = ?', [guildId]);
  const by = new Map(rows.map(r => [r.item_key, r]));

  const value = key => by.get(key)?.value ?? null;
  const note = key => {
    const n = by.get(key)?.note;
    return n && String(n).trim() ? String(n).trim() : null;
  };

  // Counted separately, because they are different things. Lumping the 45 catalogue rows in with the
  // 16 questions is how you end up reporting "61 of 16 answered".
  const answeredQuestions = QUESTIONS.filter(q => value(q.key) || note(q.key)).length;
  const answeredFeatures = CATALOGUE.filter(c => value(c.key)).length;

  const features = { yes: [], no: [], explain: [] };
  for (const c of CATALOGUE) {
    const v = value(c.key);
    if (v && features[v]) features[v].push(c);
  }

  // Only trust the token box when she actually picked "I'll get the token", and only when what she
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
    any: rows.length > 0,
    questions: { answered: answeredQuestions, total: QUESTIONS.length },
    catalogue: { answered: answeredFeatures, total: CATALOGUE.length },
    complete: answeredQuestions === QUESTIONS.length && answeredFeatures === CATALOGUE.length,
    updatedAt: updatedAt || null,

    value,
    note,

    /** 'yes' | 'no' | 'explain' | null */
    feature: key => (FEATURE_KEYS.has(key) ? value(key) : null),
    wants: key => value(key) === 'yes',
    declined: key => value(key) === 'no',

    features,
    /** Things she said yes to that she does not already have. */
    wanted: features.yes,
    /** Things she explicitly does NOT want. Do not switch these on because they seemed nice. */
    unwanted: features.no,
    /** "I don't know what this is" — these are questions back to us, not answers. */
    needsExplaining: features.explain,

    kofiToken,
    kofiTokenMalformed,
    spareRoleNames,

    /**
     * Did she tell us not to do this step?
     * @returns {{declined:boolean, key:string|null, value:string|null, note:string|null}}
     */
    forStep(stepKey) {
      const qKey = STEP_DECISION[stepKey];
      if (!qKey) return { declined: false, key: null, value: null, note: null };
      const v = value(qKey);
      return {
        declined: !!v && (DECLINE[qKey] ?? []).includes(v),
        key: qKey,
        value: v,
        note: note(qKey),
      };
    },

    raw: rows,
  };
}

/**
 * A short human summary of everything she asked for, for the top of the plan.
 *
 * This exists so the operator reads her intentions before the step list rather than after — the plan
 * is a list of things WE can do, and it is very easy to work down it having never noticed she said
 * no to two of them.
 */
export function summarizeDecisions(d) {
  if (!d.any) return null;
  const pick = key => {
    const q = QUESTIONS.find(x => x.key === key);
    const v = d.value(key);
    const opt = q?.options?.find(o => o.v === v);
    return { key, q: q?.q ?? key, answer: opt?.label ?? v ?? null, note: d.note(key) };
  };
  return {
    complete: d.complete,
    questions: d.questions,
    catalogue: d.catalogue,
    updatedAt: d.updatedAt,
    decisions: QUESTIONS.map(q => pick(q.key)).filter(x => x.answer || x.note),
    wanted: d.wanted.map(c => ({ key: c.key, name: c.name, group: c.group })),
    unwanted: d.unwanted.map(c => ({ key: c.key, name: c.name, group: c.group })),
    needsExplaining: d.needsExplaining.map(c => ({ key: c.key, name: c.name, what: c.what })),
    spareRoleNames: d.spareRoleNames,
    kofiToken: d.kofiToken ? 'supplied' : d.kofiTokenMalformed ? 'malformed' : 'missing',
  };
}

export default { loadDecisions, summarizeDecisions, parseRoleNames, STEP_DECISION };
