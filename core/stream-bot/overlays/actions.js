/*
 * Stream bot overlays: the automation actions (registered through actions.js registerActionType(); design §9).
 *
 *   overlay.text   "Show text on stream"            target overlay, capability show: text (template), position, size,
 *                                                   duration, animation, on a chosen overlay
 *   overlay.media  "Show an image or video on stream"  target overlay, capability show: a file from your media (name or
 *                                                   a variable), position, size, duration, volume, animation
 *   overlay.goal   "Change a goal"                  server: add to or set a Goal bar overlay's progress
 *
 * overlay.text and overlay.media are client actions: the engine renders their templates and hands them to
 * io.dispatch(), which core/stream-bot/overlays/index.js routes to the overlay service for target 'overlay' (queued
 * while no overlay page is open, like Studio actions). The existing overlay.alert action takes the same route to the
 * alert box. `overlay` holds an overlay id, or nothing for "the Text and media overlay, else the alert box".
 *
 *   registerOverlayActions(actionsModule, { serviceRef }) → number registered
 */
import { POSITIONS, POSITION_LABEL, ANIMATIONS, ANIMATION_LABEL } from './config.js';

export const TEXT_SIZES = Object.freeze({ small: 36, medium: 56, large: 84, huge: 120 });
export const MEDIA_SIZES = Object.freeze({ small: 20, medium: 35, large: 55, full: 100 });
const SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge', full: 'Full screen' };
const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });
const posField = () => f('position', 'select', 'Where on screen', { options: [...POSITIONS], optionLabels: { ...POSITION_LABEL }, default: 'center' });
const animField = () => f('animation', 'select', 'Animation', { options: [...ANIMATIONS], optionLabels: { ...ANIMATION_LABEL }, default: 'rise' });
const overlayField = (types) => f('overlay', 'overlay', 'Overlay', { optional: true, overlayTypes: types });

const intIn = (v, lo, hi, d) => { const n = Math.round(Number(v)); return v === '' || v == null || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n)); };
const overlayId = (v) => (v === '' || v == null ? '' : (/^\d{1,15}$/.test(String(v)) ? Number(v) : null));

export function overlayActionDefs({ serviceRef = { current: null } } = {}) {
    const notHere = async () => ({ status: 'failed', detail: 'overlay actions are sent to an overlay, not run on the server' });
    return [
        {
            type: 'overlay.text', label: 'Show text on stream', target: 'overlay', capability: 'show', group: 'Overlay', phase: 3,
            fields: [overlayField(['canvas', 'alerts']), f('text', 'template', 'Text'), posField(),
                f('size', 'select', 'Size', { options: Object.keys(TEXT_SIZES), optionLabels: SIZE_LABEL, default: 'medium' }),
                f('durationMs', 'number', 'Show for (ms)', { min: 1000, max: 60000, default: 5000 }), animField()],
            templates: ['text'],
            validate(s, out, err) {
                out.overlay = overlayId(s.overlay);
                if (out.overlay === null) { err('pick an overlay from the list.'); out.overlay = ''; }
                out.text = String(s.text ?? '').slice(0, 2000).trim();
                if (!out.text) err('enter the text to show.');
                out.position = POSITIONS.includes(s.position) ? s.position : 'center';
                out.size = Object.hasOwn(TEXT_SIZES, s.size) ? s.size : 'medium';
                out.durationMs = intIn(s.durationMs, 1000, 60000, 5000);
                out.animation = ANIMATIONS.includes(s.animation) ? s.animation : 'rise';
            },
            execute: notHere,
        },
        {
            type: 'overlay.media', label: 'Show an image or video on stream', target: 'overlay', capability: 'show', group: 'Overlay', phase: 3,
            fields: [overlayField(['canvas', 'alerts']), f('media', 'text', 'Image or video (its name in your media)', { suggest: 'media' }), posField(),
                f('size', 'select', 'Size', { options: Object.keys(MEDIA_SIZES), optionLabels: SIZE_LABEL, default: 'medium' }),
                f('durationMs', 'number', 'Show for (ms; a video stops at its end)', { min: 1000, max: 60000, default: 6000 }),
                f('volume', 'number', 'Video volume (0-100)', { min: 0, max: 100, default: 80 }), animField()],
            templates: ['media'],
            validate(s, out, err) {
                out.overlay = overlayId(s.overlay);
                if (out.overlay === null) { err('pick an overlay from the list.'); out.overlay = ''; }
                out.media = String(s.media ?? '').slice(0, 200).trim();
                if (!out.media) err('pick an image or video from your media (Overlays tab).');
                out.position = POSITIONS.includes(s.position) ? s.position : 'center';
                out.size = Object.hasOwn(MEDIA_SIZES, s.size) ? s.size : 'medium';
                out.durationMs = intIn(s.durationMs, 1000, 60000, 6000);
                out.volume = intIn(s.volume, 0, 100, 80);
                out.animation = ANIMATIONS.includes(s.animation) ? s.animation : 'rise';
            },
            execute: notHere,
        },
        {
            type: 'overlay.goal', label: 'Change a goal', target: 'server', group: 'Overlay', phase: 3,
            fields: [overlayField(['goal']), f('mode', 'select', 'Do', { options: ['add', 'set'], optionLabels: { add: 'Add to the progress', set: 'Set the progress to' }, default: 'add' }),
                f('value', 'template', 'Amount (a number or a variable such as {amount})')],
            templates: ['value'],
            validate(s, out, err) {
                out.overlay = overlayId(s.overlay);
                if (!out.overlay) { err('pick the goal overlay.'); out.overlay = ''; }
                out.mode = s.mode === 'set' ? 'set' : 'add';
                out.value = String(s.value ?? '').slice(0, 200).trim();
                if (!out.value) err('enter the amount.');
            },
            async execute(step, ctx) {
                const svc = serviceRef.current;
                if (!svc) return { status: 'failed', detail: 'overlays are not running yet' };
                const raw = (await ctx.render(step.value)).trim().replace(/,/g, '');
                const n = Number(raw);
                if (!Number.isFinite(n)) return { status: 'failed', detail: `"${raw.slice(0, 40)}" is not a number` };
                if (ctx.dryRun) return { status: 'dry', detail: `would ${step.mode === 'set' ? 'set the goal to' : 'add'} ${n}` };
                const r = await svc.changeGoal(ctx.profile.id, Number(step.overlay), step.mode, n);
                return r.ok ? { status: 'ok', detail: `goal is now ${r.current} of ${r.target}` } : { status: 'failed', detail: r.error };
            },
        },
    ];
}

/** Register the three actions (idempotent: an already registered type is left alone). */
export function registerOverlayActions(actionsModule, opts = {}) {
    let n = 0;
    for (const def of overlayActionDefs(opts)) if (actionsModule.registerActionType(def)) n++;
    return n;
}

export default { overlayActionDefs, registerOverlayActions, TEXT_SIZES, MEDIA_SIZES };
