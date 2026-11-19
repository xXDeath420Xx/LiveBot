/*
 * Turning a picture into a Discord emoji.
 *
 * An emoji is not a small image — it is a 128-pixel square that has to read at
 * 32 pixels in a message and at 22 in a reaction, with nothing behind it. Three
 * things stand between a generated picture and that:
 *
 *   1. No alpha. Gemini answers with JPEG whatever you ask for, so "transparent
 *      background" is not a thing it can give you. What it CAN give is a flat,
 *      perfectly uniform backdrop — verified identical in all four corners — and
 *      a flat backdrop can be cut out exactly.
 *   2. Wasted margin. A sticker centred in a 1024 square is mostly empty; shrunk
 *      whole to 128 it becomes a speck. It has to be trimmed to what is actually
 *      drawn before it is resized.
 *   3. 256 KiB, hard. Discord rejects anything larger with an unhelpful error.
 *
 * The cutout is a flood fill inwards from the border rather than "delete every
 * pixel of this colour". Kuromi is black and pink; a global pink key would punch
 * holes through her. Only background connected to the edge is background.
 */
import sharp from 'sharp';
import logger from '../utils/logger.js';

export const MAX_BYTES = 256 * 1024;
export const NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

/** Slots per tier, both kinds counted separately. */
export const SLOTS_PER_TIER = { 0: 50, 1: 100, 2: 150, 3: 250 };

/**
 * Cut the flat backdrop away.
 *
 * `tolerance` is how far a pixel may drift from the key colour and still count
 * as background — JPEG compression alone moves a flat colour by a few points,
 * and the sticker's drop shadow moves it further. `feather` is the wider band
 * where a pixel is only partly erased, which is what stops the cutout looking
 * like it was done with scissors.
 */
export async function cutOutBackground(input, { tolerance = 42, feather = 26, key = null } = {}) {
    const { data, info } = await sharp(input)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width: w, height: h, channels: ch } = info;
    const at = (x, y) => (y * w + x) * ch;

    /* The key colour is whatever the corners agree on. Reading it rather than
       assuming magenta means the same code cuts out a white background, a green
       one, or whatever a future provider happens to produce. */
    const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
    let kr = 0, kg = 0, kb = 0;
    if (key) {
        ({ r: kr, g: kg, b: kb } = key);
    } else {
        for (const [x, y] of corners) {
            const i = at(x, y);
            kr += data[i]; kg += data[i + 1]; kb += data[i + 2];
        }
        kr /= 4; kg /= 4; kb /= 4;
    }

    // Corners that disagree wildly mean this is a photo, not a sticker on a flat
    // field. Cutting it would take chunks out of the picture, so leave it alone.
    const spread = Math.max(...corners.map(([x, y]) => {
        const i = at(x, y);
        return Math.max(Math.abs(data[i] - kr), Math.abs(data[i + 1] - kg), Math.abs(data[i + 2] - kb));
    }));
    if (!key && spread > tolerance) {
        logger.info(`[EmotePack] background is not flat (corners differ by ${Math.round(spread)}) — left as it is`,
            { category: 'emoji' });
        return { buffer: await sharp(input).ensureAlpha().png().toBuffer(), cut: false };
    }

    const dist = (i) => Math.max(
        Math.abs(data[i] - kr), Math.abs(data[i + 1] - kg), Math.abs(data[i + 2] - kb));

    /* Flood fill inwards from every border pixel. Only background that the edge
       can reach gets erased, so a magenta bow ON the character survives. */
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const push = (x, y) => {
        const p = y * w + x;
        if (seen[p]) return;
        if (dist(p * ch) > tolerance + feather) return;
        seen[p] = 1;
        queue[tail++] = p;
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

    while (head < tail) {
        const p = queue[head++];
        const x = p % w, y = (p / w) | 0;
        const d = dist(p * ch);
        /* Inside `tolerance` it is background outright; through the feather band
           it fades, which is the antialiased rim of the drawing. */
        data[p * ch + 3] = d <= tolerance ? 0
            : Math.round(255 * Math.min(1, (d - tolerance) / feather));
        if (x > 0) push(x - 1, y);
        if (x < w - 1) push(x + 1, y);
        if (y > 0) push(x, y - 1);
        if (y < h - 1) push(x, y + 1);
    }

    const cutPixels = tail;
    return {
        buffer: await sharp(data, { raw: { width: w, height: h, channels: ch } }).png().toBuffer(),
        cut: true,
        coverage: cutPixels / (w * h),
    };
}

