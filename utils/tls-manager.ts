import initCycleTLS from 'cycletls';
import { logger } from './logger';

type CycleTLSInstance = any; // CycleTLS doesn't have TypeScript types

let globalCycleTLSInstance: CycleTLSInstance | null = null;
let cycleTLSInitializationPromise: Promise<CycleTLSInstance> | null = null;

// This module centralizes the creation and management of the global cycleTLS instance
// to prevent circular dependencies and ensure a single, shared instance.

async function getCycleTLSInstance(): Promise<CycleTLSInstance> {
    if (globalCycleTLSInstance) {
        return globalCycleTLSInstance;
    }
    if (cycleTLSInitializationPromise) {
        return cycleTLSInitializationPromise;
    }

    logger.info('[CycleTLS] Initializing global CycleTLS instance...');
    cycleTLSInitializationPromise = initCycleTLS({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.60 Safari/537.36',
        timeout: 60000
    } as any).then((instance: CycleTLSInstance) => {
        globalCycleTLSInstance = instance;
        cycleTLSInitializationPromise = null;
        logger.info('[CycleTLS] Global CycleTLS instance initialized.');
        return instance;
    }).catch((error: Error) => {
        cycleTLSInitializationPromise = null;
        logger.error('[CycleTLS] Error initializing global CycleTLS instance:', error as Record<string, any>);
        throw error;
    });

    return cycleTLSInitializationPromise;
}

async function exitCycleTLSInstance(): Promise<void> {
    if (globalCycleTLSInstance) {
        logger.info('[CycleTLS] Exiting global CycleTLS instance...');
        try {
            await globalCycleTLSInstance.exit();
            globalCycleTLSInstance = null;
            logger.info('[CycleTLS] Global CycleTLS instance exited.');
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('[CycleTLS] Error exiting global CycleTLS instance:', { message: errorMessage });
        }
    }
}

export { getCycleTLSInstance, exitCycleTLSInstance };
