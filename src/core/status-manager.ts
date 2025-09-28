import {logger} from "../utils/logger";

const status = {
    state: "OFFLINE", // Can be: OFFLINE, STARTING, ONLINE, MAINTENANCE, ERROR
    message: "Bot is currently offline."
};

function setStatus(state: string, message: string) {
    status.state = state;
    status.message = message;
    logger.info(`[Status Update] State: ${state}, Message: ${message}`);
}

function getStatus() {
    return status;
}

export {setStatus, getStatus};
