/*
 * One way to ask for a picture.
 *
 * Three features had grown their own image-generation code — /imagine, birthday
 * card covers, and schedule backdrops — each against a different provider, each
 * breaking on its own schedule. hf-inference started answering 410 for the
 * models /imagine names; the card covers point at a Google key whose daily image
 * quota is spent; the schedule art works but only through one host.
 *
 * So: one call, several providers, tried in order until one answers.
 *
 * Google first, for a reason beyond price. Gemini's image models accept an
 * INPUT image, which is the only honest way to serve what people actually
 * upload. Owners do not have blank backgrounds lying around — they have last
 * month's finished poster with the dates still on it. Handing that to Gemini and
 * asking for the same artwork with no lettering gives back the real thing.
 * Everything else can only be told ABOUT the picture, in words, second-hand.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'dashboard', 'public', 'uploads');

/* Two Google keys live in the environment and they are not interchangeable:
   each carries its own free-tier image quota, and one of them is routinely
   spent. Trying both is the difference between "the feature is down" and "the
   feature took the other key". */
const GOOGLE_KEYS = () => [process.env.GOOGLE_API_KEY, process.env.GOOGLE_AI_KEY, process.env.GOOGLE_AI_KEY_2].filter(Boolean);
const GOOGLE_MODELS = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image'];
const FAL_URL = 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell';

const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT = 120_000;

/** Aspect ratios Gemini accepts, keyed by what callers actually think in. */
const ASPECT = {
    landscape: '16:9',
    portrait: '3:4',
    square: '1:1',
};

/** Words that reduce — never eliminate — invented lettering. */
function noLettering(prompt) {
    return `${prompt}. No text, no words, no letters, no writing, no logos, no watermark.`;
}

/**
 * Google. Takes a reference image; answers with the bytes inline.
 * Returns null (rather than throwing) when a key is simply out of quota, so the
 * next key and then the next provider get their turn.
 */
async function viaGoogle({ prompt, reference, aspect, timeout }) {
    const keys = GOOGLE_KEYS();
    if (!keys.length) return null;

    const parts = [];
    if (reference?.buffer) {
        parts.push({
            inlineData: {
                mimeType: reference.contentType || 'image/png',
                data: reference.buffer.toString('base64'),
            },
        });
    }
    parts.push({ text: noLettering(prompt) });

    const body = JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: ASPECT[aspect] || ASPECT.landscape },
        },
    });

    let lastNote = '';
    for (const key of keys) {
        for (const model of GOOGLE_MODELS) {
            let res;
            try {
                res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body,
                        signal: AbortSignal.timeout(timeout),
                    });
            } catch (e) {
                lastNote = `${model}: ${e.message}`;
                continue;
            }

            if (res.status === 429 || res.status === 403) {
                // Out of quota on this key — a different key may still have some.
                lastNote = `${model}: HTTP ${res.status}`;
                break;
            }
            if (!res.ok) {
                lastNote = `${model}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`;
                continue;
            }

            const data = await res.json().catch(() => null);
            const image = data?.candidates?.[0]?.content?.parts
                ?.find((p) => p.inlineData?.mimeType?.startsWith('image/'));
            if (!image) {
                /* A refusal comes back as a 200 carrying only text. Say what it
                   said, because "no image" on its own is undebuggable. */
                const said = data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
                lastNote = `${model}: no image${said ? ` — ${said.slice(0, 120)}` : ''}`;
                continue;
            }
            return {
                buffer: Buffer.from(image.inlineData.data, 'base64'),
                contentType: image.inlineData.mimeType,
                provider: 'google',
                model,
            };
        }
    }
    if (lastNote) logger.info(`[ImageGen] Google unavailable (${lastNote})`, { category: 'ai' });
    return null;
}

/**
 * fal-ai through the Hugging Face router. Text only — it cannot be shown a
 * reference image, so a caller relying on one has to settle for the description.
 */
async function viaFal({ prompt, aspect, timeout }) {
    const token = process.env.HF_API_TOKEN;
    if (!token) return null;
    try {
        const res = await fetch(FAL_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: noLettering(prompt),
                image_size: aspect === 'portrait' ? 'portrait_4_3'
                    : aspect === 'square' ? 'square' : 'landscape_16_9',
            }),
            signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) {
            logger.info(`[ImageGen] fal-ai returned HTTP ${res.status}`, { category: 'ai' });
            return null;
        }
        const image = (await res.json().catch(() => null))?.images?.[0];
        if (!image?.url) return null;
        const file = await fetch(image.url, { signal: AbortSignal.timeout(60_000) });
        if (!file.ok) return null;
        const buffer = Buffer.from(await file.arrayBuffer());
        if (buffer.length > MAX_BYTES) return null;
        return {
            buffer,
            contentType: image.content_type || file.headers.get('content-type') || 'image/jpeg',
            provider: 'fal-ai',
            model: 'flux-schnell',
        };
    } catch (e) {
        logger.info(`[ImageGen] fal-ai unavailable (${e.message})`, { category: 'ai' });
        return null;
    }
}

/**
 * Make a picture.
 *
 * `reference` — { buffer, contentType } — is an image to work FROM rather than a
 * description of one. Only Google can use it; if every Google key is spent the
 * call still succeeds through fal-ai, working from `prompt` alone, and the
 * result says which provider answered so the caller can tell the difference.
 *
 * Throws only when nothing at all could produce an image.
 */
export async function generateImage({
    prompt,
    reference = null,
    aspect = 'landscape',
    timeout = DEFAULT_TIMEOUT,
} = {}) {
    if (!prompt?.trim()) throw new Error('an image needs a prompt');

    const got = await viaGoogle({ prompt, reference, aspect, timeout })
        || await viaFal({ prompt, aspect, timeout });

    if (!got) throw new Error('no image provider could be reached');
    return got;
}

/**
 * Put generated bytes somewhere with a URL.
 *
 * Google hands back the image itself, not a link, and every caller here needs a
 * link: the schedule cache, the card editor and the dashboard all store one. The
 * static uploads directory is what the rest of the dashboard already uses.
 */
export async function persistImage(buffer, { prefix = 'ai', contentType = 'image/png' } = {}) {
    const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg'
        : contentType.includes('webp') ? 'webp' : 'png';
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);
    const base = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
    return { url: `${base}/uploads/${filename}`, filename };
}

export default { generateImage, persistImage };
