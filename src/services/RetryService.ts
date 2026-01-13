/**
 * Banking Notification Service - Retry Service
 * 
 * Handles retry logic for failed notifications with exponential backoff.
 * Moves permanently failed notifications to Dead Letter Queue.
 */

import { config } from '../config/config';
import { logger } from '../utils/logger';
import { NotificationEvent, DeadLetterQueue } from '../models';
import { notificationRouter } from './NotificationRouter';
import { NotificationEventType } from '../types';
import { Op } from 'sequelize';

export class RetryService {
    private isRunning: boolean = false;
    private checkInterval: NodeJS.Timeout | null = null;
    private readonly checkIntervalMs: number = 30000; // Check every 30 seconds

    /**
     * Start the retry service
     */
    async start(): Promise<void> {
        if (this.isRunning) return;

        this.isRunning = true;
        logger.info('Retry service started');

        // Run immediately then on interval
        await this.processRetries();
        this.checkInterval = setInterval(() => {
            this.processRetries().catch((error) => {
                logger.error('Retry processing failed', { error });
            });
        }, this.checkIntervalMs);
    }

    /**
     * Stop the retry service
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return;

        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        this.isRunning = false;
        logger.info('Retry service stopped');
    }

    /**
     * Process notifications pending retry
     */
    async processRetries(): Promise<void> {
        try {
            // Find notifications ready for retry
            const notifications = await NotificationEvent.findAll({
                where: {
                    deliveryStatus: 'retrying',
                    nextRetryAt: {
                        [Op.lte]: new Date(),
                    },
                    retryCount: {
                        [Op.lt]: config.notification.maxRetryAttempts,
                    },
                },
                limit: 100, // Process in batches
                order: [['nextRetryAt', 'ASC']],
            });

            if (notifications.length === 0) return;

            logger.info(`Processing ${notifications.length} notifications for retry`);

            for (const notification of notifications) {
                await this.retryNotification(notification);
            }
        } catch (error) {
            logger.error('Error processing retries', { error });
        }
    }

    /**
     * Retry a single notification
     */
    private async retryNotification(notification: NotificationEvent): Promise<void> {
        try {
            // Re-route the notification
            const result = await notificationRouter.route({
                userId: notification.userId,
                eventType: notification.eventType as NotificationEventType,
                title: notification.title,
                message: notification.message,
                eventSourceId: notification.eventSourceId ?? undefined,
                data: notification.metadata as Record<string, unknown>,
                priority: notification.priority,
                correlationId: notification.correlationId ?? undefined,
            });

            // Check if any channel succeeded
            const succeeded = result.results.some(
                (r) => r.status === 'sent' || r.status === 'delivered'
            );

            if (succeeded) {
                // Update original notification as sent
                await notification.markSent();
                logger.info('Retry successful', {
                    notificationId: notification.notificationId,
                    retryCount: notification.retryCount + 1,
                });
            } else {
                // Schedule next retry or move to DLQ
                await this.scheduleNextRetry(notification, result.results[0]?.error);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await this.scheduleNextRetry(notification, errorMessage);
        }
    }

    /**
     * Schedule next retry or move to DLQ
     */
    private async scheduleNextRetry(
        notification: NotificationEvent,
        error?: string
    ): Promise<void> {
        const newRetryCount = notification.retryCount + 1;

        if (newRetryCount >= config.notification.maxRetryAttempts) {
            // Move to Dead Letter Queue
            await this.moveToDeadLetterQueue(notification, error ?? 'Max retries exceeded');
            await notification.markFailed('Max retries exceeded');
            logger.warn('Notification moved to DLQ', {
                notificationId: notification.notificationId,
                retryCount: newRetryCount,
            });
        } else {
            // Calculate next retry time
            const delayMs = config.retryDelaySchedule[newRetryCount] ?? 3600000;
            const nextRetryAt = new Date(Date.now() + delayMs);

            await notification.markRetrying(nextRetryAt);
            logger.info('Notification scheduled for retry', {
                notificationId: notification.notificationId,
                retryCount: newRetryCount,
                nextRetryAt,
            });
        }
    }

    /**
     * Move notification to Dead Letter Queue
     */
    private async moveToDeadLetterQueue(
        notification: NotificationEvent,
        reason: string
    ): Promise<void> {
        try {
            await DeadLetterQueue.create({
                originalNotificationId: notification.notificationId,
                userId: notification.userId,
                eventType: notification.eventType as NotificationEventType,
                eventSourceId: notification.eventSourceId,
                channel: notification.channel,
                priority: notification.priority,
                title: notification.title,
                message: notification.message,
                metadata: notification.metadata,
                failureReason: reason,
                totalAttempts: notification.retryCount + 1,
                lastAttemptAt: new Date(),
                failureHistory: [
                    {
                        timestamp: new Date().toISOString(),
                        error: reason,
                    },
                ],
                status: 'pending_review',
            });
        } catch (error) {
            logger.error('Failed to create DLQ entry', {
                notificationId: notification.notificationId,
                error,
            });
        }
    }

    /**
     * Manually trigger retry for a specific notification
     */
    async manualRetry(notificationId: string): Promise<boolean> {
        const notification = await NotificationEvent.findByPk(notificationId);

        if (!notification) {
            logger.warn('Notification not found for manual retry', { notificationId });
            return false;
        }

        if (notification.deliveryStatus !== 'failed' && notification.deliveryStatus !== 'retrying') {
            logger.warn('Notification not in failed/retrying state', {
                notificationId,
                status: notification.deliveryStatus,
            });
            return false;
        }

        // Reset retry count and try immediately
        notification.retryCount = 0;
        notification.nextRetryAt = new Date();
        notification.deliveryStatus = 'retrying';
        await notification.save();

        await this.retryNotification(notification);
        return true;
    }

    /**
     * Get retry statistics
     */
    async getStats(): Promise<{
        pendingRetries: number;
        failedToday: number;
        dlqPending: number;
    }> {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const [pendingRetries, failedToday, dlqPending] = await Promise.all([
            NotificationEvent.count({
                where: { deliveryStatus: 'retrying' },
            }),
            NotificationEvent.count({
                where: {
                    deliveryStatus: 'failed',
                    createdAt: { [Op.gte]: startOfDay },
                },
            }),
            DeadLetterQueue.count({
                where: { status: 'pending_review' },
            }),
        ]);

        return { pendingRetries, failedToday, dlqPending };
    }
}

// Export singleton
export const retryService = new RetryService();
