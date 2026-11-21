/*
 * Stream bot community features: what they add to the automation engine, through the registration hooks of actions.js,
 * events.js and render.js (no community code inside the engine files).
 *
 *   quotes.command   "Quotes: run a command"            !quote, !addquote, !delquote
 *   games.command    "Chat games: run a command"        !slots, !duel, !accept, !decline, !heist, !join, !leave, !lineup, !ticket, !raffle
 *   store.command    "Loyalty store: run a command"     !store, !redeem
 *   media.command    "Media share: run a command"       !media, !mediaqueue, !mediaapprove, !mediadeny, !mediaskip
 *   tts.say          "Speak text on stream"             text (template), voice, volume: read aloud on the CertiFried Media
 *                                                       Share page with CertiFried's Piper voices, after the profanity mask
 *   store.redeemed   trigger "Loyalty store: item redeemed" ({store.item}, {store.cost}, {user.name})
 *
 *   registerCommunity({ ref, actions, events, render })   once at start-up; ref.current = { quotes, games, shop, media }
 *
 * Every command answers in the chat the event came from (Twitch, Kick or YouTube). Tested in tests/stream-bot-community.test.js.
 */
import { replyInEventChat, commandInput } from '../music/register.js';
import { QUOTE_COMMANDS } from './quotes.js';
import { GAME_COMMANDS } from './games.js';
import { STORE_COMMANDS } from './shop.js';
import { MEDIA_COMMANDS } from './media.js';
import { LIMITS } from './settings.js';
import { isOwnVoice, ownVoiceStepError, hasTemplateVars } from '../../voice-clone/policy.js';

const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });
const labels = (list) => Object.freeze(Object.fromEntries(list.map((c) => [c.key, c.label])));
const REPLY = f('reply', 'select', 'Answer in chat', { options: ['yes', 'no'], default: 'yes', optionLabels: { yes: 'Yes', no: 'No' } });

/** One "run a command" action: the command, an optional input template, answer in chat. */
function commandAction(ref, { type, label, group, list, part, withInput = false, defaultCommand }) {
    const keys = list.map((c) => c.key);
    const fields = [f('command', 'select', 'Command', { options: keys, default: defaultCommand || keys[0], optionLabels: labels(list) })];
    if (withInput) fields.push(f('input', 'template', 'Text to use (empty: what follows the command in chat, or the reward message)', { optional: true }));
    fields.push(REPLY);
    return {
        type, label, target: 'server', group, fields, templates: withInput ? ['input'] : [],
        validate(s, out, err) {
            out.command = keys.includes(s.command) ? s.command : null;
            if (!out.command) err('pick a command.');
            if (withInput) out.input = String(s.input ?? '').slice(0, 500);
            out.reply = s.reply === 'no' ? 'no' : 'yes';
        },
        async execute(step, ctx) {
            const input = withInput && step.input ? String(await ctx.render(step.input)).trim() : commandInput(ctx.ev);
            if (ctx.dryRun) return { status: 'dry', detail: `would run the ${step.command} command${input ? ` with "${input.slice(0, 120)}"` : ''}` };
            const svc = ref.current?.[part];
            if (!svc) return { status: 'failed', detail: `${group.toLowerCase()} is not running yet (restart needed)` };
            const r = await svc.run(ctx.profile, step.command, { ev: ctx.ev, input, ctx });
            if (!r?.reply || step.reply === 'no') return { status: r?.reply ? 'ok' : 'skipped', detail: String(r?.reply || r?.detail || 'no answer').slice(0, 480) };
            const sent = await replyInEventChat(ctx.io, ctx.profile.id, ctx.ev, r.reply);
            return sent.ok ? { status: 'ok', detail: `${sent.where}: ${r.reply}`.slice(0, 480) } : { status: 'partial', detail: `${r.reply} (not sent: ${sent.error})`.slice(0, 480) };
        },
    };
}

