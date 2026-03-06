/**
 * Process Pool for yt-dlp
 * Limits concurrent process spawns to prevent resource exhaustion
 */
import { spawn } from 'child_process';
import logger from './logger.js';

class ProcessPool {
  constructor(options = {}) {
    // Maximum concurrent processes
    this.maxConcurrent = options.maxConcurrent || 5;
    // Default timeout in ms (6 seconds as recommended)
    this.defaultTimeout = options.timeout || 6000;
    // Queue for pending requests
    this.queue = [];
    // Currently running processes count
    this.running = 0;
    // Statistics
    this.stats = {
      totalRequests: 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
      queued: 0
    };

    logger.info('[ProcessPool] Initialized', {
      maxConcurrent: this.maxConcurrent,
      timeout: this.defaultTimeout
    });
  }

  /**
   * Execute a yt-dlp command with pooling
   * @param {string[]} args - Command arguments
   * @param {Object} options - Execution options
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async execute(args, options = {}) {
    this.stats.totalRequests++;

    return new Promise((resolve, reject) => {
      const request = {
        args,
        options: {
          timeout: options.timeout || this.defaultTimeout,
          ...options
        },
        resolve,
        reject,
        queuedAt: Date.now()
      };

      if (this.running < this.maxConcurrent) {
        this.runProcess(request);
      } else {
        this.stats.queued++;
        this.queue.push(request);
        logger.debug(`[ProcessPool] Request queued, queue size: ${this.queue.length}`);
      }
    });
  }

  /**
   * Run a process from the queue or directly
   * @private
   */
  runProcess(request) {
    this.running++;
    const { args, options, resolve, reject, queuedAt } = request;

    const waitTime = Date.now() - queuedAt;
    if (waitTime > 100) {
      logger.debug(`[ProcessPool] Request waited ${waitTime}ms in queue`);
    }

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let completed = false;
    let processKilled = false;

    const proc = spawn('yt-dlp', args);

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (!completed) {
        processKilled = true;
        proc.kill('SIGTERM');
        // Force kill after 1 second if SIGTERM didn't work
        setTimeout(() => {
          if (!completed) {
            proc.kill('SIGKILL');
          }
        }, 1000);
        this.stats.timedOut++;
        logger.warn(`[ProcessPool] Process timed out after ${options.timeout}ms`, {
          args: args.slice(0, 3).join(' ')
        });
      }
    }, options.timeout);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      completed = true;
      clearTimeout(timeoutId);
      this.running--;

      const duration = Date.now() - startTime;

      if (processKilled) {
        resolve({
          stdout,
          stderr: stderr + '\nProcess killed due to timeout',
          code: -1,
          timedOut: true
        });
      } else if (code === 0) {
        this.stats.completed++;
        logger.debug(`[ProcessPool] Process completed in ${duration}ms`);
        resolve({ stdout, stderr, code });
      } else {
        this.stats.failed++;
        logger.debug(`[ProcessPool] Process failed with code ${code} in ${duration}ms`);
        resolve({ stdout, stderr, code });
      }

      // Process next in queue
      this.processNext();
    });

    proc.on('error', (error) => {
      completed = true;
      clearTimeout(timeoutId);
      this.running--;
      this.stats.failed++;

      logger.error(`[ProcessPool] Process error: ${error.message}`);
      resolve({
        stdout: '',
        stderr: error.message,
        code: -1,
        error: true
      });

      // Process next in queue
      this.processNext();
    });
  }

  /**
   * Process the next request in the queue
   * @private
   */
  processNext() {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const next = this.queue.shift();
      this.runProcess(next);
    }
  }

  /**
   * Get current pool statistics
   * @returns {Object} Pool stats
   */
  getStats() {
    return {
      ...this.stats,
      running: this.running,
      queueLength: this.queue.length,
      maxConcurrent: this.maxConcurrent
    };
  }

  /**
   * Clear the queue (for shutdown)
   */
  clear() {
    const cleared = this.queue.length;
    for (const request of this.queue) {
      request.reject(new Error('Pool shutdown'));
    }
    this.queue = [];
    logger.info(`[ProcessPool] Cleared ${cleared} queued requests`);
  }
}

// Singleton instance for yt-dlp
const ytdlpPool = new ProcessPool({
  maxConcurrent: 5,
  timeout: 6000
});

export default ytdlpPool;
export { ProcessPool };
