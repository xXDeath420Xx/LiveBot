// Player listing and moderation.
//
// THE IMPORTANT PART — moderation may be a no-op on this build.
//
// wp.kick / wp.ban / wp.unban / wp.listbans are not handled by Lua. Windrose+
// writes the request to windrose_plus_data/wpn_command.txt and a separate C++
// mod, WindrosePlusNative, picks it up on the game thread. Upstream ships that
// mod DISABLED (as of v1.3.16, still true on our v1.3.17) while it is
// revalidated against the current dedicated-server build.
//
// The failure mode is nasty: RCON cheerfully answers "Kick requested for Bob"
// whether or not anything is listening. Verified here on 2026-08-09 — the
// command file was still sitting there unconsumed four seconds later, and
// WindrosePlusNative.dll is not in Binaries/Win64.
//
// So this module DETECTS whether the native mod is consuming requests and
// reports that honestly. A panel that shows a green "banned!" toast while the
// griefer keeps playing is worse than a panel with the button greyed out.

import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export class PlayerError extends Error {}

const COMMAND_FILE = 'wpn_command.txt';
const BANS_FILE = 'wpn_bans.txt';

export function createPlayers({
    serverFiles = config.serverFiles,
    rcon,           // async (command) => { message } — already queued upstream
    spool,
    now = () => Date.now(),
} = {}) {
    const dataDir = path.join(serverFiles, 'windrose_plus_data');
    const commandPath = path.join(dataDir, COMMAND_FILE);
    const bansPath = path.join(dataDir, BANS_FILE);

    /**
     * Is the native moderation mod actually running?
     *
     * A stale command file means nothing consumed the last request. Give it a
     * grace period — the mod polls roughly once a second — before calling it
     * dead, so a check racing a fresh request does not report a false negative.
     */
    async function moderationAvailable({ staleAfterMs = 5000 } = {}) {
        // Proactive check first. Waiting for a request to go unconsumed means
        // the panel advertises moderation as working until someone tries to ban
        // a griefer and quietly fails — the worst possible moment to find out.
        //
        // UE4SS loads C++ mods from ue4ss/Mods/<Name>/dlls/main.dll, gated by a
        // sibling enabled.txt and a line in Mods/mods.txt. WindrosePlusNative
        // ships staged in cpp-mods/ but NOT installed there, which is upstream's
        // "disabled pending revalidation" state.
        //
        // Checking Binaries/Win64 (an earlier guess) was wrong — that is where
        // the game's own DLLs live, not where UE4SS looks.
        const modDll = path.join(serverFiles, 'R5', 'Binaries', 'Win64', 'ue4ss', 'Mods', 'WindrosePlusNative', 'dlls', 'main.dll');
        const enabledFlag = path.join(serverFiles, 'R5', 'Binaries', 'Win64', 'ue4ss', 'Mods', 'WindrosePlusNative', 'enabled.txt');

        const [hasDll, hasFlag] = await Promise.all([
            stat(modDll).then(() => true).catch(() => false),
            stat(enabledFlag).then(() => true).catch(() => false),
        ]);

        if (!hasDll || !hasFlag) {
            return {
                available: false,
                confidence: 'confirmed',
                reason: 'WindrosePlusNative is not installed into UE4SS Mods, so kick/ban/unban are queued but never '
                    + 'executed. Upstream ships it disabled pending revalidation against the current dedicated-server build.',
                installedDll: hasDll,
                enabledFlag: hasFlag,
                dllStaged: await stat(path.join(serverFiles, 'cpp-mods', 'WindrosePlusNative', 'WindrosePlusNative.dll'))
                    .then(() => true).catch(() => false),
            };
        }

        let leftover = null;
        try {
            const s = await stat(commandPath);
            leftover = { ageMs: now() - s.mtimeMs, content: (await readFile(commandPath, 'utf8')).trim() };
        } catch {
            // No pending file: either nothing was ever requested, or the mod
            // consumed it. Both are consistent with a working mod.
            return { available: true, reason: 'no pending request', confidence: 'unproven' };
        }

        if (leftover.ageMs > staleAfterMs) {
            return {
                available: false,
                confidence: 'confirmed',
                reason: 'WindrosePlusNative is not loaded — kick/ban requests are queued but never executed. '
                    + 'Upstream ships it disabled pending revalidation against the current dedicated-server build.',
                pending: leftover.content,
                ageMs: leftover.ageMs,
            };
        }
        return { available: true, reason: 'request in flight', confidence: 'unproven' };
    }

    /**
     * Parse `wp.players` output.
     *
     * Format: "  1. BP_R5Character_C_2147418445 (HumanGenome) [player:12] @ x, y, z"
     * The actor id is what wp.tp and friends take; the player: token is only
     * session-stable and the display name is not unique, so both are surfaced.
     */
    function parsePlayers(message) {
        if (!message) return [];
        return message.split('\n').reduce((acc, line) => {
            const m = line.match(/^\s*\d+\.\s+(\S+)(?:\s+\(([^)]*)\))?(?:\s+\[player:(\d+)\])?(?:\s+@\s*(.+))?/);
            if (!m) return acc;
            const [, actorId, name, playerId, pos] = m;
            acc.push({
                actorId,
                name: name || null,
                playerId: playerId ? Number(playerId) : null,
                position: pos ? pos.trim() : null,
            });
            return acc;
        }, []);
    }

    return {
        moderationAvailable,
        parsePlayers,

        /**
         * Online players. Prefers the spool (free) and only spends RCON when
         * positions are explicitly wanted — see spec §2a on the ~4s cost.
         */
        async list({ withPositions = false } = {}) {
            if (!withPositions) {
                const status = await spool.serverStatus();
                return {
                    source: 'spool',
                    count: status?.server?.player_count ?? 0,
                    players: status?.players ?? [],
                };
            }
            const out = await rcon('wp.players');
            return { source: 'rcon', players: parsePlayers(out?.message), raw: out?.message ?? '' };
        },

        async bans() {
            // Read the file directly rather than spending RCON on wp.listbans.
            try {
                const raw = await readFile(bansPath, 'utf8');
                return raw.split('\n').map((l) => l.trim()).filter(Boolean);
            } catch {
                return [];
            }
        },

        /**
         * Kick / ban / unban.
         *
         * Always reports whether the request will actually be executed, rather
         * than passing RCON's unconditional "requested" message through as if
         * it were a result.
         */
        async moderate(action, target, reason = '') {
            if (!['kick', 'ban', 'unban'].includes(action)) throw new PlayerError(`unknown action ${action}`);
            if (!target || /[\r\n\t]/.test(target)) throw new PlayerError('invalid player name');

            const before = await moderationAvailable();
            const command = `wp.${action} ${target}${reason ? ` ${reason}` : ''}`;
            const out = await rcon(command);

            // Re-check after a beat: if our own request is still sitting in the
            // file, nothing consumed it.
            await new Promise((r) => setTimeout(r, 2500));
            const after = await moderationAvailable({ staleAfterMs: 2000 });

            return {
                action,
                target,
                message: out?.message ?? '',
                executed: after.available,
                warning: after.available ? null
                    : 'Request queued but NOT executed: the native moderation mod is not loaded on this build. '
                      + 'The player is unaffected.',
                nativeStatusBefore: before.available,
            };
        },

        /** Clear a stuck request so the next availability check is meaningful. */
        async clearPending() {
            await unlink(commandPath).catch(() => {});
            return { cleared: true };
        },

        _paths: { commandPath, bansPath },
    };
}
