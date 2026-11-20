/**
 * Who may decide a global ban appeal, and what the decision reaches (register H-802, 2026-11-20).
 *
 *   global  a CertiFried super-admin (utils/constants.js isSuperAdmin): approve lifts the shared ban for
 *           every server, deny closes the appeal. There is no separate reviewer role.
 *   server  a server's own moderator: approve allows the person in THAT server only, past the global
 *           ban and nothing else (protection_allowlist kind 'globalban', migration 471; lifting that
 *           server's "Global Ban:" ban). The shared ban and the appeal stay open for the CertiFried team.
 *   refuse  a server moderator cannot deny for the network, and outside a server nothing can be decided.
 *
 * Pure: no database, no Discord.
 */
export function appealDecisionScope({ reviewerIsSuperAdmin = false, approved = false, inGuild = false } = {}) {
    if (reviewerIsSuperAdmin) return { scope: 'global' };
    if (!inGuild) return { scope: 'refuse', message: 'Appeals can only be decided in a server, or by the CertiFried team.' };
    if (!approved) {
        return { scope: 'refuse', message: 'Only the CertiFried team can deny an appeal for every server. Nothing was changed: this server keeps acting on the shared ban as before.' };
    }
    return { scope: 'server' };
}

/** One line for replies and buttons: what this decision does. */
export function scopeText(scope, guildName = 'this server') {
    if (scope === 'global') return 'For every server: the shared ban is lifted (approve) or the appeal is closed (deny).';
    if (scope === 'server') return `For ${guildName} only: CertiFried stops acting on the shared ban here and lifts this server's global-ban ban. The shared ban stays for every other server, and the CertiFried team still reviews the appeal.`;
    return '';
}

/** A server's own "Global Ban:" ban (core/global-ban-manager.js executeAction) — the only ban a server approval lifts. */
export function isGlobalBanBanReason(reason) {
    return /^Global Ban:/i.test(String(reason || ''));
}
