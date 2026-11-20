/*
 * Stream bot music: what it adds to the automation engine, through the registration hooks of actions.js,
 * events.js and render.js (no music code inside the engine files).
 *
 *   MUSIC_ACTION    'music.command'  "Song requests: run a command" (server action): runs one command from text.js
 *                                    COMMANDS and answers in the chat the event came from
 *   SONG_CHANGED    'music.song_changed' trigger (platform 'studio'), with title, artist, url, requestedBy, requested
 *   MUSIC_VARS      {music.track} {music.artist} {music.url} {music.requester} for any template (the song playing now);
 *                   {spotify.track} {spotify.artist} {spotify.url} are accepted as the same values
 *   registerMusic({ musicRef, actions, events, render })   call once at start-up; musicRef.current = the music service
 *   replyInEventChat(io, profileId, ev, text)               the chat a reply goes to
 *
 * Tested in tests/stream-bot-music.test.js.
 */
import { COMMANDS, COMMAND_KEYS, commandDef } from './text.js';

const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });
export const COMMAND_LABELS = Object.freeze(Object.fromEntries(COMMANDS.map((c) => [c.key, `${c.label} (!${c.names[0]})`])));

/** After the command word in chat; the message itself for anything else (a reward's text, a tip message). */
export function commandInput(ev) {
    const m = String(ev?.message || '').trim();
    return ev?.type === 'chat' ? m.split(/\s+/).slice(1).join(' ') : m;
}

/** Reply where the event came from: the same Twitch / Kick / YouTube channel, else the first linked channel on that platform. */
export async function replyInEventChat(io, profileId, ev, text) {
    const channels = await io.channelsFor(profileId);
    const p = ['twitch', 'kick', 'youtube'].includes(ev?.platform) ? ev.platform : (channels.find((c) => c.platform === 'twitch') ? 'twitch' : 'kick');
    const own = ev?.channelId ? channels.filter((c) => c.platform === p && String(c.platform_user_id) === String(ev.channelId)) : [];
    const target = own[0] || channels.find((c) => c.platform === p);
    if (!target) return { ok: false, error: 'no linked channel to answer in' };
    const r = await io.sendChat({ profileId, platform: target.platform, channelId: target.platform_user_id, login: target.login, text });
    return r.ok ? { ok: true, where: `${target.platform}/${target.login}` } : { ok: false, error: r.error || 'chat failed' };
}

export function musicAction(musicRef) {
    return {
        type: 'music.command', label: 'Song requests: run a command', target: 'server', group: 'Music',
        fields: [
            f('command', 'select', 'Command', { options: [...COMMAND_KEYS], default: 'request', optionLabels: COMMAND_LABELS }),
            f('input', 'template', 'Text to use (empty: what follows the command in chat, or the reward message)', { optional: true }),
            f('reply', 'select', 'Answer in chat', { options: ['yes', 'no'], default: 'yes', optionLabels: { yes: 'Yes', no: 'No' } }),
        ],
        templates: ['input'],
        validate(s, out, err) {
            out.command = COMMAND_KEYS.includes(s.command) ? s.command : null;
            if (!out.command) err('pick a command.');
            out.input = String(s.input ?? '').slice(0, 500);
            out.reply = s.reply === 'no' ? 'no' : 'yes';
        },
        async execute(step, ctx) {
            const def = commandDef(step.command);
            if (!def) return { status: 'failed', detail: `unknown command ${step.command}` };
            const input = step.input ? (await ctx.render(step.input)).trim() : commandInput(ctx.ev);
            if (ctx.dryRun) return { status: 'dry', detail: `would run !${def.names[0]}${input ? ` with "${input.slice(0, 120)}"` : ''}` };
            const music = musicRef.current;
            if (!music) return { status: 'failed', detail: 'song requests are not running yet (restart needed)' };
            const r = await music.commands.run(ctx.profile, step.command, { ev: ctx.ev, input });
            if (!r.reply || step.reply === 'no') return { status: 'ok', detail: `!${def.names[0]}: ${r.reply || r.detail}`.slice(0, 480) };
            const sent = await replyInEventChat(ctx.io, ctx.profile.id, ctx.ev, r.reply);
            return sent.ok ? { status: 'ok', detail: `${sent.where}: ${r.reply}`.slice(0, 480) } : { status: 'partial', detail: `${r.reply} (not sent: ${sent.error})`.slice(0, 480) };
        },
    };
}

export const SONG_CHANGED = Object.freeze({
    type: 'music.song_changed', label: 'Song changed (song requests)', group: 'Music', platforms: ['studio'], fields: ['title'],
    sample: Object.freeze({ message: 'Golden Hour — Maple Hollow Band', metadata: { title: 'Golden Hour', artist: 'Maple Hollow Band', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', requestedBy: 'MapleFan_88', requested: true, playlist: null, source: 'youtube' } }),
});

export const MUSIC_VARS = Object.freeze([
    { token: '{music.track}', description: 'The song playing now (song requests)' },
    { token: '{music.artist}', description: 'Its artist' },
    { token: '{music.url}', description: 'A link to it' },
    { token: '{music.requester}', description: 'Who requested it (empty for playlist songs)' },
]);
const VAR_NAMES = ['music.track', 'music.artist', 'music.url', 'music.requester', 'spotify.track', 'spotify.artist', 'spotify.url'];

/** Call once at start-up with the engine modules. Returns what was registered (false when a hook is missing). */
export function registerMusic({ musicRef, actions, events, render }) {
    const out = { action: false, event: false, vars: false };
    if (typeof actions?.registerActionType === 'function') out.action = actions.registerActionType(musicAction(musicRef)) !== false;
    if (typeof events?.registerEventType === 'function') out.event = events.registerEventType(SONG_CHANGED) !== false;
    if (typeof render?.registerTemplateVars === 'function') {
        out.vars = render.registerTemplateVars({ names: VAR_NAMES, vars: MUSIC_VARS, values: ({ profileId }) => musicRef.current?.templateValues(profileId) || {} }) !== false;
    }
    return out;
}

export default { musicAction, SONG_CHANGED, MUSIC_VARS, registerMusic, commandInput, replyInEventChat, COMMAND_LABELS };
