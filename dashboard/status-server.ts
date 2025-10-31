/**
 * Status Server
 *
 * This file is intentionally empty/minimal as the status functionality
 * has been integrated into the main dashboard server.ts file.
 *
 * If you need a separate status server in the future, implement it here.
 */

import express, { Express, Request, Response } from 'express';
import { logger } from '../utils/logger';

export function startStatusServer(port: number = 3002): void {
    const app: Express = express();

    app.get('/health', (req: Request, res: Response): void => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString()
        });
    });

    app.listen(port, (): void => {
        logger.info(`[Status Server] Listening on port ${port}`);
    }).on('error', (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE') {
            logger.error(`[Status Server] Port ${port} is already in use.`);
            process.exit(1);
        } else {
            logger.error('[Status Server] Error starting server:', { error: err.message });
        }
    });
}
