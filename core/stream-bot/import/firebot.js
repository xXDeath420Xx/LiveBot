/*
 * Stream bot import: Firebot v5 → a source-neutral bundle (see mapper.js for the bundle shape).
 *
 * Reads either a setup file (Firebot: Settings → Setups → Create, a `.firebotsetup` JSON file) or the files of a
 * profile folder (%APPDATA%\Firebot\v5\profiles\<name>\, zipped): chat/commands.json, events/events.json,
 * timers.json, counters/counters.json (+ <name>.txt values), channel-rewards.json, power-ups.json, hotkeys.json,
 * chat/moderation/*.json, integrations.json (service names and the OBS address only), db/users.db (viewer stats,
 * only when asked for), databases/quotes.db (SQLite; read by the caller and passed in as rows).
 *
 * Never read: auth-twitch.json and anything else holding tokens; settings.json (nothing to import; it holds device
 * ids). Every object goes through stripSecrets() before it is looked at.
 *
 *   parseFirebot({ files?: Map<path, Buffer>, setup?: object, quotes?: [row], wantViewers?: boolean }) → bundle
 *
 * Tested in tests/stream-bot-import.test.js with small invented fixtures.
 */
import { stripSecrets } from './secrets.js';
import { translateFirebot, slugKey } from './variables.js';
import { firebotHue, firebotHueScene, firebotElgato } from './lights.js';

const ROLE = Object.freeze({ broadcaster: 'broadcaster', streamer: 'broadcaster', mod: 'moderator', moderator: 'moderator', vip: 'vip', sub: 'subscriber', subscriber: 'subscriber' });

/** Firebot event (source:event) → stream bot trigger type. */
export const FIREBOT_EVENTS = Object.freeze({
    'twitch:follow': 'follow', 'twitch:sub': 'sub', 'twitch:prime-sub-upgraded': 'sub', 'twitch:gift-sub-upgraded': 'sub',
    'twitch:subs-gifted': 'gift_sub', 'twitch:community-subs-gifted': 'gift_sub', 'twitch:cheer': 'cheer', 'twitch:bits-badge-unlocked': null,
    'twitch:raid': 'raid', 'twitch:channel-reward-redemption': 'redemption', 'twitch:stream-online': 'stream.online',
    'twitch:stream-offline': 'stream.offline', 'twitch:chat-message': 'chat', 'twitch:hype-train-start': 'hype_train.begin',
    'twitch:hype-train-level-up': 'hype_train.progress', 'twitch:hype-train-end': 'hype_train.end', 'twitch:channel-poll-begin': 'poll.begin',
    'twitch:channel-poll-progress': 'poll.progress', 'twitch:channel-poll-end': 'poll.end', 'twitch:channel-prediction-begin': 'prediction.begin',
    'twitch:channel-prediction-progress': 'prediction.progress', 'twitch:channel-prediction-lock': 'prediction.lock',
    'twitch:channel-prediction-end': 'prediction.end', 'twitch:ad-break-start': 'ad_break', 'streamelements:donation': 'tip',
    'streamlabs:donation': 'tip', 'streamloots:purchase': null, 'obs:scene-changed': 'obs.scene_changed', 'obs:stream-started': 'obs.stream_started',
    'obs:stream-stopped': 'obs.stream_stopped', 'obs:recording-started': 'obs.recording_started', 'obs:recording-stopped': 'obs.recording_stopped',
    'obs:replay-buffer-saved': 'obs.replay_saved', 'obs:vertical-backtrack-saved': null,
    // Phase 4 triggers (design doc §7.5)
    'firebot:firebot-started': 'studio.connected', 'twitch:power-up-redemption': 'bits.used', 'twitch:bits-powerup-message-effect': 'bits.used',
    'twitch:bits-powerup-celebration': 'bits.used', 'twitch:bits-powerup-gigantified-emote': 'bits.used',
});
const EVENT_GAP = Object.freeze({
    'twitch:viewer-arrived': 'trigger.viewer_arrived', 'twitch:first-time-chat': 'trigger.first_words',
    'twitch:whisper': 'chat.whisper',
});
const TIP_PLATFORM = { 'streamelements:donation': 'streamelements', 'streamlabs:donation': 'streamlabs' };

const asText = (buf) => (Buffer.isBuffer(buf) ? buf.toString('utf8').replace(/^﻿/, '') : String(buf ?? ''));
function json(files, path) {
    const b = files?.get(path);
    if (!b) return null;
    try { return JSON.parse(asText(b)); } catch { return undefined; }
}
const list = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, max = 500) => String(v ?? '').slice(0, max);
const base = (p) => String(p || '').split(/[\\/]/).pop();

/** Find the profile root inside a zip (the folder that holds chat/commands.json or events/events.json). */
export function profileRoot(files) {
    for (const p of files.keys()) {
        const m = p.match(/^(.*?)(chat\/commands\.json|events\/events\.json|counters\/counters\.json|timers\.json|channel-rewards\.json)$/i);
        if (m) return m[1];
    }
    return null;
}

/** Re-key a file map so paths are relative to the profile root. */
function rooted(files) {
    const root = profileRoot(files);
    if (root == null) return files;
    const out = new Map();
    for (const [p, b] of files) if (p.startsWith(root)) out.set(p.slice(root.length), b);
    return out;
}

// ── effects ─────────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Firebot effect list. Returns { actions, gaps: [{ gap, detail }], notes, vars, media }.
 * ctx: { counters: Map<id, key>, counterKey(name), commandsByTrigger }
 */
