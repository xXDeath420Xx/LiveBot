// The live Watch Together session manager, for the bot's /movie status and stop (the bot and the dashboard are one
// process; dashboard/routes/activities/index.js registers it when the router is built). null until then.
let current = null;
export function setWatchSessions(manager) { current = manager || null; }
export function getWatchSessions() { return current; }
