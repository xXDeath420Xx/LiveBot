const logger = require("../utils/logger");

const status = {
  state: "OFFLINE", // Can be: OFFLINE, STARTING, ONLINE, MAINTENANCE, ERROR
  message: "Bot is currently offline."
};

function setStatus(state, message) {
  status.state = state;
  status.message = message;
  logger.info(`[Status Update] State: ${state}, Message: ${message}`);
}

function getStatus() {
  return status;
}

module.exports = {
  setStatus,
  getStatus
};