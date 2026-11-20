/*
 * Keep the Activity's Entry Point command through a bulk command deploy (docs/activities.md).
 *
 * When Activities are switched on for an application, Discord creates a global "Launch" command of type
 * PRIMARY_ENTRY_POINT (4); it is what the App Launcher (the rocket in a voice channel) uses. A bulk overwrite
 * (PUT /applications/{id}/commands) that leaves it out is refused by Discord (error 50240: an Entry Point command
 * cannot be removed in a bulk update), and none of our command files describe it. So every global PUT goes through
 * withEntryPoint(): it reads the application's current global commands and, when there is an Entry Point command and
 * the payload has none, appends it unchanged (same id, so it is kept rather than recreated).
 * Without Activities there is no such command and the payload goes out as it was. A failed read sends the payload
 * unchanged too (the deploy then fails or succeeds exactly as before this existed).
 */
import { Routes } from 'discord.js';

export const PRIMARY_ENTRY_POINT = 4;

/** The payload plus the existing Entry Point command, as Discord expects it in a bulk overwrite. */
export function mergeEntryPoint(body, existing) {
    const list = Array.isArray(body) ? body : [];
    if (list.some((c) => c && c.type === PRIMARY_ENTRY_POINT)) return list;
    const ep = (Array.isArray(existing) ? existing : []).find((c) => c && c.type === PRIMARY_ENTRY_POINT);
    if (!ep) return list;
    const keep = { id: ep.id, type: PRIMARY_ENTRY_POINT, name: ep.name, description: ep.description ?? '', handler: ep.handler ?? 2 };
    for (const k of ['name_localizations', 'description_localizations', 'integration_types', 'contexts', 'default_member_permissions', 'nsfw']) {
        if (ep[k] !== undefined && ep[k] !== null) keep[k] = ep[k];
    }
    return [...list, keep];
}

/** rest: a discord.js REST with the application's bot token. */
export async function withEntryPoint(rest, applicationId, body) {
    if (!applicationId) return body;
    try {
        const existing = await rest.get(Routes.applicationCommands(applicationId));
        return mergeEntryPoint(body, existing);
    } catch {
        return body;
    }
}
