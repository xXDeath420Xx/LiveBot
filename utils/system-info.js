/**
 * System Information Utilities
 * Safe alternatives to exec() for system stats
 * Uses execFile (no shell) and direct file reading
 */

import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

// execFile is SAFE - it does NOT use shell interpretation
// Arguments are passed directly to the binary, preventing injection
const execFileAsync = promisify(execFile);

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes) {
    if (bytes >= 1099511627776) return `${(bytes / 1099511627776).toFixed(2)} TB`;
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
}

/**
 * Get network statistics by reading /proc/net/dev directly
 * Safe: No shell needed, direct file read
 */
export async function getNetworkStats() {
    try {
        // Read /proc/net/dev directly instead of using shell commands
        const netDev = await fs.promises.readFile('/proc/net/dev', 'utf-8');
        const lines = netDev.split('\n');

        // Find first ethernet/wifi interface
        const interfacePatterns = ['eth', 'ens', 'enp', 'eno', 'wlan', 'wlp'];

        for (const line of lines) {
            const trimmed = line.trim();

            // Check if line starts with a known interface name
            const matchesInterface = interfacePatterns.some(pattern =>
                trimmed.toLowerCase().startsWith(pattern)
            );

            if (matchesInterface) {
                // Parse the line: "interface: rx_bytes rx_packets ... tx_bytes tx_packets ..."
                const parts = trimmed.replace(':', ' ').split(/\s+/).filter(p => p);

                if (parts.length >= 10) {
                    const rxBytes = parseInt(parts[1]) || 0;
                    const txBytes = parseInt(parts[9]) || 0;

                    return {
                        rx: formatBytes(rxBytes),
                        tx: formatBytes(txBytes),
                        rxBytes,
                        txBytes,
                        interface: parts[0]
                    };
                }
            }
        }

        return { rx: 'N/A', tx: 'N/A' };
    } catch (error) {
        logger.debug('[SystemInfo] Could not read network stats', { error: error.message });
        return { rx: 'N/A', tx: 'N/A' };
    }
}

/**
 * Get disk usage using df command safely via execFile (no shell interpretation)
 */
export async function getDiskStats() {
    try {
        // execFile doesn't use shell, so no injection is possible
        // Arguments are passed as array, not concatenated string
        const { stdout } = await execFileAsync('df', ['-h', '/'], { timeout: 5000 });
        const lines = stdout.trim().split('\n');

        if (lines.length >= 2) {
            const parts = lines[1].split(/\s+/);
            if (parts.length >= 5) {
                return {
                    total: parts[1],
                    used: parts[2],
                    available: parts[3],
                    percent: parseInt(parts[4]) || 0
                };
            }
        }

        return { used: 'N/A', total: 'N/A', percent: 0 };
    } catch (error) {
        logger.debug('[SystemInfo] Could not get disk stats', { error: error.message });
        return { used: 'N/A', total: 'N/A', percent: 0 };
    }
}

/**
 * Get PM2 process list safely using execFile
 */
export async function getPM2Processes() {
    try {
        // execFile with pm2 and jlist argument - no shell needed
        const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 5000 });
        const pm2List = JSON.parse(stdout);

        return pm2List.map(proc => ({
            name: proc.name,
            status: proc.pm2_env?.status || 'unknown',
            uptime: proc.pm2_env?.pm_uptime || Date.now(),
            cpu: proc.monit?.cpu || 0,
            memory: proc.monit?.memory || 0,
            restarts: proc.pm2_env?.restart_time || 0
        }));
    } catch (error) {
        logger.debug('[SystemInfo] PM2 not available or error', { error: error.message });
        return [];
    }
}

/**
 * Get PM2 log file contents safely using fs.promises (no shell)
 * @param {string} processName - PM2 process name (validated)
 * @param {string} logType - 'out' or 'error'
 * @param {number} lines - Number of lines to return (validated)
 */
