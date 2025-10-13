const initCycleTLS = require('cycletls');
const logger = require('./logger');

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

    logger.info('[CycleTLS] Initializing global CycleTLS instance...');
    cycleTLSInitializationPromise = initCycleTLS({
        ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.60 Safari/537.36',
        timeout: 60000
    }).then(instance => {
        globalCycleTLSInstance = instance;
        cycleTLSInitializationPromise = null;
        logger.info('[CycleTLS] Global CycleTLS instance initialized.');
        return instance;
    }).catch(error => {
        cycleTLSInitializationPromise = null;
        logger.error('[CycleTLS] Error initializing global CycleTLS instance:', error);
        throw error;
    });

    return cycleTLSInitializationPromise;
}

async function exitCycleTLSInstance() {
    if (globalCycleTLSInstance) {
        logger.info('[CycleTLS] Exiting global CycleTLS instance...');
        try {
            await globalCycleTLSInstance.exit();
            globalCycleTLSInstance = null;
            logger.info('[CycleTLS] Global CycleTLS instance exited.');
        } catch (e) {
            logger.error('[CycleTLS] Error exiting global CycleTLS instance:', e);
        }
    }
}

module.exports = { getCycleTLSInstance, exitCycleTLSInstance };