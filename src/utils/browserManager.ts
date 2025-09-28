import playwright from "playwright-core";
import {BrowserContext} from "playwright";

let browser: BrowserContext|null = null;

async function getBrowser() {
  if (browser) {
    return browser;
  }
  try {
    console.log("[BrowserManager] Initializing new persistent browser instance...");
    browser = await playwright.chromium.launchPersistentContext("./user-data-dir", {
      headless: true,
      executablePath: process.env.CHROME_EXECUTABLE_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu"
      ],
    });
    browser.on("close", () => {
      console.log("[BrowserManager] Persistent browser instance closed.");
      browser = null; // Reset browser instance on close
    });
    console.log("[BrowserManager] New browser instance launched successfully.");
    return browser;
  } catch (e) {
    console.error("[BrowserManager] FATAL: Could not launch browser:", e);
    return null;
  }
}

async function closeBrowser() {
  // This function is now a no-op because we want to keep the browser persistent.
  // The browser will be closed on application shutdown.
}

async function gracefulShutdown() {
  if (browser) {
    console.log("[BrowserManager] Gracefully shutting down persistent browser...");
    await browser.close();
    browser = null;
  }
}

// Graceful shutdown hook
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

export {getBrowser, closeBrowser};
