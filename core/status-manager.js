const logger = require("../utils/logger");

// Using a frozen object to simulate an Enum for status states
const Status = Object.freeze({
  OFFLINE: "OFFLINE",
  STARTING: "STARTING",
  ONLINE: "ONLINE",
  MAINTENANCE: "MAINTENANCE",
  ERROR: "ERROR",
});

// Default messages associated with each status state
const statusMessages = {
  [Status.OFFLINE]: "Bot is currently offline.",
  [Status.STARTING]: "Bot is starting up...",
  [Status.ONLINE]: "Bot is online and operational.",
  [Status.MAINTENANCE]: "Bot is currently undergoing maintenance.",
  [Status.ERROR]: "Bot has encountered a critical error."
};

const currentStatus = {
  state: Status.OFFLINE,
  message: statusMessages[Status.OFFLINE]
};

function setStatus(state, message) {
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

function getStatus() {
  return currentStatus;
}

module.exports = {
  Status,
  setStatus,
  getStatus
};