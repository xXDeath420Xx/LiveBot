/**
 * Kick Channel Scraper
 * Uses puppeteer-extra with stealth to fetch channel data from Kick's internal API
 * This bypasses Cloudflare protection that blocks regular HTTP requests
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import logger from '../logger.js';
import pool from '../db.js';

// Add stealth plugin to bypass Cloudflare
puppeteer.use(StealthPlugin());

// Cache browser instance for reuse
let browserInstance = null;
let browserLastUsed = null;
const BROWSER_TIMEOUT = 5 * 60 * 1000; // Close browser after 5 minutes of inactivity

/**
 * Get or create a browser instance
 */
async function getBrowser() {
    // Close stale browser
    if (browserInstance && browserLastUsed && Date.now() - browserLastUsed > BROWSER_TIMEOUT) {
        try {
            await browserInstance.close();
        } catch (e) {}
        browserInstance = null;
    }

    if (!browserInstance) {
        browserInstance = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080'
            ]
        });
    }

    browserLastUsed = Date.now();
    return browserInstance;
}

/**
 * Fetch channel data from Kick's internal API
 * @param {string} username - Kick channel username/slug
 * @returns {Promise<Object|null>} Channel data including chatroom info
 */
async function fetchKickChannelData(username) {
    if (!username || typeof username !== 'string') return null;

    const url = `https://kick.com/api/v2/channels/${username.toLowerCase()}`;
    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        // Set realistic viewport and user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Navigate directly to the API endpoint
        const response = await page.goto(url, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        if (!response || response.status() !== 200) {
            logger.warn(`[Kick Scraper] Failed to fetch ${username}: status ${response?.status()}`);
            return null;
        }

        // Get the JSON response
        const content = await page.evaluate(() => document.body.innerText);
        const data = JSON.parse(content);

        logger.info(`[Kick Scraper] Successfully fetched channel data for ${username}`, {
            chatroom_id: data.chatroom?.id,
            channel_id: data.id
        });

        return data;

    } catch (error) {
        logger.error(`[Kick Scraper] Error fetching ${username}:`, { error: error.message });
        return null;
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (e) {}
        }
    }
}

/**
 * Fetch and update chatroom_id for a Kick channel
 * @param {string} username - Kick channel username/slug
 * @returns {Promise<string|null>} Chatroom ID or null
 */
async function fetchAndStoreChatroomId(username) {
    const data = await fetchKickChannelData(username);

    if (!data?.chatroom?.id) {
        logger.warn(`[Kick Scraper] No chatroom_id found for ${username}`);
        return null;
    }

    const chatroomId = data.chatroom.id.toString();

    try {
        // Update database
        const [result] = await pool.execute(
            `UPDATE tokes_channels SET chatroom_id = ? WHERE platform = 'kick' AND LOWER(channel_name) = LOWER(?) AND chatroom_id IS NULL`,
            [chatroomId, username]
        );

        if (result.affectedRows > 0) {
            logger.info(`[Kick Scraper] Updated chatroom_id for ${username}: ${chatroomId}`);
        }

        return chatroomId;

    } catch (error) {
        logger.error(`[Kick Scraper] Failed to update database for ${username}:`, { error: error.message });
        return chatroomId; // Still return the ID even if DB update fails
    }
}

/**
 * Close the browser instance (call on shutdown)
 */
async function closeBrowser() {
    if (browserInstance) {
        try {
            await browserInstance.close();
        } catch (e) {}
        browserInstance = null;
    }
}

export { fetchKickChannelData, fetchAndStoreChatroomId, closeBrowser };
