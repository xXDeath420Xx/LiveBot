// Greenhouse Tycoon (cfx v2): version hints. When the ledger commits a change for an account, listeners
// (phase 2: the WebSocket hub) receive { accountId, version } and tell that player's clients to refetch
// state. Hints are best-effort: polling GET /api/v2/state?v=<version> always works without them.

export function createHints({ maxListenersPerAccount = 8 } = {}) {
    const listeners = new Map(); // accountId -> Set<fn>

    function subscribe(accountId, fn) {
        let set = listeners.get(accountId);
        if (!set) listeners.set(accountId, (set = new Set()));
        if (set.size >= maxListenersPerAccount) throw new Error('too many listeners for this account');
        set.add(fn);
        return () => {
            set.delete(fn);
            if (!set.size) listeners.delete(accountId);
        };
    }

    function publish(accountId, version) {
        const set = listeners.get(accountId);
        if (!set) return 0;
        for (const fn of set) {
            try { fn({ accountId, version }); } catch { /* one bad listener must not stop the others */ }
        }
        return set.size;
    }

    return { subscribe, publish, size: () => listeners.size };
}