/** The "Speak text on stream" step. Voice options are filled in at start-up from the voices this server has (speech.js). */
export function ttsAction(ref) {
    return {
        type: 'tts.say', label: 'Speak text on stream', target: 'server', group: 'Sound and speech',
        fields: [
            f('text', 'template', 'What to say, such as {user.name} says {message}'),
            f('voice', 'select', 'Voice', { options: [''], default: '', optionLabels: { '': 'The default voice (Community, Media and speech)' } }),
            f('volume', 'number', 'Volume (0 to 100; empty: the default)', { min: 0, max: 100, optional: true }),
            f('dropCommand', 'select', 'Leave out the chat command (such as !tts) when reading {message}', { options: ['yes', 'no'], default: 'yes', optionLabels: { yes: 'Yes', no: 'No' } }),
        ],
        templates: ['text'],
        validate(s, out, err) {
            out.text = String(s.text ?? '').slice(0, 2000).trim();
            if (!out.text) err('enter what to say, or a variable such as {message}.');
            out.voice = /^[a-z0-9_-]{1,50}$/i.test(String(s.voice || '')) ? String(s.voice) : '';
            const v = s.volume === '' || s.volume == null ? null : Math.round(Number(s.volume));
            if (v != null && !(v >= 0 && v <= 100)) err('the volume is a number from 0 to 100.');
            if (v != null && v >= 0 && v <= 100) out.volume = v;
            out.dropCommand = s.dropCommand === 'no' ? 'no' : 'yes';
            // "My own voice" (core/voice-clone): fixed text always; variables (other people's words) only with the owner's opt-in.
            const own = ownVoiceStepError(out);
            if (own) err(own);
        },
        async execute(step, ctx) {
            if (isOwnVoice(step.voice) && !hasTemplateVars(step.text)) {
                const bad = ownVoiceStepError(step);
                if (bad) return { status: 'failed', detail: bad };
                if (ctx.dryRun) return { status: 'dry', detail: `would read aloud in your own voice: ${String(step.text).slice(0, 200)}` };
                const media = ref.current?.media;
                if (!media) return { status: 'failed', detail: 'text to speech is not running yet (restart needed)' };
                // the step text as typed: never rendered, so no variable (and no viewer text) can reach the voice
                const r = await media.say(ctx.profile, { text: String(step.text).trim(), voice: step.voice, volume: step.volume ?? null, fixedText: true });
                return { status: r.status, detail: r.detail };
            }
            let text = String(await ctx.render(step.text)).trim();
            // "{user.name} says {message}" for "!tts hello" reads "… says hello": the command word is left out.
            const said = String(ctx.ev?.message || '').trim();
            if (step.dropCommand !== 'no' && ctx.ev?.type === 'chat' && /^![^\s]+/.test(said) && text.includes(said)) text = text.split(said).join(commandInput(ctx.ev)).trim();
            if (!text) return { status: 'skipped', detail: 'the text came out empty' };
            if (ctx.dryRun) return { status: 'dry', detail: `would read aloud: ${text.slice(0, 200)}` };
            const media = ref.current?.media;
            if (!media) return { status: 'failed', detail: 'text to speech is not running yet (restart needed)' };
            const r = await media.say(ctx.profile, { text, voice: step.voice || null, volume: step.volume ?? null });
            return { status: r.status, detail: r.detail };
        },
    };
}

export function communityActions(ref) {
    return [
        commandAction(ref, { type: 'quotes.command', label: 'Quotes: run a command', group: 'Quotes', list: QUOTE_COMMANDS, part: 'quotes' }),
        commandAction(ref, { type: 'games.command', label: 'Chat games: run a command', group: 'Chat games', list: GAME_COMMANDS, part: 'games' }),
        commandAction(ref, { type: 'store.command', label: 'Loyalty store: run a command', group: 'Loyalty store', list: STORE_COMMANDS, part: 'shop', withInput: true }),
        commandAction(ref, { type: 'media.command', label: 'Media share: run a command', group: 'Media share', list: MEDIA_COMMANDS, part: 'media', withInput: true }),
        ttsAction(ref),
    ];
}

export const STORE_REDEEMED = Object.freeze({
    type: 'store.redeemed', label: 'Loyalty store: item redeemed', group: 'Viewers', platforms: ['bot'], fields: ['user', 'item'],
    sample: Object.freeze({ user: { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] }, amount: 500, currency: 'points', message: 'Hydrate', metadata: { item: 'Hydrate', itemId: 1, cost: 500, redemptionId: 1, viewerPlatform: 'twitch' } }),
});
export const COMMUNITY_VARS = Object.freeze([
    { token: '{store.item}', description: 'Loyalty store: the item redeemed' },
    { token: '{store.cost}', description: 'Loyalty store: what it cost' },
]);

/** Call once at start-up with the engine modules. Returns what was registered (false when a hook is missing). */
export function registerCommunity({ ref, actions, events, render }) {
    const out = { actions: false, event: false, vars: false };
    const list = communityActions(ref);
    if (typeof actions?.registerActionType === 'function') out.actions = list.map((a) => actions.registerActionType(a)).every((x) => x !== false);
    if (typeof events?.registerEventType === 'function') out.event = events.registerEventType(STORE_REDEEMED) !== false;
    if (typeof render?.registerTemplateVars === 'function') {
        out.vars = render.registerTemplateVars({
            names: ['store.item', 'store.cost'], vars: COMMUNITY_VARS,
            values: ({ ev }) => (ev?.type === 'store.redeemed' ? { 'store.item': String(ev.metadata?.item ?? ''), 'store.cost': String(ev.metadata?.cost ?? '') } : { 'store.item': '', 'store.cost': '' }),
        }) !== false;
    }
    out.tts = list.find((a) => a.type === 'tts.say');
    return out;
}

/** Fill the voice picker of "Speak text on stream" (called once the voice list is read). */
export function setVoiceOptions(def, voices) {
    if (!def?.fields) return;
    const field = def.fields.find((x) => x.name === 'voice');
    if (!field) return;
    field.options = ['', ...voices.map((v) => v.value)];
    field.optionLabels = { '': 'The default voice (Community, Media and speech)', ...Object.fromEntries(voices.map((v) => [v.value, v.label])) };
}

export { LIMITS };
export default { registerCommunity, communityActions, ttsAction, setVoiceOptions, STORE_REDEEMED, COMMUNITY_VARS };
