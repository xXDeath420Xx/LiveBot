/**
 * The anti-nuke action a stored anti_nuke_config.action_on_trigger means.
 *
 * /protection antinuke config offers kick, ban, strip (remove roles) and alert, and core/anti-nuke-manager.js
 * acts on exactly those. Rows written by older setup scripts hold 'strip_roles', 'remove_roles' or
 * 'strip_permissions' (8 servers on 2026-11-19); the manager matched none of them, so in those servers a
 * detected nuke was alerted and nothing else happened. They are the role strip under other names.
 * Anything else unknown reads as 'alert', which is what it already did.
 */
export const NUKE_ACTIONS = Object.freeze(['kick', 'ban', 'strip', 'alert']);

const ALIASES = Object.freeze({ strip_roles: 'strip', remove_roles: 'strip', strip_permissions: 'strip' });

export function normaliseNukeAction(value) {
    const v = String(value ?? '').trim().toLowerCase();
    if (NUKE_ACTIONS.includes(v)) return v;
    return ALIASES[v] || 'alert';
}

export default { NUKE_ACTIONS, normaliseNukeAction };