/**
 * Trim, square, shrink and squeeze until Discord will take it.
 *
 * The squeeze matters: a 128px sticker with a soft edge does not always fit in
 * 256 KiB at full colour, and finding that out from Discord costs a failed
 * upload and a confusing message. Dropping to a palette first, then shrinking,
 * gets there without ever looking obviously degraded at emoji size.
 */
export async function prepareEmote(input, { size = 128 } = {}) {
    let img = sharp(input).ensureAlpha();

    // Trim to what is actually drawn — a centred sticker is mostly empty space,
    // and shrinking the empty space with it is what makes emoji look tiny.
    const trimmed = await img.trim({ threshold: 1 }).toBuffer().catch(() => null);
    if (trimmed) img = sharp(trimmed);

    const base = await img
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

    if (base.length <= MAX_BYTES) return base;

    for (const [colours, px] of [[128, size], [64, size], [64, 96], [32, 96], [32, 72]]) {
        const squeezed = await sharp(base)
            .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png({ palette: true, colours, effort: 10 })
            .toBuffer();
        if (squeezed.length <= MAX_BYTES) return squeezed;
    }
    throw new Error('this image will not fit in 256 KiB even shrunk');
}

/** A name Discord will accept, derived from something a person typed. */
export function emoteName(label) {
    const name = String(label || '')
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
    return NAME_RE.test(name) ? name : null;
}

/**
 * The prompt that produces something cuttable.
 *
 * Every word here is doing work. "Sticker" gets a subject with an outline rather
 * than a scene; the flat magenta is what the cutout keys on; "no shadow" is
 * because a soft shadow bleeds into the backdrop and survives the cut as grey
 * fog; and the margin keeps the drawing off the border, where the flood fill
 * starts — a sticker touching the edge gets eaten from the outside in.
 */
export function stickerPrompt(subject, { extra = '' } = {}) {
    return [
        `A single cute chibi kawaii sticker of ${subject}.`,
        'Bold clean cartoon lineart, bright saturated colours, thick white sticker border around the whole shape.',
        'One subject only, centred, facing the viewer, filling most of the frame but with a clear margin at every edge.',
        extra && extra.trim(),
        'The entire background is one flat solid pure magenta #FF00FF, completely uniform,',
        'no gradient, no shading, no drop shadow, no glow, no pattern.',
    ].filter(Boolean).join(' ');
}

/**
 * Picture in, emoji out.
 *
 * `cut: false` skips the cutout for photographs and for artwork that already has
 * an alpha channel, where a flood fill has nothing to do and can only do harm.
 */
export async function makeEmote(buffer, { size = 128, cut = true } = {}) {
    let working = buffer;
    let cutInfo = { cut: false };
    if (cut) {
        const has = await sharp(buffer).metadata().then((m) => m.hasAlpha).catch(() => false);
        if (!has) {
            cutInfo = await cutOutBackground(buffer);
            working = cutInfo.buffer;
        }
    }
    const png = await prepareEmote(working, { size });
    /* Name the cutout's fields explicitly. Spreading `cutInfo` put ITS buffer —
       the full-size cut-out, about a megabyte — back over the prepared 128px
       one, so `bytes` reported 25KB while `buffer` held the big image. Every
       caller then wrote or uploaded the wrong picture. */
    return { buffer: png, bytes: png.length, cut: cutInfo.cut, coverage: cutInfo.coverage };
}

