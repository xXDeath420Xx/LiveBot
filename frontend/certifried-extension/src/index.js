/**
 * CertiFried Extension - Main Entry Point
 * Exports all public modules
 */

// State management
export { store } from './state/store.js';

// API clients
export { api } from './api/client.js';
export { ws } from './api/websocket.js';

// App bootstrap
export { app } from './app.js';

// Components (auto-registers all)
export * from './components/index.js';

// Utilities
export * from './utils/format.js';
export * from './utils/dom.js';

console.log('[CFX] CertiFried Extension loaded');
