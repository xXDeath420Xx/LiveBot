"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Status = void 0;
exports.setStatus = setStatus;
exports.getStatus = getStatus;
var logger_1 = require("../utils/logger");
// Using a frozen object to simulate an Enum for status states
var Status = Object.freeze({
    OFFLINE: "OFFLINE",
    STARTING: "STARTING",
    ONLINE: "ONLINE",
    MAINTENANCE: "MAINTENANCE",
    ERROR: "ERROR",
});
exports.Status = Status;
// Default messages associated with each status state
var statusMessages = (_a = {},
    _a[Status.OFFLINE] = "Bot is currently offline.",
    _a[Status.STARTING] = "Bot is starting up...",
    _a[Status.ONLINE] = "Bot is online and operational.",
    _a[Status.MAINTENANCE] = "Bot is currently undergoing maintenance.",
    _a[Status.ERROR] = "Bot has encountered a critical error.",
    _a);
var currentStatus = {
    state: Status.OFFLINE,
    message: statusMessages[Status.OFFLINE]
};
function setStatus(state, message) {
    // Validate the state against the defined Enum
    if (!Object.values(Status).includes(state)) {
        logger_1.default.warn("[Status Update] Attempted to set an invalid status state: ".concat(state));
        return;
    }
    currentStatus.state = state;
    // Use the provided message or fall back to the default for the state
    currentStatus.message = message || statusMessages[state];
    logger_1.default.info("[Status Update] State: ".concat(currentStatus.state, ", Message: ").concat(currentStatus.message));
}
function getStatus() {
    return currentStatus;
}
