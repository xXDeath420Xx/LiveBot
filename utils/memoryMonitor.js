import logger from './logger.js';

/**
 * Memory Monitor - Tracks memory usage and alerts on high memory
 * Helps identify memory leaks and track resource usage
 */
class MemoryMonitor {
    constructor(options = {}) {
        this.intervalMs = options.intervalMs || 60000; // Check every minute
        this.warningThresholdMB = options.warningThresholdMB || 500;
        this.criticalThresholdMB = options.criticalThresholdMB || 800;
        this.interval = null;
        this.history = [];
        this.maxHistory = options.maxHistory || 60; // Keep 1 hour of history
        this.mapWatchers = new Map(); // Track Map sizes
    }

    /**
     * Start memory monitoring
     */
    start() {
        if (this.interval) {
            logger.warn('[MemoryMonitor] Already running');
            return;
        }

        logger.info('[MemoryMonitor] Started', {
            intervalMs: this.intervalMs,
            warningThresholdMB: this.warningThresholdMB,
            criticalThresholdMB: this.criticalThresholdMB
        });

        // Initial check
        this.check();

        // Schedule regular checks
        this.interval = setInterval(() => this.check(), this.intervalMs);
    }

    /**
     * Stop memory monitoring
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            logger.info('[MemoryMonitor] Stopped');
        }
    }

    /**
     * Register a Map to watch for size growth
     */
    watchMap(name, mapRef) {
        this.mapWatchers.set(name, mapRef);
    }

    /**
     * Perform a memory check
     */
    check() {
        const usage = process.memoryUsage();
        const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
        const rssMB = Math.round(usage.rss / 1024 / 1024);
        const externalMB = Math.round(usage.external / 1024 / 1024);

        // Track history
        this.history.push({
            timestamp: Date.now(),
            heapUsedMB,
            heapTotalMB,
            rssMB
        });

        // Trim history
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        // Collect Map sizes
        const mapSizes = {};
        for (const [name, mapRef] of this.mapWatchers.entries()) {
            if (mapRef && typeof mapRef.size === 'number') {
                mapSizes[name] = mapRef.size;
            }
        }

        // Log at appropriate level based on memory usage
        const logData = {
            heapUsedMB,
            heapTotalMB,
            rssMB,
            externalMB,
            heapPercentage: Math.round((heapUsedMB / heapTotalMB) * 100),
            mapSizes: Object.keys(mapSizes).length > 0 ? mapSizes : undefined
        };

        if (heapUsedMB >= this.criticalThresholdMB) {
            logger.error('[MemoryMonitor] CRITICAL: Memory usage very high!', logData);
        } else if (heapUsedMB >= this.warningThresholdMB) {
            logger.warn('[MemoryMonitor] Warning: Memory usage elevated', logData);
        } else {
            logger.debug('[MemoryMonitor] Memory check', logData);
        }

        // Check for memory growth trend
        if (this.history.length >= 10) {
            const first = this.history[0].heapUsedMB;
            const last = heapUsedMB;
            const growth = last - first;
            const growthPercent = Math.round((growth / first) * 100);

            if (growthPercent > 50) {
                logger.warn('[MemoryMonitor] Significant memory growth detected', {
                    firstMB: first,
                    lastMB: last,
                    growthMB: growth,
                    growthPercent,
                    periodMinutes: Math.round((this.history.length * this.intervalMs) / 60000)
                });
            }
        }

        return logData;
    }

    /**
     * Get current stats
     */
    getStats() {
        const usage = process.memoryUsage();
        const mapSizes = {};

        for (const [name, mapRef] of this.mapWatchers.entries()) {
            if (mapRef && typeof mapRef.size === 'number') {
                mapSizes[name] = mapRef.size;
            }
        }

        return {
            heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
            rssMB: Math.round(usage.rss / 1024 / 1024),
            externalMB: Math.round(usage.external / 1024 / 1024),
            heapPercentage: Math.round((usage.heapUsed / usage.heapTotal) * 100),
            history: this.history,
            mapSizes,
            uptimeHours: Math.round(process.uptime() / 3600 * 100) / 100
        };
    }

    /**
     * Force garbage collection (only works if --expose-gc flag is used)
     */
    forceGC() {
        if (global.gc) {
            const before = process.memoryUsage().heapUsed;
            global.gc();
            const after = process.memoryUsage().heapUsed;
            const freedMB = Math.round((before - after) / 1024 / 1024);
            logger.info('[MemoryMonitor] Manual GC triggered', { freedMB });
            return freedMB;
        }
        logger.warn('[MemoryMonitor] GC not exposed. Start Node with --expose-gc flag');
        return null;
    }
}

// Export singleton instance
const memoryMonitor = new MemoryMonitor();

export default memoryMonitor;
export { MemoryMonitor };
