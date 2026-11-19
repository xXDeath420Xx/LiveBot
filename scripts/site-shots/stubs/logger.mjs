/* Stand-in for utils/logger.js during the screenshot run: every call is a no-op (nothing is written to the bot's logs). */
const noop = () => logger;
const logger = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : (k === 'child' ? () => logger : noop)), apply: () => logger });
export function onWarnError() {}
export function requestLoggerMiddleware(req, res, next) { next(); }
export function generateCorrelationId() { return 'site-shots'; }
export function formatBytes(n) { return `${n} B`; }
export function formatDuration(ms) { return `${ms} ms`; }
export function safeStringify(v) { try { return JSON.stringify(v); } catch { return String(v); } }
export { logger };
export default logger;
