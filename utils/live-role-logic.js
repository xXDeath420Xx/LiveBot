/*
 * The leftover-live-role sweep's one decision, kept pure so it is unit-tested.
 * See core/live-role-grants.js for why the sweep exists.
 */

/**
 * What to do with one recorded grant of a live role.
 *   forget  they left the server, or no longer hold the role (someone took it off): drop the record
 *   keep    still tracked in this server: the normal check cycle owns the role and will remove it
 *   remove  not tracked in this server any more: the role was left behind, take it back
 */
export function leftoverAction({ inServer, hasRole, tracked }) {
    if (!inServer || !hasRole) return 'forget';
    return tracked ? 'keep' : 'remove';
}

/** Discord errors that mean the grant can never be acted on again, so its record should go. */
export function isGoneError(error) {
    return error?.code === 10007 /* Unknown Member */ || error?.code === 10011 /* Unknown Role */;
}
