/**
 * Banking Notification Service - Admin Routes
 * 
 * Administrative endpoints for monitoring, metrics, and operations.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler, authenticateInternalApi } from '../middleware';
import { NotificationEvent, DeadLetterQueue } from '../models';
import { retryService, digestService } from '../services';
import { rateLimiter } from '../redis/RateLimiter';
import { Op } from 'sequelize';

const router = Router();

// All admin routes require internal API key
router.use(authenticateInternalApi);

/**
 * GET /admin/health
 * Detailed service health check
 */
router.get(
    '/health',
    asyncHandler(async (_req: Request, res: Response) => {
        // Check database connections
        const checks = {
            postgres: false,
            mongodb: false,
            redis: false,
        };

        try {
            await NotificationEvent.findOne({ limit: 1 });
            checks.postgres = true;
        } catch { /* ignore */ }

        try {
            const { UserPreferences } = await import('../models');
            await UserPreferences.findOne().limit(1);
            checks.mongodb = true;
        } catch { /* ignore */ }

        try {
            const { redis } = await import('../redis/client');
            await redis.ping();
            checks.redis = true;
        } catch { /* ignore */ }

        const healthy = Object.values(checks).every(Boolean);

        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'healthy' : 'degraded',
            service: 'banking-notification-service',
            timestamp: new Date().toISOString(),
            checks,
        });
    })
);

/**
 * GET /admin/metrics
 * Get service metrics
 */
router.get(
    '/metrics',
    asyncHandler(async (_req: Request, res: Response) => {
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // Query metrics
        const [
            totalNotifications24h,
            failedNotifications24h,
            notificationsByChannel,
            notificationsByStatus,
            retryStats,
        ] = await Promise.all([
            NotificationEvent.count({ where: { createdAt: { [Op.gte]: oneDayAgo } } }),
            NotificationEvent.count({
                where: { deliveryStatus: 'failed', createdAt: { [Op.gte]: oneDayAgo } },
            }),
            NotificationEvent.findAll({
                attributes: [
                    'channel',
                    [NotificationEvent.sequelize!.fn('COUNT', '*'), 'count'],
                ],
                where: { createdAt: { [Op.gte]: oneDayAgo } },
                group: ['channel'],
                raw: true,
            }),
            NotificationEvent.findAll({
                attributes: [
                    'deliveryStatus',
                    [NotificationEvent.sequelize!.fn('COUNT', '*'), 'count'],
                ],
                where: { createdAt: { [Op.gte]: oneDayAgo } },
                group: ['deliveryStatus'],
                raw: true,
            }),
            retryService.getStats(),
        ]);

        const successRate = totalNotifications24h > 0
            ? ((totalNotifications24h - failedNotifications24h) / totalNotifications24h * 100).toFixed(2)
            : '100.00';

        res.json({
            success: true,
            data: {
                period: '24h',
                notifications: {
                    total: totalNotifications24h,
                    failed: failedNotifications24h,
                    successRate: `${successRate}%`,
                },
                byChannel: notificationsByChannel,
                byStatus: notificationsByStatus,
                retries: retryStats,
                timestamp: now.toISOString(),
            },
        });
    })
);

/**
 * GET /admin/dlq
 * Get Dead Letter Queue items
 */
router.get(
    '/dlq',
    asyncHandler(async (req: Request, res: Response) => {
        const { page = 1, limit = 20, status } = req.query as {
            page?: number;
            limit?: number;
            status?: string;
        };

        const where: Record<string, unknown> = {};
        if (status) where['status'] = status;

        const offset = (Number(page) - 1) * Number(limit);

        const { count, rows } = await DeadLetterQueue.findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: Number(limit),
            offset,
        });

        res.json({
            success: true,
            data: {
                items: rows,
                pagination: {
                    page: Number(page),
                    limit: Number(limit),
                    total: count,
                    totalPages: Math.ceil(count / Number(limit)),
                },
            },
        });
    })
);

/**
 * POST /admin/dlq/:id/resolve
 * Resolve a DLQ item
 */
router.post(
    '/dlq/:id/resolve',
    asyncHandler(async (req: Request, res: Response) => {
        const { id } = req.params;
        const { resolutionType, notes } = req.body as {
            resolutionType: 'manual_retry' | 'contact_updated' | 'user_notified' | 'skipped';
            notes?: string;
        };

        const item = await DeadLetterQueue.findByPk(id);

        if (!item) {
            res.status(404).json({
                success: false,
                error: { code: 'NOT_FOUND', message: 'DLQ item not found' },
            });
            return;
        }

        await item.resolve(resolutionType, notes);

        res.json({
            success: true,
            message: 'DLQ item resolved',
        });
    })
);

/**
 * POST /admin/retry/:notificationId
 * Manually retry a notification
 */
router.post(
    '/retry/:notificationId',
    asyncHandler(async (req: Request, res: Response) => {
        const { notificationId } = req.params;

        const success = await retryService.manualRetry(notificationId);

        if (success) {
            res.json({
                success: true,
                message: 'Notification queued for retry',
            });
        } else {
            res.status(400).json({
                success: false,
                error: { code: 'BAD_REQUEST', message: 'Notification not eligible for retry' },
            });
        }
    })
);

/**
 * POST /admin/digest/:userId/send
 * Force send digest for a user
 */
router.post(
    '/digest/:userId/send',
    asyncHandler(async (req: Request, res: Response) => {
        const { userId } = req.params;

        const success = await digestService.forceSendDigest(userId);

        if (success) {
            res.json({
                success: true,
                message: 'Digest sent successfully',
            });
        } else {
            res.status(400).json({
                success: false,
                error: { code: 'BAD_REQUEST', message: 'User not found or no pending digest' },
            });
        }
    })
);

/**
 * POST /admin/ratelimit/:userId/reset
 * Reset rate limits for a user
 */
router.post(
    '/ratelimit/:userId/reset',
    asyncHandler(async (req: Request, res: Response) => {
        const { userId } = req.params;
        const { channel } = req.body as { channel?: 'sms' | 'email' | 'push' };

        await rateLimiter.resetLimits(userId, channel);

        res.json({
            success: true,
            message: 'Rate limits reset successfully',
        });
    })
);

export default router;
