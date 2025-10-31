"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCycleTLSInstance = getCycleTLSInstance;
exports.exitCycleTLSInstance = exitCycleTLSInstance;
const cycletls_1 = __importDefault(require("cycletls"));
const logger_1 = require("./logger");
let globalCycleTLSInstance = null;
let cycleTLSInitializationPromise = null;
// This module centralizes the creation and management of the global cycleTLS instance
// to prevent circular dependencies and ensure a single, shared instance.
async function getCycleTLSInstance() {
    if (globalCycleTLSInstance) {
        return globalCycleTLSInstance;
    }
    if (cycleTLSInitializationPromise) {
        return cycleTLSInitializationPromise;
    }
    logger_1.logger.info('[CycleTLS] Initializing global CycleTLS instance...');
    cycleTLSInitializationPromise = (0, cycletls_1.default)({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.60 Safari/537.36',
        timeout: 60000
    }).then((instance) => {
        globalCycleTLSInstance = instance;
        cycleTLSInitializationPromise = null;
        logger_1.logger.info('[CycleTLS] Global CycleTLS instance initialized.');
        return instance;
    }).catch((error) => {
        cycleTLSInitializationPromise = null;
        logger_1.logger.error('[CycleTLS] Error initializing global CycleTLS instance:', error);
        throw error;
    });
    return cycleTLSInitializationPromise;
}
async function exitCycleTLSInstance() {
    if (globalCycleTLSInstance) {
        logger_1.logger.info('[CycleTLS] Exiting global CycleTLS instance...');
        try {
            await globalCycleTLSInstance.exit();
            globalCycleTLSInstance = null;
            logger_1.logger.info('[CycleTLS] Global CycleTLS instance exited.');
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger_1.logger.error('[CycleTLS] Error exiting global CycleTLS instance:', { message: errorMessage });
        }
    }
}