export function convertEffects(effects, ctx, depth = 0) {
    const out = { actions: [], gaps: [], notes: [], vars: [], media: [] };
    const tr = (t) => {
        const r = translateFirebot(t, ctx);
        out.vars.push(...r.unsupported);
        out.notes.push(...r.changes);
        return r.text;
    };
    const gap = (key, type) => out.gaps.push({ gap: key, detail: `Firebot effect ${type}` });
    for (const e of list(effects)) {
        if (!e || typeof e !== 'object') continue;
        const type = String(e.type || '');
        if (e.active === false) { out.notes.push(`A turned-off ${type.replace(/^firebot:/, '')} effect was left out`); continue; }
        switch (type) {
            case 'firebot:chat': {
                const msg = str(e.message, 2000);
                if (e.whisper) { gap('chat.whisper', type); break; }
                if (/^\s*\/clear\b/i.test(msg)) { out.actions.push({ type: 'chat.clear' }); out.notes.push('"/clear" in chat became the Clear chat step'); break; }
                if (/^\s*\/(ban|timeout|unban|untimeout|mod|vip|unvip|slow|followers|subscribers|emoteonly|uniquechat|shoutout|raid|commercial|marker|announce\w*)\b/i.test(msg)) { gap('chat.slash', type); break; }
                const text = tr(msg.replace(/^\s*\/me\s+/i, ''));
                if (!text.trim()) break;
                // Firebot sends as the Streamer unless "Bot" is picked. A line another bot acts on (!pokecatch, !roll …), and a
                // line of only emotes (the streamer's sub emotes, which CertiFried's bot cannot use), must come from the streamer's
                // account: "Send a chat message as you" (stream.say, 2026-11-20). Other replies stay with CertiFried's bot.
                if (String(e.chatter || 'Streamer') !== 'Bot' && (/^\s*!/.test(text) || emoteOnly(text))) {
                    out.actions.push({ type: 'stream.say', text, ...(/^!\S+$/.test(text.trim()) ? { _commandText: text.trim() } : {}) });
                    out.notes.push('Firebot sent this as you (the Streamer account), so it is sent as you: "Send a chat message as you" (re-approve Twitch on Connections once)');
                    break;
                }
                out.actions.push({ type: 'chat.send', platform: 'event', text });
                break;
            }
            case 'firebot:announcement': {
                const text = tr(str(e.message, 2000));
                if (!text.trim()) break;
                out.actions.push({ type: 'stream.announce', text, color: announceColor(e.color) });
                break;
            }
            case 'firebot:update-counter': {
                const key = ctx.counters?.get(String(e.counterId)) || null;
                if (!key) { out.notes.push('A counter step pointed at a counter that is not in the file, so it was left out'); break; }
                const mode = String(e.mode || 'increment');
                const v = String(e.value ?? '').trim();
                if (mode === 'set') {
                    out.actions.push({ type: 'variable.set', scope: 'channel', key, value: tr(v) });
                } else if (/^[+-]?\d{1,4}$/.test(v) && Math.abs(Number(v)) <= 1000) {
                    out.actions.push({ type: 'variable.increment', scope: 'channel', key, by: Number(v) });
                } else {
                    out.notes.push(`A counter change by "${v.slice(0, 40)}" is not a whole number from -1000 to 1000, so it became +1`);
                    out.actions.push({ type: 'variable.increment', scope: 'channel', key, by: 1 });
                }
                break;
            }
            case 'firebot:delay': {
                const s = num(e.delay, 1);
                out.actions.push({ type: 'delay', seconds: Math.min(600, Math.max(0.1, s)) });
                if (s > 600) out.notes.push(`A ${s}-second wait was shortened to 600 seconds`);
                break;
            }
            case 'firebot:randomeffect': {
                if (depth >= 3) { gap('flow.conditional', type); break; }
                const inner = list(e.effectList?.list ?? e.effectList);
                const branches = [];
                for (const x of inner) {
                    const sub = convertEffects([x], ctx, depth + 1);
                    merge(out, sub);
                    if (sub.actions.length) branches.push({ weight: num(x.percentWeight, 0) > 0 ? num(x.percentWeight) * 100 : 1, actions: sub.actions });
                }
                if (e.dontRepeatUntilAllUsed) out.notes.push('"Do not repeat until all are used" is not kept: each run picks at random');
                if (branches.length >= 2) out.actions.push({ type: 'random', branches });
                else if (branches.length === 1) out.actions.push(...branches[0].actions);
                break;
            }
            case 'firebot:sequentialeffect': gap('flow.sequential', type); break;
            case 'firebot:conditional-effects': gap('flow.conditional', type); break;
            case 'firebot:run-effect-list': gap('flow.conditional', type); break;
            case 'firebot:playsound': {
                const file = str(e.filepath || e.file || '', 500);
                const url = str(e.url || '', 500);
                if (e.soundType === 'folderRandom' || e.folder) { gap('sound.folder', type); break; }
                let sound = '';
                if (/^https:\/\//i.test(url)) sound = url;
                else if (file) { sound = base(file).replace(/\.[a-z0-9]{2,4}$/i, '').slice(0, 80); out.media.push({ path: file, kind: 'sound' }); }
                if (!sound) { out.notes.push('A sound step had no file, so it was left out'); break; }
                const vol = num(e.volume, 8);
                out.actions.push({ type: 'sound.play', sound, volume: Math.min(100, Math.max(0, Math.round(vol <= 10 ? vol * 10 : vol))), mode: 'overlap' });
                break;
            }
            // Phase 3 overlays (design doc §9.9): text and media on the default overlay, queued for 120 s like other client steps.
            case 'firebot:showtext': {
                const text = tr(htmlToText(e.text));
                if (!text.trim()) { gap('overlay.text', `${type} (no text)`); break; }
                const px = Math.max(0, ...[...String(e.text || '').matchAll(/font-size:\s*(\d{1,3})px/gi)].map((m) => Number(m[1])));
                out.actions.push({ type: 'overlay.text', overlay: '', text, position: overlayPosition(e.position), size: px && px <= 40 ? 'small' : px >= 72 ? 'large' : 'medium',
                    durationMs: overlayDuration(e, ctx.timer ? 60 : 5), animation: overlayAnimation(e.enterAnimation), queueSeconds: 120 });
                if (String(e.position) === 'Custom' || String(e.position) === 'Random') out.notes.push('Its custom position became the centre of the overlay; move it in the step if needed');
                break;
            }
            case 'firebot:showImage': case 'firebot:playvideo': case 'firebot:play-video': {
                const file = str(e.file || e.filepath || '', 500);
                const isVideo = type !== 'firebot:showImage';
                if (/^https?:\/\//i.test(file) || e.imageType === 'url' || e.videoType === 'YouTube Video' || !file) {
                    gap(isVideo ? 'overlay.video' : 'overlay.image', `${type} (not a local file)`);
                    break;
                }
                out.media.push({ path: file, kind: isVideo ? 'video' : 'image' });
                const media = cleanMediaName(base(file));
                const w = num(e.width, 0);
                out.actions.push({ type: 'overlay.media', overlay: '', media, position: overlayPosition(e.position), size: w && w <= 300 ? 'small' : w >= 900 ? 'large' : 'medium',
                    durationMs: overlayDuration(e, 6), volume: isVideo ? Math.min(100, Math.max(0, Math.round(num(e.volume, 8) <= 10 ? num(e.volume, 8) * 10 : num(e.volume, 80)))) : 80,
                    animation: overlayAnimation(e.enterAnimation), queueSeconds: 120 });
                out.notes.push(`Upload the ${isVideo ? 'video' : 'image'} as "${media}" under Overlays → Images and videos (from ${file})`);
                if (String(e.position) === 'Custom' || String(e.position) === 'Random') out.notes.push('Its custom position became the centre of the overlay; move it in the step if needed');
                break;
            }
            case 'firebot:html': gap('overlay.html', type); break;
            // Phase 5 lights (core/stream-bot/import/lights.js): Firebot's Philips Hue and Elgato integrations.
            case 'hue:control-light': case 'hue:scenes': case 'elgato:key-lights': case 'elgato:light-strips': {
                const r = type === 'hue:control-light' ? firebotHue(e) : type === 'hue:scenes' ? firebotHueScene(e) : firebotElgato(e, type === 'elgato:light-strips' ? 'strip' : 'key');
                out.actions.push(...r.actions);
                out.notes.push(...r.notes);
                for (const g of r.gaps) gap(g.gap, `${type} (${g.what})`);
                if (!r.actions.length && !r.gaps.length) out.notes.push(`A ${type} effect changed nothing, so it was left out`);
                break;
            }
            // Phase 4 stream actions (design doc §7.3)
            case 'firebot:clip':
                out.actions.push({ type: 'stream.clip' });
                if (e.postLink === true || e.postLink === 'true') out.actions.push({ type: 'chat.send', platform: 'event', text: '{clip.url}' });
                break;
            case 'firebot:streamtitle': {
                const title = tr(str(e.title, 300));
                if (title.trim()) out.actions.push({ type: 'stream.title', platform: 'twitch', title });
                else gap('unknown.effect', type);
                break;
            }
            case 'firebot:streamgame': {
                const category = tr(str(e.gameName || e.game || '', 200));
                if (e.mode !== 'reset' && category.trim()) out.actions.push({ type: 'stream.category', platform: 'twitch', category });
                else gap('unknown.effect', `${type} (reset)`);
                break;
            }
            case 'firebot:shoutout': {
                const target = tr(str(e.username || e.target || '', 200));
                if (target.trim()) out.actions.push({ type: 'stream.shoutout', platform: 'twitch', target });
                else gap('unknown.effect', type);
                break;
            }
            case 'firebot:raid': case 'firebot:start-raid': {
                const target = tr(str(e.username || e.channel || e.target || '', 200));
                if (target.trim()) out.actions.push({ type: 'stream.raid', target });
                else gap('unknown.effect', type);
                break;
            }
            case 'firebot:ad-break': case 'firebot:run-ad': {
                const n = num(e.adLength ?? e.length, 30);
                out.actions.push({ type: 'stream.ad', length: [30, 60, 90, 120, 150, 180].reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), 30) });
                break;
            }
            case 'firebot:delete-chat-message': out.actions.push({ type: 'chat.delete' }); break;
            case 'firebot:clear-chat': out.actions.push({ type: 'chat.clear' }); break;
            case 'firebot:modban': case 'firebot:modTimeout': case 'firebot:modpurge': gap('mod.timeout', type); break;
            case 'firebot:tts': case 'firebot:ttsv2': gap('tts.speak', type); break;
            case 'firebot:currency': {
                // Viewers and points (H-747, design §11): a change for one viewer becomes Give / Take / Set points.
                const act = String(e.action || '').toLowerCase();
                const target = String(e.target || 'individual').toLowerCase();
                const kind = act === 'add' ? 'points.add' : act === 'remove' ? 'points.remove' : act === 'set' ? 'points.set' : null;
                if (!kind || target !== 'individual') { gap(kind ? 'currency.bulk' : 'currency.change', type); break; }
                const who = String(e.userTarget ?? '').trim();
                const amount = tr(str(e.amount ?? '', 200)).trim();
                if (!amount) { gap('currency.change', type); break; }
                const self = !who || /^\$(user|username)$/i.test(who);
                out.actions.push({ type: kind, who: self ? 'event' : 'named', viewer: self ? '' : tr(who), amount });
                out.notes.push('A currency change became a points step (Viewers): CertiFried has one points currency per channel');
                break;
            }
            case 'firebot:discord': gap('discord.webhook', type); break;
            case 'firebot:http-request': {
                const method = String(e.method || 'GET').toUpperCase();
                const url = str(e.url, 500);
                if (method === 'POST' && /^https:\/\//i.test(url) && !/[$]/.test(url)) {
                    out.actions.push({ type: 'webhook.post', url, body: tr(str(e.body ?? '', 2000)) });
                    out.notes.push('The HTTP request became a webhook: add its host to your webhook allow-list before turning it on; headers were not imported');
                } else gap('web.request', type);
                break;
            }
            case 'firebot:custom-variable': {
                const key = slugKey(e.name);
                if (!key) break;
                const v = typeof e.variableData === 'string' ? e.variableData : JSON.stringify(e.variableData ?? '');
                out.actions.push({ type: 'variable.set', scope: 'channel', key, value: tr(str(v, 1000)) });
                if (num(e.ttl, 0) > 0) out.notes.push('A custom variable lifetime was not kept: stored values do not expire');
                break;
            }
            case 'firebot:run-command': {
                const id = str(e.commandId || e.systemCommandId || '', 100);
                if (id) out.actions.push({ type: 'automation.run', _link: { source: 'firebot', kind: 'command', sourceId: id } });
                else gap('flow.conditional', type);
                break;
            }
            case 'firebot:send-keystroke': case 'firebot:sendkeys': {
                const k = str(e.key, 20);
                const mods = Object.entries(e.modifiers || {}).filter(([, on]) => on).map(([m]) => m[0].toUpperCase() + m.slice(1).toLowerCase());
                const keys = [...mods, k].filter(Boolean).join('+');
                if (/^[A-Za-z0-9+ _-]{1,60}$/.test(keys)) out.actions.push({ type: 'studio.hotkey', keys });
                else gap('unknown.effect', type);
                break;
            }
            // ── OBS ──
            case 'firebot:obs-change-scene': case 'firebot:change-scene': {
                const scene = str(e.sceneName || e.scene || e.custom || '', 200);
                if (scene) out.actions.push({ type: 'obs.scene', scene });
                break;
            }
            case 'firebot:obs-toggle-source': {
                for (const s of list(e.selectedSources)) {
                    const source = str(s.sourceName || s.groupName || s.name || '', 200);
                    if (!source) { out.notes.push('An OBS source step named its source by number only, so it was left out'); continue; }
                    out.actions.push({ type: 'obs.source', scene: str(s.sceneName || '', 200), source, visible: s.action === true ? 'show' : s.action === false ? 'hide' : 'toggle' });
                }
                break;
            }
            case 'firebot:obs-toggle-source-filter': {
                for (const s of list(e.selectedFilters)) {
                    if (!s.sourceName || !s.filterName) continue;
                    out.actions.push({ type: 'obs.filter', source: str(s.sourceName, 200), filter: str(s.filterName, 200), state: s.action === true ? 'enable' : s.action === false ? 'disable' : 'toggle' });
                }
                break;
            }
            case 'firebot:obs-toggle-source-muted': {
                for (const s of list(e.selectedSources)) {
                    if (!s.sourceName) continue;
                    out.actions.push({ type: 'obs.mute', input: str(s.sourceName, 200), state: s.action === true ? 'mute' : s.action === false ? 'unmute' : 'toggle' });
                }
                break;
            }
            case 'firebot:obs-set-source-text': {
                const source = str(e.textSourceName || e.sourceName || '', 200);
                if (source) out.actions.push({ type: 'obs.text', source, text: tr(str(e.text, 2000)) });
                break;
            }
            case 'firebot:obs-set-browser-source-url': {
                const source = str(e.browserSourceName || e.sourceName || '', 200);
                const url = tr(str(e.url, 2000));
                if (source && url) out.actions.push({ type: 'obs.browser_url', source, url });
                break;
            }
            case 'firebot:obs-start-stream': out.actions.push({ type: 'obs.stream', state: 'start' }); break;
            case 'firebot:obs-stop-stream': out.actions.push({ type: 'obs.stream', state: 'stop' }); break;
            case 'firebot:obs-start-recording': out.actions.push({ type: 'obs.record', state: 'start' }); break;
            case 'firebot:obs-stop-recording': out.actions.push({ type: 'obs.record', state: 'stop' }); break;
            case 'firebot:obs-save-replay-buffer': out.actions.push({ type: 'obs.replay', state: 'save' }); break;
            case 'firebot:obs-start-virtual-cam': out.actions.push({ type: 'obs.virtualcam', state: 'start' }); break;
            case 'firebot:obs-stop-virtual-cam': out.actions.push({ type: 'obs.virtualcam', state: 'stop' }); break;
            case 'firebot:obs-transform-source': gap('obs.transform', type); break;
            case 'firebot:obs-control-media': gap('obs.media', type); break;
            case 'firebot:run-custom-script': case 'firebot:run-program': case 'firebot:run-javascript': gap('code', type); break;
            default: gap('unknown.effect', type || 'without a type');
        }
    }
    return out;
}

