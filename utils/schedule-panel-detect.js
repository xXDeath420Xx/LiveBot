/*
 * Panel detector for stream-schedule posters.
 *
 * Many stream owners upload a FULLY designed schedule poster — their own
 * artwork, fonts and lettering — and expect the bot to leave the artwork alone
 * and just write THIS WEEK'S schedule into the panels they drew. The renderer
 * cannot know where those panels are from pixels alone (the shapes vary
 * wildly), so we ask Gemini Vision to find them once per unique uploaded image
 * and cache the result.
 *
 * The response is a strict JSON shape so the renderer can trust it without a
 * second pass of validation. Keys and types match drawExact() in schedule-art.
 */
import logger from './logger.js';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — image URL is cache key

const KEYS = () => [
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_AI_KEY,
    process.env.GOOGLE_AI_KEY_2,
].filter(Boolean);

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];

const PROMPT = `You are analysing a stream-schedule poster that a Twitch streamer uploaded as a template. Our Discord bot needs to overlay THIS WEEK'S schedule text into the existing panels the owner has already designed, so return the pixel-exact coordinates of each writable region.

Return STRICT JSON only, no prose, matching this shape:
{
  "width": <image width in pixels>,
  "height": <image height in pixels>,
  "title": { "x": N, "y": N, "w": N, "h": N } | null,
  "subtitle": { "x": N, "y": N, "w": N, "h": N } | null,
  "panels": [
    { "day": "Monday",    "x": N, "y": N, "w": N, "h": N, "hue": "warm"|"cool"|"mixed" },
    { "day": "Tuesday",   "x": N, "y": N, "w": N, "h": N, "hue": "warm"|"cool"|"mixed" },
    ...one per day found, in weekday order, up to 7...
  ],
  "footer": { "x": N, "y": N, "w": N, "h": N } | null
}

Rules:
- Coordinates are top-left-origin pixels within the image, not percentages.
- Each panel's x/y/w/h must enclose ONLY the writable text region inside that panel — never the character-art portion of the panel, never the panel's own decorative border. If the panel has artwork on one side (e.g. a castle on the right), the writable region is the empty area on the other side.
- "hue" describes the panel's dominant background colour family: "warm" (orange/red/fire), "cool" (blue/ice/night), "mixed" (both).
- If the poster has a main title ("FROSTFIRE Stream Schedule", "May 2026", etc), put its bounding box in "title".
- "subtitle" is the second line of header text if one exists.
- "footer" is any bottom-of-poster signature/handle region.
- If the poster has NO panels at all, return "panels": [].
- Do not invent panels that are not there; a 5-day poster should return 5 panels, not 7.`;

/** Call Gemini Vision with the image bytes and get structured panel data. */
export async function detectPanels(imageBuffer, { contentType = 'image/png' } = {}) {
    const keys = KEYS();
    if (!keys.length) throw new Error('no Google API key available for panel detection');

    const body = JSON.stringify({
        contents: [{
            parts: [
                { inlineData: { mimeType: contentType, data: imageBuffer.toString('base64') } },
                { text: PROMPT },
            ],
        }],
        generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
        },
    });

    let lastErr = '';
    for (const key of keys) {
        for (const model of MODELS) {
            try {
                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body,
                        signal: AbortSignal.timeout(60_000),
                    });
                if (res.status === 429 || res.status === 403) {
                    lastErr = `${model}: HTTP ${res.status}`;
                    break; // this key is out — try next key
                }
                if (!res.ok) {
                    lastErr = `${model}: HTTP ${res.status}`;
                    continue;
                }
                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) { lastErr = `${model}: no text`; continue; }
                const parsed = parseResponse(text);
                if (!parsed) { lastErr = `${model}: unparseable JSON`; continue; }
                parsed._provider = `${model}`;
                return parsed;
            } catch (e) {
                lastErr = `${model}: ${e.message}`;
            }
        }
    }
    throw new Error(`panel detection failed (${lastErr || 'unknown'})`);
}

function parseResponse(text) {
    try {
        // Gemini usually honours responseMimeType, but strip a code fence if any.
        const clean = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
        const obj = JSON.parse(clean);
        if (!obj || typeof obj !== 'object') return null;
        if (!Array.isArray(obj.panels)) obj.panels = [];
        return obj;
    } catch { return null; }
}

/**
 * Cached entry point. The cache is a plain JSON column on the sync config,
 * `panel_regions_json`, keyed by `{sourceUrl, regions}`. A fresh URL means a
 * new detection; same URL skips the call entirely.
 */
export async function getCachedPanels(cfg, imageUrl, imageBuffer, pool) {
    try {
        if (cfg.panel_regions_json) {
            const cached = JSON.parse(cfg.panel_regions_json);
            if (cached?.sourceUrl === imageUrl
                && cached?.regions
                && Date.now() - (cached.detectedAt || 0) < CACHE_TTL_MS) {
                return cached.regions;
            }
        }
    } catch { /* fall through to a fresh detection */ }

    try {
        const regions = await detectPanels(imageBuffer);
        const envelope = { sourceUrl: imageUrl, detectedAt: Date.now(), regions };
        await pool.execute(
            'UPDATE twitch_schedule_sync_config SET panel_regions_json = ? WHERE id = ?',
            [JSON.stringify(envelope), cfg.id]
        ).catch(() => { /* missing column is a soft fail — detection still returns */ });
        logger.info(`[PanelDetect] cached ${regions.panels?.length || 0} panels for config ${cfg.id} via ${regions._provider}`,
            { category: 'twitch' });
        return regions;
    } catch (e) {
        logger.warn(`[PanelDetect] detection failed, falling back to automatic stacking: ${e.message}`,
            { category: 'twitch' });
        return null;
    }
}

export default { detectPanels, getCachedPanels };
