/**
 * Welcome card backgrounds sent with `/manage welcome set-welcome background:` (register H-665).
 *
 * The command used to store the Discord attachment link, which stops working once Discord expires
 * it (about a day), so the card quietly went back to plain black. The image is now saved where the
 * dashboard saves its uploads (dashboard/public/uploads, served at /uploads/) and its link is stored
 * in welcome_settings.card_background_url, the column the card reads, with the dashboard's rules:
 * PNG or JPG, up to 5 MB.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WELCOME_BG_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dashboard/public/uploads');

const TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg' };

/**
 * Check an attachment against the dashboard's upload rules.
 * @returns {{ ok: true, ext: string } | { ok: false, error: string }}
 */
export function checkBackground({ contentType, name, size }) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const fromName = String(name || '').toLowerCase().match(/\.(png|jpe?g)$/)?.[1];
    const ext = TYPES[type] || (fromName ? (fromName === 'png' ? '.png' : '.jpg') : null);
    if (!ext || (type && !TYPES[type])) return { ok: false, error: 'The background must be a PNG or JPG image.' };
    if (Number(size) > WELCOME_BG_MAX_BYTES) return { ok: false, error: 'The background can be at most 5 MB.' };
    return { ok: true, ext };
}

/** The public link for a stored upload. */
export function uploadUrl(filename, base = process.env.DASHBOARD_URL || 'https://certifriedmultitool.com') {
    return `${String(base).replace(/\/$/, '')}/uploads/${filename}`;
}

/**
 * Download the attachment and save it as an upload. Returns the link to store.
 * @param {string} guildId
 * @param {{ url: string, contentType?: string, name?: string, size?: number }} attachment
 */
export async function storeWelcomeBackground(guildId, attachment, { dir = UPLOAD_DIR, fetchImpl = fetch } = {}) {
    const check = checkBackground(attachment);
    if (!check.ok) throw new Error(check.error);
    const res = await fetchImpl(attachment.url);
    if (!res.ok) throw new Error(`Could not download the image (HTTP ${res.status}).`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > WELCOME_BG_MAX_BYTES) throw new Error('The background can be at most 5 MB.');
    const filename = `welcome_${guildId}_${Date.now()}${check.ext}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buffer);
    return { filename, url: uploadUrl(filename) };
}
