"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBrowser = getBrowser;
exports.closeBrowser = closeBrowser;
const playwright_core_1 = __importDefault(require("playwright-core"));
const logger_1 = require("./logger");
/**
 * Launches a new, isolated browser instance.
 * This is more stable in a multi-process environment than a single persistent context.
 */
async function getBrowser() {
    try {
        const browser = await playwright_core_1.default.chromium.launch({
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
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error('[BrowserManager] FATAL: Could not launch browser:', { message: errorMessage });
        return null;
    }
}
/**
 * Gracefully closes a browser instance.
 */
async function closeBrowser(browser) {
    if (browser && browser.isConnected()) {
        await browser.close();
    }
}
