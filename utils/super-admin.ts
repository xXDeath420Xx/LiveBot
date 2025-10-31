import { Request, Response, NextFunction } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import db from './db';
import logger from './logger';

/**
 * Interface for super admin database row
 */
interface SuperAdminRow extends RowDataPacket {
    user_id: string;
    added_by: string | null;
    notes: string | null;
    added_at: Date;
}

/**
 * Augment Express User type to include super admin properties
 */
declare global {
    namespace Express {
        interface User {
            id: string;
            isSuperAdmin?: boolean;
            [key: string]: any;
        }
    }
}

/**
 * Check if a user is a super admin
 * @param userId - Discord user ID
 * @returns Promise<boolean>
 */
async function isSuperAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;

    try {
        const [rows] = await db.execute<SuperAdminRow[]>(
            'SELECT user_id FROM super_admins WHERE user_id = ?',
            [userId]
        );
        return rows.length > 0;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Super Admin] Error checking super admin status for ${userId}: ${errorMessage}`);
        return false;
    }
}

/**
 * Middleware to check if authenticated user is a super admin
 * Sets req.user.isSuperAdmin = true if they are
 */
async function checkSuperAdmin(
    req: Request,
    _res: Response,
    next: NextFunction
): Promise<void> {
    if (req.isAuthenticated() && req.user && req.user.id) {
        req.user.isSuperAdmin = await isSuperAdmin(req.user.id);
    }
    next();
}

/**
 * Middleware to require super admin access
 */
function requireSuperAdmin(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    if (!req.isAuthenticated() || !req.user) {
        res.redirect('/auth/discord');
        return;
    }

    if (!req.user.isSuperAdmin) {
        res.status(403).render('error', {
            message: 'Access Denied',
            details: 'You do not have permission to access this page.',
            user: req.user
        });
        return;
    }

    next();
}

/**
 * Add a user as super admin
 * @param userId - Discord user ID to add
 * @param addedBy - Discord user ID of person adding them
 * @param notes - Optional notes
 * @returns Promise<boolean>
 */
async function addSuperAdmin(
    userId: string,
    addedBy: string,
    notes: string = ''
): Promise<boolean> {
    try {
        await db.execute<ResultSetHeader>(
            'INSERT INTO super_admins (user_id, added_by, notes) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE notes = ?',
            [userId, addedBy, notes, notes]
        );
        logger.info(`[Super Admin] User ${userId} added as super admin by ${addedBy}`);
        return true;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Super Admin] Error adding super admin ${userId}: ${errorMessage}`);
        return false;
    }
}

/**
 * Remove a user as super admin
 * @param userId - Discord user ID to remove
 * @returns Promise<boolean>
 */
async function removeSuperAdmin(userId: string): Promise<boolean> {
    try {
        await db.execute<ResultSetHeader>(
            'DELETE FROM super_admins WHERE user_id = ?',
            [userId]
        );
        logger.info(`[Super Admin] User ${userId} removed as super admin`);
        return true;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Super Admin] Error removing super admin ${userId}: ${errorMessage}`);
        return false;
    }
}

/**
 * Get all super admins
 * @returns Promise<SuperAdminRow[]>
 */
async function getAllSuperAdmins(): Promise<SuperAdminRow[]> {
    try {
        const [rows] = await db.execute<SuperAdminRow[]>(
            'SELECT * FROM super_admins ORDER BY added_at DESC'
        );
        return rows;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Super Admin] Error fetching super admins: ${errorMessage}`);
        return [];
    }
}

export {
    isSuperAdmin,
    checkSuperAdmin,
    requireSuperAdmin,
    addSuperAdmin,
    removeSuperAdmin,
    getAllSuperAdmins,
    type SuperAdminRow
};

export default {
    isSuperAdmin,
    checkSuperAdmin,
    requireSuperAdmin,
    addSuperAdmin,
    removeSuperAdmin,
    getAllSuperAdmins
};
