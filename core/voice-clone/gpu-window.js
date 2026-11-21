/*
 * When the training PC may be given work (owner decision 2026-11-20): 02:00 to 14:00 Pacific, at most 4 GPU-hours per
 * Pacific day, never while the owner is live. The PC worker checks the same rules itself (worker/voice-worker.ps1) and
 * also refuses on games, GPU or Ollama load and missing owner-only scratch folders; the server check is the second lock.
 *
 *   pacificParts(date) → { day: 'YYYY-MM-DD', hour, minute }
 *   inWindow(date, w) → bool
 *   leaseRefusal({ now, ownerLive, gpuSecondsToday, window }) → null | 'owner_live' | 'outside_window' | 'daily_cap'
 * Pure; tested in tests/voice-clone.test.js.
 */
import { GPU_WINDOW } from './constants.js';

export function pacificParts(date = new Date(), tz = GPU_WINDOW.tz) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

export function inWindow(date = new Date(), w = GPU_WINDOW) {
    const { hour } = pacificParts(date, w.tz);
    return hour >= w.startHour && hour < w.endHour;
}

export function leaseRefusal({ now = new Date(), ownerLive = true, gpuSecondsToday = 0, window = GPU_WINDOW } = {}) {
    if (ownerLive !== false) return 'owner_live';         // unknown counts as live
    if (!inWindow(now, window)) return 'outside_window';
    if (Number(gpuSecondsToday) >= window.maxSecondsPerDay) return 'daily_cap';
    return null;
}

export default { pacificParts, inWindow, leaseRefusal };