/** How many emoji this guild can still hold. */
export async function emoteCapacity(token, guildId) {
    const headers = { Authorization: `Bot ${token}` };
    const [guild, emojis] = await Promise.all([
        fetch(`https://discord.com/api/v10/guilds/${guildId}`, { headers }).then((r) => r.json()),
        fetch(`https://discord.com/api/v10/guilds/${guildId}/emojis`, { headers }).then((r) => r.json()),
    ]);
    const per = SLOTS_PER_TIER[guild.premium_tier] ?? 50;
    const list = Array.isArray(emojis) ? emojis : [];
    return {
        perTier: per,
        tier: guild.premium_tier,
        used: list.filter((e) => !e.animated).length,
        usedAnimated: list.filter((e) => e.animated).length,
        free: per - list.filter((e) => !e.animated).length,
        freeAnimated: per - list.filter((e) => e.animated).length,
        names: new Set(list.map((e) => e.name)),
    };
}

/**
 * Discord's emoji routes rate-limit harder than most, and a 429 here is not a
 * nuisance — it silently breaks the batch. A run that deleted ten emoji and then
 * got 429ed on the eleventh and twelfth left two slots unfreed, so the last two
 * uploads failed with "maximum number of emojis reached". Wait and retry.
 */
async function emojiRequest(url, init, { tries = 4, maxWaitMs = 60_000 } = {}) {
    for (let attempt = 0; attempt < tries; attempt++) {
        const res = await fetch(url, init);
        if (res.status !== 429) return res;

        const body = await res.json().catch(() => ({}));
        const wait = Math.ceil(((body.retry_after ?? 1) * 1000) + 250);

        /* Creating emoji is capped per guild per HOUR, and once that is spent
           Discord asks for up to half an hour. Sleeping through it inside one
           request looks identical to a hang: the batch stops, nothing is logged,
           and the dashboard button spins forever. Past a minute, hand the 429
           back and say how long it wants. */
        if (wait > maxWaitMs) {
            logger.warn(`[EmotePack] emoji rate limit has ${Math.round(wait / 1000)}s left — giving up on this one`,
                { category: 'emoji' });
            return new Response(JSON.stringify({
                message: `Discord is limiting how many emoji this server can add right now. Try again in about ${Math.ceil(wait / 60000)} minutes.`,
                retry_after: body.retry_after,
            }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        }

        logger.info(`[EmotePack] rate limited, waiting ${wait}ms`, { category: 'emoji' });
        await new Promise((r) => setTimeout(r, wait));
    }
    return fetch(url, init);
}

/** Upload one prepared PNG. Returns the created emoji or an explained failure. */
export async function uploadEmote(token, guildId, name, png, reason = 'Emote pack') {
    const res = await emojiRequest(`https://discord.com/api/v10/guilds/${guildId}/emojis`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            // The audit-log header is a ByteString: anything above 0xFF throws.
            'X-Audit-Log-Reason': reason.replace(/[^\x20-\x7E]/g, ''),
        },
        body: JSON.stringify({ name, image: `data:image/png;base64,${png.toString('base64')}` }),
    });
    if (res.ok) return { ok: true, emoji: await res.json() };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, reason: body.slice(0, 200) };
}

/** Remove one emoji. Same retry treatment: a failed delete costs a slot. */
export async function deleteEmote(token, guildId, emojiId, reason = 'Emote pack') {
    const res = await emojiRequest(`https://discord.com/api/v10/guilds/${guildId}/emojis/${emojiId}`, {
        method: 'DELETE',
        headers: {
            Authorization: `Bot ${token}`,
            'X-Audit-Log-Reason': reason.replace(/[^\x20-\x7E]/g, ''),
        },
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, reason: (await res.text().catch(() => '')).slice(0, 200) };
}

export default {
    cutOutBackground, prepareEmote, emoteName, stickerPrompt, makeEmote,
    emoteCapacity, uploadEmote, deleteEmote, MAX_BYTES, NAME_RE, SLOTS_PER_TIER,
};