function merge(into, from) {
    into.gaps.push(...from.gaps);
    into.notes.push(...from.notes);
    into.vars.push(...from.vars);
    into.media.push(...from.media);
}

const effectList = (x) => list(x?.list ?? x);

/** Firebot overlay position → overlay position (design doc §9.9); Random and custom coordinates → centre. */
/** A chat line made only of emote codes (death01Love, PansexualPride): every word has a lower-case letter followed by a capital. */
export const emoteOnly = (t) => { const w = String(t ?? '').trim().split(/\s+/).filter(Boolean); return w.length > 0 && w.length <= 20 && w.every((x) => /^[A-Za-z0-9_]+$/.test(x) && /[a-z0-9][A-Z]/.test(x)); };

const POSITION = Object.freeze({ 'top left': 'top-left', 'top middle': 'top', 'top right': 'top-right', 'middle left': 'left', middle: 'center',
    'middle right': 'right', 'bottom left': 'bottom-left', 'bottom middle': 'bottom', 'bottom right': 'bottom-right' });
export const overlayPosition = (p) => POSITION[String(p ?? '').trim().toLowerCase()] || 'center';

/** Firebot enter animation → overlay animation: fade… fade, slide… or bounce… slide, zoom… pop, none none, other rise. */
export function overlayAnimation(a) {
    const k = String(a ?? '').toLowerCase();
    if (k === 'none') return 'none';
    if (k.startsWith('fade')) return 'fade';
    if (k.startsWith('slide') || k.startsWith('bounce')) return 'slide';
    if (k.startsWith('zoom')) return 'pop';
    return 'rise';
}

