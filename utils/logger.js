// Primitive, dependency-free logger to guarantee output in any environment.
const logger = {
  info: (message, ...args) => console.log(`[INFO] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[WARN] ${message}`, ...args),
  error: (message, ...args) => {
    // Ensure the primary message is always a string.
    console.error(`[ERROR] ${String(message)}`, ...args);
    // If an error object is passed, its stack will be logged by console.error.
  },
  debug: (message, ...args) => console.log(`[DEBUG] ${message}`, ...args),
};

module.exports = logger;