export async function getPM2Logs(processName, logType = 'out', lines = 100) {
    // Validate inputs
    const validLogTypes = ['out', 'error'];
    if (!validLogTypes.includes(logType)) {
        logType = 'out';
    }

    // Sanitize process name - only allow alphanumeric, dash, underscore
    const sanitizedName = processName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitizedName || sanitizedName !== processName) {
        logger.warn('[SystemInfo] Invalid process name rejected', { original: processName });
        return { logs: [], error: 'Invalid process name' };
    }

    // Clamp lines to reasonable bounds
    lines = Math.max(1, Math.min(500, parseInt(lines) || 100));

    const pm2LogDir = `${process.env.HOME || '/root'}/.pm2/logs`;
    const logFile = `${pm2LogDir}/${sanitizedName}-${logType}.log`;

    try {
        // Check file exists using fs.promises (no shell)
        await fs.promises.access(logFile, fs.constants.R_OK);

        // Read file directly using fs.promises (no shell)
        const content = await fs.promises.readFile(logFile, 'utf-8');
        const allLines = content.split('\n').filter(line => line.trim());

        // Get last N lines
        const lastLines = allLines.slice(-lines);

        // Parse log lines
        const logs = lastLines.map(line => {
            // Remove ANSI color codes
            const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');

            // Extract timestamp and level
            const timestampMatch = cleanLine.match(/\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/);
            const levelMatch = cleanLine.match(/\b(INFO|WARN|ERROR|DEBUG|VERBOSE)\b/i);

            let type = 'info';
            if (levelMatch) {
                type = levelMatch[1].toLowerCase();
            } else if (logType === 'error' || cleanLine.toLowerCase().includes('error')) {
                type = 'error';
            } else if (cleanLine.toLowerCase().includes('warn')) {
                type = 'warn';
            }

            return {
                process: sanitizedName,
                timestamp: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
                type,
                message: cleanLine
            };
        }).filter(log => log.message.trim());

        return { logs: logs.reverse(), success: true };
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Try to list available log files using fs.promises (no shell)
            try {
                const files = await fs.promises.readdir(pm2LogDir);
                return {
                    logs: [],
                    error: `Log file not found: ${logFile}`,
                    availableFiles: files.filter(f => f.endsWith('.log'))
                };
            } catch {
                return { logs: [], error: 'PM2 logs directory not found' };
            }
        }

        logger.debug('[SystemInfo] Error reading PM2 logs', { error: error.message });
        return { logs: [], error: error.message };
    }
}

/**
 * Get list of available PM2 process names
 */
export async function getPM2ProcessNames() {
    try {
        const processes = await getPM2Processes();
        return processes.map(p => p.name);
    } catch {
        return ['CertiFriedUtility']; // Default fallback
    }
}

/**
 * Check Redis status and stats safely using execFile
 */
export async function getRedisStats() {
    const defaultStats = {
        status: 'unavailable',
        hitRate: 'N/A',
        entries: 0,
        responseTime: 'N/A'
    };

    try {
        // Check if Redis is running with ping using execFile (no shell)
        const { stdout: pingResult } = await execFileAsync('redis-cli', ['ping'], { timeout: 2000 });

        if (pingResult.trim() !== 'PONG') {
            return defaultStats;
        }

        // Get stats using execFile (no shell)
        const { stdout: infoResult } = await execFileAsync('redis-cli', ['info', 'stats'], { timeout: 2000 });

        const hits = parseInt(infoResult.match(/keyspace_hits:(\d+)/)?.[1] || '0');
        const misses = parseInt(infoResult.match(/keyspace_misses:(\d+)/)?.[1] || '0');
        const total = hits + misses;

        // Get key count using execFile (no shell)
        const { stdout: dbsizeResult } = await execFileAsync('redis-cli', ['dbsize'], { timeout: 2000 });
        const entries = parseInt(dbsizeResult.match(/\d+/)?.[0] || '0');

        // Measure response time
        const start = Date.now();
        await execFileAsync('redis-cli', ['ping'], { timeout: 2000 });
        const responseTime = Date.now() - start;

        return {
            status: 'online',
            hitRate: total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : '100%',
            entries,
            responseTime: `${responseTime}ms`
        };
    } catch (error) {
        logger.debug('[SystemInfo] Redis not available', { error: error.message });
        return defaultStats;
    }
}

/**
 * Get CPU usage from os module (no shell needed)
 */
export function getCPUUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
        for (const type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    });

    return {
        usage: Math.round(100 - (100 * totalIdle / totalTick)),
        cores: cpus.length
    };
}

/**
 * Get memory usage from os module (no shell needed)
 */
export function getMemoryUsage() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    return {
        used: usedMem,
        total: totalMem,
        free: freeMem,
        usagePercent: (usedMem / totalMem) * 100,
        usedFormatted: formatBytes(usedMem),
        totalFormatted: formatBytes(totalMem)
    };
}

/**
 * Get all system stats in one call
 */
export async function getAllSystemStats() {
    const [network, disk, processes, redis] = await Promise.all([
        getNetworkStats(),
        getDiskStats(),
        getPM2Processes(),
        getRedisStats()
    ]);

    return {
        cpu: getCPUUsage(),
        memory: getMemoryUsage(),
        network,
        disk,
        processes,
        redis,
        uptime: os.uptime(),
        platform: os.platform(),
        nodeVersion: process.version
    };
}

export default {
    formatBytes,
    getNetworkStats,
    getDiskStats,
    getPM2Processes,
    getPM2Logs,
    getPM2ProcessNames,
    getRedisStats,
    getCPUUsage,
    getMemoryUsage,
    getAllSystemStats
};
