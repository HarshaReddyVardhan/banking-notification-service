/**
 * Banking Notification Service - Notification Routes
 * 
 * API endpoints for sending notifications (service-to-service)
 * and retrieving notification history (user-facing).
 */

import { Router, Request, Response } from 'express';
import {
    asyncHandler,
    authenticateInternalApi,
    authenticateUser,
    validateBody,
    validateQuery,
    validateUuidParam,
    sendNotificationSchema,
    historyQuerySchema,
    requireUserId,
} from '../middleware';
import { notificationRouter } from '../services';
import { NotificationEvent } from '../models';
import { NotificationEventType } from '../types';
import { Op } from 'sequelize';

const router = Router();

// ==================== Service-to-Service Endpoints ====================

/**
 * POST /notifications/send
 * Send a notification (called by other services)
 */
router.post(
    '/send',
    authenticateInternalApi,
    validateBody(sendNotificationSchema),
    asyncHandler(async (req: Request, res: Response) => {
        const { userId, eventType, title, message, eventSourceId, priority, data, correlationId } = req.body;

        const result = await notificationRouter.route({
            userId,
            eventType: eventType as NotificationEventType,
            title,
            message,
            eventSourceId,
            priority,
            data,
            correlationId: correlationId ?? req.correlationId,
        });

        res.status(200).json({
            success: true,
            data: {
                notificationId: result.notificationId,
                channels: result.results.map((r) => ({
                    channel: r.channel,
                    status: r.status,
                    providerMessageId: r.providerMessageId,
                })),
                skipped: result.skippedChannels,
                queued: result.queued,
                digestQueued: result.digestQueued,
            },
            correlationId: req.correlationId,
        });
    })
);

/**
 * POST /notifications/batch
 * Send notifications to multiple users
 */
router.post(
    '/batch',
    authenticateInternalApi,
    asyncHandler(async (req: Request, res: Response) => {
        const { notifications } = req.body as {
            notifications: Array<{
                userId: string;
                eventType: string;
                title: string;
                message: string;
                eventSourceId?: string;
                priority?: string;
                data?: Record<string, unknown>;
            }>;
        };

        if (!Array.isArray(notifications) || notifications.length === 0) {
            res.status(400).json({
                success: false,
                error: { code: 'BAD_REQUEST', message: 'notifications array required' },
            });
            return;
        }

        if (notifications.length > 100) {
            res.status(400).json({
                success: false,
                error: { code: 'BAD_REQUEST', message: 'Maximum 100 notifications per batch' },
            });
            return;
        }

        const results = await Promise.all(
            notifications.map((n) =>
                notificationRouter.route({
                    userId: n.userId,
                    eventType: n.eventType as NotificationEventType,
                    title: n.title,
                    message: n.message,
                    eventSourceId: n.eventSourceId,
                    priority: n.priority as 'low' | 'medium' | 'high' | 'critical' | undefined,
                    data: n.data,
                    correlationId: req.correlationId,
                })
            )
        );

        res.status(200).json({
            success: true,
            data: {
                total: results.length,
                successful: results.filter((r) =>
                    r.results.some((res) => res.status === 'sent' || res.status === 'delivered')
                ).length,
                failed: results.filter((r) =>
                    r.results.every((res) => res.status === 'failed')
                ).length,
                skipped: results.filter((r) => r.skippedChannels.length > 0).length,
            },
            correlationId: req.correlationId,
        });
    })
);

// ==================== User-Facing Endpoints ====================

/**
 * GET /notifications/history
 * Get notification history for authenticated user
 */
router.get(
    '/history',
    authenticateUser,
    validateQuery(historyQuerySchema),
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);
        const {
            page = 1,
            limit = 20,
            eventType,
            channel,
            status,
            startDate,
            endDate,
        } = req.query as {
            page?: number;
            limit?: number;
            eventType?: string;
            channel?: string;
            status?: string;
            startDate?: string;
            endDate?: string;
        };

        // Build where clause
        const where: Record<string, unknown> = { userId };

        if (eventType) where['eventType'] = eventType;
        if (channel) where['channel'] = channel;
        if (status) where['deliveryStatus'] = status;
        if (startDate || endDate) {
            where['createdAt'] = {};
            if (startDate) (where['createdAt'] as any)[Op.gte] = new Date(startDate);
            if (endDate) (where['createdAt'] as any)[Op.lte] = new Date(endDate);
        }

        const offset = (page - 1) * limit;

        const { count, rows } = await NotificationEvent.findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit,
            offset,
            attributes: [
                'notificationId',
                'eventType',
                'title',
                'message',
                'channel',
                'deliveryStatus',
                'createdAt',
                'sentAt',
                'readAt',
            ],
        });

        res.json({
            success: true,
            data: {
                notifications: rows,
                pagination: {
                    page,
                    limit,
                    total: count,
                    totalPages: Math.ceil(count / limit),
                },
            },
            correlationId: req.correlationId,
        });
    })
);

/**
 * GET /notifications/:id
 * Get single notification details
 */
router.get(
    '/:notificationId',
    authenticateUser,
    validateUuidParam('notificationId'),
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);
        const { notificationId } = req.params;

        const notification = await NotificationEvent.findOne({
            where: { notificationId, userId },
        });

        if (!notification) {
            res.status(404).json({
                success: false,
                error: { code: 'NOT_FOUND', message: 'Notification not found' },
            });
            return;
        }

        res.json({
            success: true,
            data: notification,
            correlationId: req.correlationId,
        });
    })
);

/**
 * POST /notifications/:id/read
 * Mark notification as read
 */
router.post(
    '/:notificationId/read',
    authenticateUser,
    validateUuidParam('notificationId'),
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);
        const { notificationId } = req.params;

        const notification = await NotificationEvent.findOne({
            where: { notificationId, userId },
        });

        if (!notification) {
            res.status(404).json({
                success: false,
                error: { code: 'NOT_FOUND', message: 'Notification not found' },
            });
            return;
        }

        await notification.markRead();

        res.json({
            success: true,
            data: { readAt: notification.readAt },
            correlationId: req.correlationId,
        });
    })
);

/**
 * POST /notifications/read-all
 * Mark all notifications as read
 */
router.post(
    '/read-all',
    authenticateUser,
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);

        const [count] = await NotificationEvent.update(
            { readAt: new Date() },
            { where: { userId, readAt: null } }
        );

        res.json({
            success: true,
            data: { updatedCount: count },
            correlationId: req.correlationId,
        });
    })
);

/**
 * GET /notifications/unread/count
 * Get unread notification count
 */
router.get(
    '/unread/count',
    authenticateUser,
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);

        const count = await NotificationEvent.count({
            where: { userId, readAt: null },
        });

        res.json({
            success: true,
            data: { unreadCount: count },
            correlationId: req.correlationId,
        });
    })
);

export default router;
