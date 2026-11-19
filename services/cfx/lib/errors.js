// Greenhouse Tycoon (cfx v2): one error type and one HTTP error shape, {error: {code, message, details?}}.
import { errorMessage } from '../config/copy.js';

export const STATUS_BY_CODE = Object.freeze({
    VALIDATION: 400,
    BAD_JSON: 400,
    IDEMPOTENCY_KEY_REQUIRED: 400,
    UNAUTHORIZED: 401,
    SESSION_STALE: 401,
    FORBIDDEN: 403,
    ACCOUNT_INACTIVE: 403,
    PLATFORM_NOT_ALLOWED: 403,
    NOT_FOUND: 404,
    PAYLOAD_TOO_LARGE: 413,
    IDEMPOTENCY_MISMATCH: 409,
    INSUFFICIENT_FUNDS: 409,
    INSUFFICIENT_ITEMS: 409,
    BALANCE_LIMIT: 409,
    ITEM_LIMIT: 409,
    LINK_CODE_INVALID: 400,
    LINK_CODE_LIMIT: 409,
    LINK_COOLDOWN: 409,
    PLATFORM_ALREADY_LINKED: 409,
    SOURCE_HAS_PROGRESS: 409,
    CANNOT_UNLINK_CURRENT: 409,
    IDENTITY_NOT_ON_ACCOUNT: 404,
    LINK_TOO_MANY_ATTEMPTS: 429,
    RATE_LIMITED: 429,
    CORS_ORIGIN: 403,
    SIGNIN_UNAVAILABLE: 503,
    SIGNIN_FAILED: 400,
    TWITCH_SIGNED_OUT: 403,
    TICKET_INVALID: 400,
    REFRESH_RACE: 409,
    PLOT_LOCKED: 409,
    PLOT_OCCUPIED: 409,
    PLOT_EMPTY: 409,
    PLOT_CHANGED: 409,
    PLOT_NOT_GROWING: 409,
    NOT_READY: 409,
    NOTHING_READY: 409,
    ALREADY_WATERED: 409,
    WATER_TOO_EARLY: 409,
    BREEDING_PARENTS: 400,
    BOOST_ALREADY_USED: 409,
    UNKNOWN_VARIETY: 404,
    VARIETY_LOCKED: 403,
    LEVEL_TOO_LOW: 403,
    MAX_LEVEL: 409,
    LEVEL_MISMATCH: 409,
    REQUIREMENT_MISSING: 409,
    STAFF_FULL: 409,
    STAFF_NONE: 409,
    COUNT_MISMATCH: 409,
    BREEDING_BUSY: 409,
    BREEDING_NOT_READY: 409,
    BREEDING_NOT_ACTIVE: 409,
    NOT_DISCOVERED: 403,
    ORDER_NOT_OPEN: 409,
    ORDER_EXPIRED: 409,
    DAILY_ALREADY_CLAIMED: 409,
    NAME_NOT_ALLOWED: 400,
    NAME_COOLDOWN: 409,
    QUEST_NOT_DONE: 409,
    ALREADY_CLAIMED: 409,
    ACHIEVEMENT_LOCKED: 409,
    REPLANT_LOCKED: 403,
    PRESTIGE_MISMATCH: 409,
    DECORATION_OWNED: 409,
    DECORATION_NOT_OWNED: 409,
    DECORATION_NOT_SOLD: 403,
    DECORATION_LIMIT: 409,
    REVIEW_ACCOUNT: 403,
    DELETE_CONFIRM_REQUIRED: 400,
    REVIEW_UNAVAILABLE: 403,
    SERVICE_DISABLED: 503,
    INTERNAL: 500
});

export class GameError extends Error {
    constructor(code, message, details) {
        super(message || errorMessage(code));
        this.name = 'GameError';
        this.code = code;
        this.status = STATUS_BY_CODE[code] || 500;
        if (details !== undefined) this.details = details;
    }

    toJSON() {
        const error = { code: this.code, message: this.message };
        if (this.details !== undefined) error.details = this.details;
        return { error };
    }
}

export function gameError(code, details, message) {
    return new GameError(code, message, details);
}

export function isGameError(err) {
    return err instanceof GameError;
}
