/*
 * What a Windrose backup is and why it exists, read from what we have: the agent's ledger sidecar
 * (kind/label, newer agents) or else the filename the agent gives every snapshot —
 *   <worldId>_<version>_<YYYYMMDD-HHMMSS>_<kind>[_<label>].zip
 * Pure, for tests/windrose-backup-ledger.test.js.
 */

export const KINDS = Object.freeze(['manual', 'scheduled', 'pre-restore']);

const LABEL_REASONS = Object.freeze({
    preupdate: 'Before a server image update',
    pregameupdate: 'Before a game update',
    preautoupdate: 'Before an automatic update',
    preconfig: 'Before applying staged config',
    preimport: 'Before importing a world',
    prerestore: 'Before a restore',
});

/** { kind, label } from a backup filename; unknown shapes give { kind: null, label: null }. */
export function parseBackupFilename(filename) {
    const m = String(filename || '').match(/_(manual|scheduled|pre-restore)(?:_([A-Za-z0-9-]+))?\.zip$/);
    if (!m) return { kind: null, label: null };
    return { kind: m[1], label: m[2] || null };
}

export function normaliseKind(kind) {
    return KINDS.includes(kind) ? kind : null;
}

/** Human "why" for the panel: the label's meaning if we know it, else what the kind implies. */
export function backupReason({ kind, label }) {
    if (label && LABEL_REASONS[label]) return LABEL_REASONS[label];
    if (kind === 'scheduled') return 'Scheduled restart';
    if (kind === 'pre-restore') return label ? `Before restore (${label})` : 'Before a restore';
    if (label) return label;
    return 'Manual snapshot';
}

export default { KINDS, parseBackupFilename, normaliseKind, backupReason };
