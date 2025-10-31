import logger from "../utils/logger";

// Using a frozen object to simulate an Enum for status states
const Status = Object.freeze({
    OFFLINE: "OFFLINE",
    STARTING: "STARTING",
    ONLINE: "ONLINE",
    MAINTENANCE: "MAINTENANCE",
    ERROR: "ERROR",
}) as const;

type StatusType = typeof Status[keyof typeof Status];

// Default messages associated with each status state
const statusMessages: Record<StatusType, string> = {
    [Status.OFFLINE]: "Bot is currently offline.",
    [Status.STARTING]: "Bot is starting up...",
    [Status.ONLINE]: "Bot is online and operational.",
    [Status.MAINTENANCE]: "Bot is currently undergoing maintenance.",
    [Status.ERROR]: "Bot has encountered a critical error."
};

interface CurrentStatus {
    state: StatusType;
    message: string;
}

const currentStatus: CurrentStatus = {
    state: Status.OFFLINE,
    message: statusMessages[Status.OFFLINE]
};

function setStatus(state: StatusType, message?: string): void {
    // Validate the state against the defined Enum
    if (!Object.values(Status).includes(state)) {
        logger.warn(`[Status Update] Attempted to set an invalid status state: ${state}`);
        return;
    }

    currentStatus.state = state;
    // Use the provided message or fall back to the default for the state
    currentStatus.message = message || statusMessages[state];

    logger.info(`[Status Update] State: ${currentStatus.state}, Message: ${currentStatus.message}`);
}

function getStatus(): CurrentStatus {
    return currentStatus;
}

export {
    Status,
    StatusType,
    setStatus,
    getStatus
};
