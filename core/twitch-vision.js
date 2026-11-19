/**
 * Gemini Vision analysis over Twitch clip thumbnails. Produces a scene description, mood,
 * and suggested tags from the thumbnail image. Zero audio pipeline needed — Gemini accepts
 * image URLs directly.
 *
 * This is multi-modal clip analysis without the "download video → extract frames → feed
 * frames" complexity. The thumbnail is a representative frame Twitch itself picked.
 */
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG = '[TwitchVision]';
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';

/**
 * Analyze a clip thumbnail with Gemini vision. Caches result in twitch_clip_vision_analyses.
 */
export async function analyzeClipThumbnail(clipId) {
    const [[clip]] = await pool.execute(
        `SELECT clip_id, broadcaster_id, title, thumbnail_url, game_name
           FROM twitch_clips_catalog WHERE clip_id = ?`, [String(clipId)]);
    if (!clip) return { ok: false, error: 'clip not found' };
    if (!clip.thumbnail_url) return { ok: false, error: 'clip has no thumbnail' };

    const [[cached]] = await pool.execute(`SELECT * FROM twitch_clip_vision_analyses WHERE clip_id = ?`, [clip.clip_id]);
    if (cached?.scene_description) return { ok: true, cached: true, ...cached };

    const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
    if (!key) return { ok: false, error: 'GOOGLE_API_KEY not configured' };

    try {
        // Download the thumbnail as a base64 inline image (Gemini accepts either URL or inline data).
        const imgRes = await axios.get(clip.thumbnail_url, { responseType: 'arraybuffer', timeout: 15_000 });
        const imageBase64 = Buffer.from(imgRes.data).toString('base64');
        const mimeType = imgRes.headers['content-type'] || 'image/jpeg';

        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(key);
        const schema = {
            type: 'object',
            properties: {
                scene_description: { type: 'string' },
                detected_mood: { type: 'string' },
                suggested_tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['scene_description'],
        };
        const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
        });

        const prompt = `Analyze this Twitch clip thumbnail. ` +
            `Clip title: "${clip.title || ''}". ` +
            `Game/category: ${clip.game_name || 'unknown'}. ` +
            `Describe the visible scene briefly, estimate the detected mood (hype/calm/intense/funny/sad/competitive), ` +
            `and suggest 3-5 tags for discoverability.`;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageBase64, mimeType } },
        ]);
        const text = result.response.text();
        let parsed = null; try { parsed = JSON.parse(text); } catch {}

        await pool.execute(
            `INSERT INTO twitch_clip_vision_analyses
             (clip_id, broadcaster_id, provider, model, scene_description, detected_mood, suggested_tags_json, thumb_url_analyzed)
             VALUES (?, ?, 'gemini', ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 scene_description = VALUES(scene_description),
                 detected_mood = VALUES(detected_mood),
                 suggested_tags_json = VALUES(suggested_tags_json),
                 analyzed_at = CURRENT_TIMESTAMP`,
            [clip.clip_id, clip.broadcaster_id, GEMINI_MODEL,
             parsed?.scene_description || text.slice(0, 1000),
             parsed?.detected_mood || null,
             parsed?.suggested_tags ? JSON.stringify(parsed.suggested_tags) : null,
             clip.thumbnail_url]);

        return { ok: true, ...parsed, provider: 'gemini', model: GEMINI_MODEL };
    } catch (e) {
        logger.error(`${LOG} vision analysis failed for ${clipId}: ${e.message}`);
        return { ok: false, error: e.message };
    }
}
