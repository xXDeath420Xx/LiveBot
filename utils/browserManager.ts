import playwright, { Browser } from 'playwright-core';
import { logger } from './logger';

/**
 * Launches a new, isolated browser instance.
 * This is more stable in a multi-process environment than a single persistent context.
 */
async function getBrowser(): Promise<Browser | null> {
    try {
        const browser = await playwright.chromium.launch({
            headless: true,
            executablePath: process.env.CHROME_EXECUTABLE_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
        });
        return browser;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('[BrowserManager] FATAL: Could not launch browser:', { message: errorMessage });
        return null;
    }
}

/**
 * Gracefully closes a browser instance.
 */
async function closeBrowser(browser: Browser): Promise<void> {
    if (browser && browser.isConnected()) {
        await browser.close();
    }
}

export { getBrowser, closeBrowser };
