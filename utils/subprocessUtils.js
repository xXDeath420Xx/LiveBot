/**
 * Subprocess Utilities
 * Provides helpers for safely spawning and managing child processes
 */

import { spawn } from 'child_process';
import logger from './logger.js';

/**
 * Spawn a subprocess with automatic cleanup and timeout protection
 * @param {string} command - The command to spawn
 * @param {string[]} args - Arguments for the command
 * @param {Object} options - Spawn options plus additional config
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export function spawnWithCleanup(command, args, options = {}) {
    const {
        timeout = 30000,
        maxBuffer = 1024 * 1024, // 1MB
        context = command,
        ...spawnOptions
    } = options;

    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let killed = false;
        let timeoutId = null;

        const proc = spawn(command, args, spawnOptions);

        // Cleanup function to remove all listeners and kill process
        const cleanup = (reason = 'cleanup') => {
            if (killed) return;
            killed = true;

            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }

            // Remove all listeners
            proc.stdout?.removeAllListeners();
            proc.stderr?.removeAllListeners();
            proc.removeAllListeners();

            // Kill process if still running
            if (!proc.killed) {
                try {
                    proc.kill('SIGTERM');
                    // Force kill after 1 second if still alive
                    setTimeout(() => {
                        if (!proc.killed) {
                            proc.kill('SIGKILL');
                        }
                    }, 1000);
                } catch (e) {
                    // Process may already be dead
                }
            }

            logger.debug(`[SubprocessUtils] ${context} cleanup complete (reason: ${reason})`);
        };

        // Set up timeout
        timeoutId = setTimeout(() => {
            cleanup('timeout');
            reject(new Error(`${context} timed out after ${timeout}ms`));
        }, timeout);

        // Collect stdout
        if (proc.stdout) {
            proc.stdout.on('data', (data) => {
                if (stdout.length < maxBuffer) {
                    stdout += data.toString();
                }
            });
        }

        // Collect stderr
        if (proc.stderr) {
            proc.stderr.on('data', (data) => {
                if (stderr.length < maxBuffer) {
                    stderr += data.toString();
                }
            });
        }

        // Handle process completion
        proc.on('close', (code) => {
            if (killed) return;
            cleanup('completed');
            resolve({ stdout, stderr, code });
        });

        // Handle errors
        proc.on('error', (error) => {
            cleanup('error');
            reject(error);
        });
    });
}

/**
 * Run yt-dlp with automatic cleanup and timeout
 * @param {string[]} args - Arguments for yt-dlp
 * @param {Object} options - Options (timeout, etc.)
 * @returns {Promise<Object>} Parsed JSON output or raw output
 */
export async function runYtdlp(args, options = {}) {
    const { timeout = 15000, parseJson = false } = options;

    const result = await spawnWithCleanup('yt-dlp', args, {
        timeout,
        context: `yt-dlp ${args[0] || ''}`
    });

    if (result.code !== 0) {
        throw new Error(result.stderr || `yt-dlp failed with code ${result.code}`);
    }

    if (parseJson && result.stdout.trim()) {
        try {
            return JSON.parse(result.stdout.trim());
        } catch (e) {
            throw new Error('Failed to parse yt-dlp JSON output');
        }
    }

    return result.stdout;
}

/**
 * Run Piper TTS with automatic cleanup
 * @param {string} text - Text to synthesize
 * @param {string} modelPath - Path to Piper model
 * @param {string} outputPath - Output file path
 * @param {Object} options - Options (timeout, etc.)
 * @returns {Promise<void>}
 */
export async function runPiperTTS(text, modelPath, outputPath, options = {}) {
    const { timeout = 30000 } = options;

    return new Promise((resolve, reject) => {
        let killed = false;
        let timeoutId = null;

        const piper = spawn('piper', [
            '--model', modelPath,
            '--output_file', outputPath
        ]);

        const cleanup = (reason = 'cleanup') => {
            if (killed) return;
            killed = true;

            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }

            piper.stdin?.removeAllListeners();
            piper.stdout?.removeAllListeners();
            piper.stderr?.removeAllListeners();
            piper.removeAllListeners();

            if (!piper.killed) {
                try {
                    piper.kill('SIGTERM');
                } catch (e) {}
            }

            logger.debug(`[SubprocessUtils] Piper TTS cleanup complete (reason: ${reason})`);
        };

        timeoutId = setTimeout(() => {
            cleanup('timeout');
            reject(new Error(`Piper TTS timed out after ${timeout}ms`));
        }, timeout);

        piper.on('close', (code) => {
            if (killed) return;
            cleanup('completed');
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Piper exited with code ${code}`));
            }
        });

        piper.on('error', (error) => {
            cleanup('error');
            reject(error);
        });

        // Write text and close stdin
        piper.stdin.write(text);
        piper.stdin.end();
    });
}

export default {
    spawnWithCleanup,
    runYtdlp,
    runPiperTTS
};
