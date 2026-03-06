/**
 * CertiFried Extension - Bot Integration Index
 * Re-exports all bot integration modules
 */

// Bridge for direct game manipulation
export * from './bridge.js';
export { default as bridge } from './bridge.js';

// Ready-to-use command handlers
export * from './commands.js';
export { default as commands } from './commands.js';

// Message formatting utilities
export * from './formatters.js';
export { default as formatters } from './formatters.js';

export default {
    bridge: await import('./bridge.js').then(m => m.default),
    commands: await import('./commands.js').then(m => m.default),
    formatters: await import('./formatters.js').then(m => m.default)
};