/** Firebot duration (seconds: length / duration / durationSeconds) → ms, 1000 to 60000. */
export function overlayDuration(e, fallbackSeconds) {
    const raw = e?.length ?? e?.duration ?? e?.durationSeconds;
    const sec = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallbackSeconds;
    return Math.min(60000, Math.max(1000, Math.round(sec * 1000)));
}

/** Firebot's show-text HTML → plain text (line breaks kept, entities decoded); variables are translated afterwards. */
export function htmlToText(html) {
    return String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
        .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 2000);
}

/** The media library's name rule (core/stream-bot/overlays/media.js cleanMediaName), without its file-system imports. */
export const cleanMediaName = (v) => String(v ?? '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** Firebot announcement colour (Primary, Blue, Green, Orange, Purple) → stream.announce colour. */
export function announceColor(c) {
    const k = String(c ?? '').toLowerCase();
    return ['primary', 'blue', 'green', 'orange', 'purple'].includes(k) ? k : 'primary';
}

/** Roles from a command's restriction data → { roles, notes, gaps }. */
function restrictionRoles(data) {
    const roles = new Set();
    const notes = [];
    const gaps = [];
    for (const r of list(data?.restrictions)) {
        if (r.type === 'firebot:permissions' && r.mode === 'roles') {
            for (const id of list(r.roleIds)) {
                const role = ROLE[String(id).toLowerCase()];
                if (role) roles.add(role);
                else notes.push(`The custom role "${str(id, 40)}" was left out of the permissions`);
            }
        } else if (r.type) {
            notes.push(`The ${String(r.type).replace(/^firebot:/, '')} restriction was not kept`);
            if (/currency/.test(r.type)) gaps.push({ gap: 'currency.cost', detail: `Firebot restriction ${r.type}` });
        }
    }
    return { roles: [...roles], notes, gaps };
}

// ── the parser ──────────────────────────────────────────────────────────────────────────────

export function parseFirebot({ files = null, setup = null, quotes = null, wantViewers = false } = {}) {
    const stripped = { fields: 0, values: 0 };
    const clean = (v) => {
        const r = stripSecrets(v);
        stripped.fields += r.stripped.fields;
        stripped.values += r.stripped.values;
        return r.value;
    };
    const fm = files ? rooted(files) : new Map();
    const comp = setup ? clean(setup.components || {}) : null;
    const pick = (setupKey, path) => (comp ? comp[setupKey] : clean(json(fm, path)));

    const bundle = {
        source: 'firebot', format: setup ? 'setup' : 'profile', version: setup ? str(setup.version || setup.firebotVersion || '', 40) || null : null,
        name: setup ? str(setup.name, 100) : null,
        commands: [], automations: [], timers: [], counters: [], quotes: [], rewards: [], moderation: null, hotkeys: [],
        integrations: [], obs: null, viewers: null, media: [], dropped: [], files: [], stripped,
    };

    // counters first: commands and effects refer to them by id
    const counterKeys = new Map();
    const usedKeys = new Set();
    for (const c of list(pick('counters', 'counters/counters.json'))) {
        if (!c?.id || !c.name) continue;
        let key = slugKey(c.name) || `counter_${counterKeys.size + 1}`;
        while (usedKeys.has(key)) key = `${key}_2`.slice(0, 64);
        usedKeys.add(key);
        counterKeys.set(String(c.id), key);
        // counters.json holds the value; the <name>.txt file next to it is only a copy for OBS text sources.
        const value = Math.trunc(num(c.value, 0));
        const gaps = [];
        // Effects when the counter reaches its maximum or minimum have no trigger; update effects do (below).
        if (effectList(c.maximumEffects).length || effectList(c.minimumEffects).length) gaps.push({ gap: 'counter.effects', detail: 'Firebot counter maximum/minimum effects' });
        bundle.counters.push({ sourceId: String(c.id), name: str(c.name, 100), key, value, min: c.minimum ?? null, max: c.maximum ?? null, gaps, updateEffects: effectList(c.updateEffects) });
    }
    const ctx = { counters: counterKeys, counterKey: (name) => {
        for (const c of bundle.counters) if (c.name.toLowerCase() === String(name).trim().toLowerCase()) return c.key;
        return null;
    } };

    // counter update effects → automations on "Counter or variable changed" (variable.changed, design doc §7.5)
    for (const c of bundle.counters) {
        const effs = c.updateEffects || [];
        delete c.updateEffects;
        if (!effs.length) continue;
        const conv = convertEffects(effs, ctx);
        bundle.automations.push({
            sourceId: `counter:${c.sourceId}`, kind: 'counter_effect', name: `Counter ${c.name} changed`, enabled: true,
            trigger: { type: 'variable.changed', config: { key: c.key, scope: 'channel' }, conditions: [] },
            actions: conv.actions, gaps: conv.gaps, notes: [...conv.notes, `Runs whenever {sdb:${c.key}} changes, as Firebot ran it when the counter was updated`], vars: [...new Set(conv.vars)],
        });
    }

    // commands
    const cmdSrc = comp ? list(comp.commands) : list(pick(null, 'chat/commands.json')?.customCommands);
    for (const c of cmdSrc) {
        if (!c || typeof c !== 'object' || !c.trigger) continue;
        const conv = convertEffects(effectList(c.effects), ctx);
        const r = restrictionRoles(c.restrictionData);
        const gaps = [...conv.gaps, ...r.gaps];
        if (list(c.subCommands).length) gaps.push({ gap: 'command.subcommands', detail: `${list(c.subCommands).length} sub-commands` });
        if (c.triggerIsRegex || c.scanWholeMessage) gaps.push({ gap: 'command.regex_trigger', detail: 'Firebot command triggered by a pattern' });
        if (!r.roles.length && conv.actions.some((x) => x.type === 'chat.clear')) conv.notes.push('Anyone in chat could run this in Firebot, and here it really clears your Twitch chat: check it before turning it on (add a role condition)');
        bundle.commands.push({
            sourceId: String(c.id || c.trigger), name: str(c.trigger, 100), triggers: [str(c.trigger, 100), ...list(c.aliases).map((a) => str(a, 100))].filter(Boolean),
            regex: !!c.triggerIsRegex, anywhere: !!c.scanWholeMessage, enabled: c.active !== false,
            cooldown: { global: num(c.cooldown?.global, 0), user: num(c.cooldown?.user, 0) }, roles: r.roles,
            actions: conv.actions, gaps, notes: [...conv.notes, ...r.notes], vars: [...new Set(conv.vars)], uses: num(c.count, 0) || null,
        });
        bundle.media.push(...conv.media.map((m) => ({ ...m, usedBy: c.trigger })));
    }

    // events (profile: { mainEvents: [], groups: { id: { name, events } } }; setup: events[] + eventGroups[])
    const evFile = comp ? null : pick(null, 'events/events.json');
    const events = [];
    if (comp) {
        for (const e of list(comp.events)) events.push({ e, group: null });
        for (const grp of list(comp.eventGroups)) for (const e of list(grp.events)) events.push({ e, group: grp });
    } else if (evFile && typeof evFile === 'object') {
        for (const e of list(evFile.mainEvents)) events.push({ e, group: null });
        for (const grp of list(evFile.groups)) for (const e of list(grp.events)) events.push({ e, group: grp });
    }
    for (const { e, group } of events) {
        if (!e || typeof e !== 'object') continue;
        const id = `${e.sourceId}:${e.eventId}`;
        const name = str(e.name || id, 100);
        const enabled = e.active !== false && (group ? group.active !== false : true);
        const type = FIREBOT_EVENTS[id];
        if (!type) {
            bundle.dropped.push({ category: 'automations', name, reason: `The Firebot event ${id} has no CertiFried trigger`, gap: EVENT_GAP[id] || 'trigger.other', detail: id });
            continue;
        }
        const conv = convertEffects(effectList(e.effects), ctx);
        const trig = eventTrigger(type, id, e.filterData);
        bundle.automations.push({
            sourceId: String(e.id || name), kind: 'event', name, enabled, trigger: trig.trigger,
            actions: conv.actions, gaps: [...conv.gaps, ...trig.gaps], notes: [...conv.notes, ...trig.notes], vars: [...new Set(conv.vars)],
        });
        bundle.media.push(...conv.media.map((m) => ({ ...m, usedBy: name })));
    }

    // timers
    for (const t of list(pick('timers', 'timers.json'))) {
        if (!t || typeof t !== 'object') continue;
        const conv = convertEffects(effectList(t.effects), { ...ctx, timer: true });
        if (conv.actions.some((x) => x.type === 'overlay.text') && num(t.interval, 0) < 60) {
            conv.notes.push(`Firebot showed this every ${num(t.interval, 0)} seconds as a counter display; here the timer shows it for a minute every minute (timers run at most once a minute)`);
        }
        bundle.timers.push({
            sourceId: String(t.id || t.name), name: str(t.name, 100), enabled: t.active !== false, intervalSeconds: num(t.interval, 0),
            chatLines: num(t.requiredChatLines, 0), liveOnly: !!t.onlyWhenLive, actions: conv.actions, gaps: conv.gaps, notes: conv.notes, vars: [...new Set(conv.vars)],
        });
        bundle.media.push(...conv.media.map((m) => ({ ...m, usedBy: `timer ${t.name}` })));
    }

    // channel point rewards (definitions + "when redeemed" effects) and power-ups
    for (const r of list(pick('channelRewards', 'channel-rewards.json'))) {
        const td = r?.twitchData || {};
        if (!td.title) continue;
        bundle.rewards.push(rewardDef('channel_points', r, td));
        const conv = convertEffects(effectList(r.effects), ctx);
        if (effectList(r.effects).length) {
            const rid = str(td.id || r.id, 64);
            bundle.automations.push({
                sourceId: `reward:${r.id}`, kind: 'reward', name: `Reward: ${str(td.title, 80)}`, enabled: td.isEnabled !== false,
                trigger: { type: 'redemption', config: { platforms: ['twitch'] }, conditions: [{ type: 'metadata', path: 'rewardId', op: 'eq', value: rid }] },
                actions: conv.actions, gaps: conv.gaps, notes: conv.notes, vars: [...new Set(conv.vars)], rewardId: rid, rewardTitle: str(td.title, 100),
            });
            bundle.media.push(...conv.media.map((m) => ({ ...m, usedBy: `reward ${td.title}` })));
        }
    }
    for (const r of list(pick('powerUps', 'power-ups.json'))) {
        const td = r?.twitchData || {};
        if (!td.title) continue;
        bundle.rewards.push(rewardDef('power_up', r, td));
    }

    // moderation
    const modSet = comp ? null : pick(null, 'chat/moderation/chat-moderation-settings.json');
    const words = comp ? null : pick(null, 'chat/moderation/banned-words.json');
    const regex = comp ? null : pick(null, 'chat/moderation/banned-regular-expressions.json');
    const allow = comp ? null : pick(null, 'chat/moderation/url-allowlist.json');
    if (modSet || words || regex || allow) {
        const w = list(words?.words).map((x) => str(x?.text ?? x, 100)).filter(Boolean);
        bundle.moderation = {
            bannedWords: w, bannedWordsOn: !!modSet?.bannedWordList?.enabled, bannedRegex: list(regex?.regularExpressions ?? regex).length,
            urlModeration: !!modSet?.urlModeration?.enabled, urlAllowlist: list(allow?.urls ?? allow).length,
            emoteLimit: modSet?.emoteLimit?.enabled ? num(modSet.emoteLimit.max, 0) : null,
        };
    }

    // hotkeys
    for (const h of list(pick('hotkeys', 'hotkeys.json'))) {
        if (!h || typeof h !== 'object') continue;
        bundle.hotkeys.push({ sourceId: String(h.id || h.name), name: str(h.name || h.code, 100), keys: str(h.code || h.rawKeys || '', 60), enabled: h.active !== false, actionCount: effectList(h.effects).length });
    }

    // integrations: service names only; OBS host and port
    const integ = comp ? null : pick(null, 'integrations.json');
    if (integ && typeof integ === 'object') {
        for (const [k, v] of Object.entries(integ)) {
            const service = String(k).toLowerCase();
            if (service === 'obs') {
                const ws = v?.userSettings?.websocketSettings || v?.settings || {};
                const host = str(ws.ipAddress || ws.address || ws.host || '', 100);
                const port = num(ws.port, 0);
                if (host || port) bundle.obs = { host: host || '127.0.0.1', port: port || 4455 };
                bundle.integrations.push({ service: 'obs', detail: 'OBS websocket' });
            } else bundle.integrations.push({ service, detail: v && typeof v === 'object' && 'linked' in v ? (v.linked ? 'linked' : 'not linked') : '' });
        }
    }

    // quotes (rows read from databases/quotes.db by the caller)
    for (const q of list(quotes)) {
        if (!q?.text) continue;
        bundle.quotes.push({ sourceId: String(q.id ?? q._id ?? bundle.quotes.length + 1), text: str(q.text, 500), author: str(q.originator, 100), game: str(q.game, 100), createdAt: q.created_at || q.createdAt || null });
    }

    // viewer stats (db/users.db is NeDB: one JSON document per line)
    const users = fm.get('db/users.db');
    if (users) {
        const rows = [];
        let n = 0;
        const fields = new Set();
        for (const line of asText(users).split(/\r?\n/)) {
            if (!line.trim()) continue;
            let d;
            try { d = JSON.parse(line); } catch { continue; }
            if (!d?._id || d.$$indexCreated) continue;
            n++;
            for (const k of Object.keys(d)) fields.add(k);
            if (wantViewers && /^\d{1,20}$/.test(String(d._id)) && d.twitch !== false) {
                // H-747: names, first and last seen and the currency balance too (viewer records, core/stream-bot/viewers).
                rows.push({ platform: 'twitch', id: String(d._id), login: str(d.username, 40), name: d.displayName ? str(d.displayName, 100) : null,
                    watchMinutes: num(d.minutesInChannel, 0), chatMessages: num(d.chatMessages, 0),
                    firstSeen: num(d.joinDate, 0) > 0 ? num(d.joinDate, 0) : null, lastSeen: num(d.lastSeen, 0) > 0 ? num(d.lastSeen, 0) : null,
                    currency: d.currency && typeof d.currency === 'object' && !Array.isArray(d.currency) ? d.currency : null });
            }
        }
        const loyalty = firebotLoyalty(fm, rows);
        for (const r of rows) { if (loyalty.currencyId && r.currency) { const v = num(r.currency[loyalty.currencyId], 0); if (v > 0) r.points = Math.round(v); } delete r.currency; }
        bundle.viewers = { count: n, fields: [...fields].filter((f) => !/token|auth/i.test(f)).sort(), rows: wantViewers ? rows : [], settings: loyalty.settings, notes: loyalty.notes };
    }

    // what files were seen (names only)
    bundle.files = [...fm.keys()].sort();
    return bundle;
}

/**
 * Firebot's currency (currency/currency.json) and rank ladders (ranks.json) → viewer settings for CertiFried (H-747).
 * One points currency per channel: the only active currency, else the one most viewers hold. Rank ladders: the first
 * automatic ladder that follows view time (hours) or that currency. Anything else is reported, not guessed.
 */
export function firebotLoyalty(fm, rows = []) {
    const notes = [];
    const settings = {};
    const defs = list(json(fm, 'currency/currency.json')).filter((c) => c && typeof c === 'object' && c.id);
    let currencyId = null;
    const active = defs.filter((c) => c.active !== false);
    if (active.length === 1) currencyId = String(active[0].id);
    else {
        const held = new Map();
        for (const r of rows) for (const [k, v] of Object.entries(r.currency || {})) if (num(v, 0) > 0) held.set(k, (held.get(k) || 0) + 1);
        currencyId = [...held.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || (active[0] ? String(active[0].id) : null);
        if (active.length > 1 || held.size > 1) notes.push('Firebot has more than one currency; CertiFried keeps one points balance, so only the most used one was brought over');
    }
    const def = defs.find((c) => String(c.id) === currencyId);
    if (def) {
        const name = str(def.name, 20).replace(/[^\p{L}\p{N} ]/gu, '').trim();
        if (name) settings.currency = name;
        const every = num(def.interval, 0);
        const payout = num(def.payout, 0);
        if (every > 0 && payout >= 0) {
            const periods = [5, 10, 15, 20, 30, 60];
            const minutes = periods.reduce((a, b) => (Math.abs(b - every) < Math.abs(a - every) ? b : a), 10);
            settings.earn = { minutes, points: Math.round(payout * (minutes / every)) };
            if (minutes !== every) notes.push(`Firebot paid every ${every} minutes; CertiFried pays every ${minutes}, with the amount scaled to match`);
        }
    }
    const ladders = list(json(fm, 'ranks.json')).filter((l) => l && typeof l === 'object');
    const ladder = ladders.find((l) => String(l.mode || 'auto') === 'auto' && Array.isArray(l.ranks) && l.ranks.length);
    if (ladder) {
        const by = String(ladder.settings?.trackBy || ladder.trackBy || 'view_time');
        const basis = /currency/i.test(by) ? 'points' : 'watch';
        const listOut = ladder.ranks.map((r) => ({ name: str(r?.name, 40).trim(), min: Math.round(num(r?.value, 0) * (basis === 'watch' ? 60 : 1)) })).filter((r) => r.name).slice(0, 20);
        if (listOut.length) settings.ranks = { basis, list: listOut };
        if (ladders.length > 1) notes.push('Only the first automatic rank ladder was brought over');
    } else if (ladders.length) notes.push('Firebot ranks set by hand are not brought over: CertiFried ranks follow watch time or points');
    return { currencyId, settings: Object.keys(settings).length ? settings : null, notes };
}

function rewardDef(kind, r, td) {
    return {
        sourceId: String(td.id || r.id), kind, twitchId: str(td.id || r.id, 64), title: str(td.title, 45), prompt: str(td.prompt, 200),
        cost: num(kind === 'power_up' ? td.bits : td.cost, 0), costUnit: kind === 'power_up' ? 'bits' : 'points', enabled: td.isEnabled !== false,
        userInput: !!td.isUserInputRequired, color: /^#[0-9a-f]{6}$/i.test(String(td.backgroundColor || '')) ? td.backgroundColor : null,
        cooldownSeconds: td.globalCooldownSetting?.isEnabled ? num(td.globalCooldownSetting.globalCooldownSeconds) : 0,
        maxPerStream: td.maxPerStreamSetting?.isEnabled ? num(td.maxPerStreamSetting.maxPerStream) : 0,
        maxPerUserPerStream: td.maxPerUserPerStreamSetting?.isEnabled ? num(td.maxPerUserPerStreamSetting.maxPerUserPerStream) : 0,
        skipQueue: !!td.shouldRedemptionsSkipRequestQueue, createdBy: r.manageable === false ? 'another app' : 'Firebot',
    };
}

/** Firebot event filters → trigger config and conditions. */
function eventTrigger(type, id, filterData) {
    const trigger = { type, config: {}, conditions: [] };
    const gaps = [];
    const notes = [];
    if (TIP_PLATFORM[id]) trigger.config.platforms = [TIP_PLATFORM[id]];
    else if (id.startsWith('twitch:')) trigger.config.platforms = ['twitch'];
    if (type === 'bits.used') {
        trigger.config.bitsKind = { 'twitch:bits-powerup-message-effect': 'message_effect', 'twitch:bits-powerup-celebration': 'celebration',
            'twitch:bits-powerup-gigantified-emote': 'gigantify_an_emote' }[id] || 'power_up';
    }
    if (type === 'studio.connected') notes.push('Firebot started → CertiFried Studio connected');
    let filters = list(filterData?.filters);
    // Firebot filter modes: "exclusive" = all filters must pass (the default), "inclusive" = any one is enough.
    if (filters.length > 1 && String(filterData?.mode) === 'inclusive') {
        const texts = filters.filter((f) => (f.type === 'firebot:message-text' || f.type === 'firebot:chat-message') && String(f.comparisonType || '').toLowerCase() === 'contains');
        if (type === 'chat' && texts.length === filters.length) {
            const alt = texts.map((f) => String(f.value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
            if (alt.length <= 190) {
                trigger.config.match = { mode: 'regex', text: `(${alt})`, caseSensitive: false };
                notes.push('Its "any of these words" filters became one pattern');
                filters = [];
            }
        }
        if (filters.length) notes.push('Its filters were "any of"; CertiFried checks all of them');
    }
    for (const f of filters) {
        const t = String(f.type || '');
        const cmp = String(f.comparisonType || 'is').toLowerCase();
        const val = str(f.value, 200);
        const textMode = cmp === 'is' ? 'exact' : cmp === 'contains' ? 'contains' : cmp.startsWith('starts') ? 'starts' : cmp.includes('regex') ? 'regex' : null;
        if ((t === 'firebot:message-text' || t === 'firebot:chat-message') && type === 'chat' && textMode) {
            if (!trigger.config.match) trigger.config.match = { mode: textMode, text: val, caseSensitive: false };
            else trigger.conditions.push({ type: 'text', mode: textMode, text: val, field: 'message', caseSensitive: false });
        } else if (t === 'firebot:username' && textMode) {
            trigger.conditions.push({ type: 'text', mode: textMode, text: val, field: 'user', caseSensitive: false });
        } else if ((t === 'firebot:cheerbitsamount' || t === 'firebot:raid-viewer-count' || t === 'firebot:gift-count') && /^\d+$/.test(val)) {
            const n = Number(val);
            trigger.conditions.push({ type: 'amount', min: cmp.includes('less') ? null : n, max: cmp.includes('greater') ? null : n });
        } else if (t === 'firebot:rewardname' || t === 'firebot:reward') {
            trigger.conditions.push(/^[0-9a-f-]{36}$/i.test(val) ? { type: 'metadata', path: 'rewardId', op: 'eq', value: val } : { type: 'text', mode: 'exact', text: val, field: 'reward', caseSensitive: false });
        } else {
            notes.push(`The ${t.replace(/^firebot:/, '') || 'unknown'} filter (${cmp}) was not kept`);
        }
    }
    if (type === 'chat' && !trigger.config.match) {
        const firstText = trigger.conditions.findIndex((c) => c.type === 'text' && c.field === 'message');
        if (firstText >= 0) {
            const c = trigger.conditions.splice(firstText, 1)[0];
            trigger.config.match = { mode: c.mode, text: c.text, caseSensitive: false };
        } else {
            trigger.config.match = { mode: 'regex', text: '.', caseSensitive: false };
            notes.push('This ran on every chat message; it matches every message here too');
        }
    }
    if (type === 'sub' && id === 'twitch:sub') notes.push('Firebot runs this for resubs too; in CertiFried a resub is its own trigger (Resubscription)');
    return { trigger, gaps, notes };
}

export default { parseFirebot, convertEffects, profileRoot, FIREBOT_EVENTS };
