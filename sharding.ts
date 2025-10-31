/**
 * Sharding Manager
 * Note: This file is currently not in use as sharding has been disabled.
 * The bot is now run directly via index.ts.
 * This file is kept for future reference when sharding needs to be re-enabled.
 */

import 'dotenv-flow/config';
import { ShardingManager } from 'discord.js';
import path from 'path';

// Type definitions
interface ShardingConfig {
  totalShards: number | 'auto';
  shardList?: number[] | 'auto';
  mode?: 'process' | 'worker';
  respawn?: boolean;
  shardArgs?: string[];
  execArgv?: string[];
  silent?: boolean;
}

/**
 * Initialize and start the sharding manager
 */
async function startSharding(): Promise<void> {
  try {
    // Validate environment variables
    const token: string | undefined = process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error('DISCORD_TOKEN is not defined in environment variables');
    }

    // Configure sharding options
    const shardingConfig: ShardingConfig = {
      totalShards: 'auto', // Discord will automatically determine the number of shards
      mode: 'process', // Use process mode for better stability
      respawn: true, // Automatically respawn dead shards
      shardArgs: [], // Additional arguments to pass to shards
      execArgv: [], // Node.js execution arguments
      silent: false // Show shard output
    };

    // Create sharding manager
    const manager = new ShardingManager(path.join(__dirname, 'index.js'), {
      token,
      totalShards: shardingConfig.totalShards,
      shardList: shardingConfig.shardList,
      mode: shardingConfig.mode,
      respawn: shardingConfig.respawn,
      shardArgs: shardingConfig.shardArgs,
      execArgv: shardingConfig.execArgv,
      silent: shardingConfig.silent
    });

    // Shard event handlers
    manager.on('shardCreate', (shard) => {
      console.log(`[Sharding] Launched shard ${shard.id}`);

      // Handle shard ready event
      shard.on('ready', () => {
        console.log(`[Shard ${shard.id}] Ready`);
      });

      // Handle shard disconnect
      shard.on('disconnect', () => {
        console.warn(`[Shard ${shard.id}] Disconnected`);
      });

      // Handle shard reconnecting
      shard.on('reconnecting', () => {
        console.log(`[Shard ${shard.id}] Reconnecting...`);
      });

      // Handle shard death
      shard.on('death', (process) => {
        const pid = 'pid' in process ? process.pid : 'N/A';
        console.error(`[Shard ${shard.id}] Died (PID: ${pid})`);
      });

      // Handle shard error
      shard.on('error', (error) => {
        console.error((`[Shard ${shard.id}] Error:`, error as any));
      });

      // Handle shard messages
      shard.on('message', (message) => {
        console.log(`[Shard ${shard.id}] Message:`, message);
      });
    });

    // Start spawning shards
    console.log('[Sharding] Starting shard manager...');
    await manager.spawn();
    console.log(`[Sharding] Successfully spawned ${manager.shards.size} shard(s)`);

  } catch (error: unknown) {
    console.error('[Sharding] Failed to start sharding manager:', error as any);
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGINT', () => {
  console.log('[Sharding] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Sharding] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  console.error('[Sharding] Uncaught Exception:', error as any);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<any>) => {
  console.error('[Sharding] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the sharding manager
startSharding().catch((error: unknown) => {
  console.error('[Sharding] Fatal error:', error as any);
  process.exit(1);
});