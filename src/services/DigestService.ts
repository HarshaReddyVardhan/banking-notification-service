/**
 * Banking Notification Service - Digest Service
 * 
 * Batches notifications for users who prefer digest mode.
 * Sends hourly, daily, or weekly email summaries.
 */

import { redis, REDIS_KEYS, REDIS_TTL } from '../redis/client';
import { config } from '../config/config';
import { logger } from '../utils/logger';
import { UserPreferences, NotificationEvent } from '../models';
import { emailHandler } from '../channels';
import { NotificationPayload, DigestFrequency } from '../types';
import { Op } from 'sequelize';

interface DigestEntry {
    notificationId: string;
    eventType: string;
    title: string;
    message: string;
    createdAt: string;
    data?: Record<string, unknown>;
}

export class DigestService {
    private isRunning: boolean = false;
    private checkInterval: NodeJS.Timeout | null = null;
    private readonly checkIntervalMs: number;

    constructor() {
        this.checkIntervalMs = config.notification.digestCheckIntervalMs;
    }

    /**
     * Start the digest service
     */
    async start(): Promise<void> {
        if (this.isRunning || !config.notification.digestEnabled) return;

        this.isRunning = true;
        logger.info('Digest service started');

        // Check periodically for digests to send
        this.checkInterval = setInterval(() => {
            this.processDigests().catch((error) => {
                logger.error('Digest processing failed', { error });
            });
        }, this.checkIntervalMs);
    }

    /**
     * Stop the digest service
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return;

        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        this.isRunning = false;
        logger.info('Digest service stopped');
    }

    /**
     * Queue notification for digest
     */
    async queueForDigest(
        userId: string,
        notification: NotificationPayload,
        frequency: DigestFrequency
    ): Promise<void> {
        if (frequency === 'immediate') {
            // Immediate = no digest, should be handled by router
            return;
        }

        const key = this.getDigestKey(userId, frequency);
        const entry: DigestEntry = {
            notificationId: notification.notificationId,
            eventType: notification.eventType,
            title: notification.title,
            message: notification.message,
            createdAt: notification.createdAt.toISOString(),
            data: notification.data,
        };

        try {
            await redis.rpush(key, JSON.stringify(entry));
            await redis.expire(key, REDIS_TTL.DIGEST_QUEUE);

            logger.debug('Notification queued for digest', {
                userId,
                notificationId: notification.notificationId,
                frequency,
            });
        } catch (error) {
            logger.error('Failed to queue notification for digest', {
                userId,
                notificationId: notification.notificationId,
                error,
            });
        }
    }

    /**
     * Get pending digest count for user
     */
    async getPendingCount(userId: string, frequency: DigestFrequency): Promise<number> {
        const key = this.getDigestKey(userId, frequency);
        try {
            return await redis.llen(key);
        } catch {
            return 0;
        }
    }

    /**
     * Process and send digests
     */
    private async processDigests(): Promise<void> {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        const currentDayOfWeek = now.getDay();

        // Find users with digest preferences that match current time
        const users = await this.findUsersForDigest(currentHour, currentMinute, currentDayOfWeek);

        for (const user of users) {
            try {
                await this.sendDigestForUser(user.userId, user.frequency);
            } catch (error) {
                logger.error('Failed to send digest for user', {
                    userId: user.userId,
                    frequency: user.frequency,
                    error,
                });
            }
        }
    }

    /**
     * Find users who should receive digest at current time
     */
    private async findUsersForDigest(
        currentHour: number,
        currentMinute: number,
        currentDayOfWeek: number
    ): Promise<Array<{ userId: string; frequency: DigestFrequency }>> {
        const result: Array<{ userId: string; frequency: DigestFrequency }> = [];

        // Only check near the start of each hour
        if (currentMinute > 5) return result;

        try {
            // Find users with digest enabled at this hour
            const preferences = await UserPreferences.find({
                'channels.email.digestEnabled': true,
            }).lean();

            for (const pref of preferences) {
                const digestTime = pref.channels?.email?.digestTime ?? '09:00';
                const [prefHour] = digestTime.split(':').map(Number);
                const frequency = pref.channels?.email?.digestFrequency as DigestFrequency ?? 'daily';

                // Check if this is the right time
                let shouldSend = false;

                switch (frequency) {
                    case 'hourly':
                        shouldSend = currentMinute === 0; // Top of every hour
                        break;
                    case 'daily':
                        shouldSend = prefHour === currentHour;
                        break;
                    case 'weekly':
                        // Send on Mondays at the configured time
                        shouldSend = currentDayOfWeek === 1 && prefHour === currentHour;
                        break;
                }

                if (shouldSend) {
                    // Check if we have pending notifications
                    const pendingCount = await this.getPendingCount(pref.userId, frequency);
                    if (pendingCount > 0) {
                        result.push({ userId: pref.userId, frequency });
                    }
                }
            }
        } catch (error) {
            logger.error('Error finding users for digest', { error });
        }

        return result;
    }

    /**
     * Send digest email for a user
     */
    private async sendDigestForUser(userId: string, frequency: DigestFrequency): Promise<void> {
        const key = this.getDigestKey(userId, frequency);

        // Get all pending notifications
        const entries = await redis.lrange(key, 0, -1);
        if (entries.length === 0) return;

        const notifications: DigestEntry[] = entries.map((e) => JSON.parse(e));

        // Get user preferences for email
        const preferences = await UserPreferences.findByUserId(userId);
        if (!preferences) {
            logger.warn('User preferences not found for digest', { userId });
            return;
        }

        const email = preferences.getDecryptedEmail();
        if (!email) {
            logger.warn('No email found for digest', { userId });
            return;
        }

        // Convert to NotificationPayload format
        const payloads: NotificationPayload[] = notifications.map((n) => ({
            notificationId: n.notificationId,
            userId,
            eventType: n.eventType as NotificationPayload['eventType'],
            title: n.title,
            message: n.message,
            data: n.data,
            priority: 'low' as const,
            channels: ['email'],
            createdAt: new Date(n.createdAt),
        }));

        // Send digest email
        const result = await emailHandler.sendDigest(
            email,
            undefined, // toName
            payloads,
            frequency
        );

        if (result.status === 'sent') {
            // Clear the digest queue
            await redis.del(key);

            logger.info('Digest sent successfully', {
                userId,
                frequency,
                notificationCount: notifications.length,
            });

            // Store digest notification in database
            for (const notification of notifications) {
                await NotificationEvent.update(
                    { deliveryStatus: 'delivered' },
                    { where: { notificationId: notification.notificationId } }
                );
            }
        } else {
            logger.warn('Digest send failed', {
                userId,
                frequency,
                error: result.error,
            });
        }
    }

    /**
     * Get Redis key for digest queue
     */
    private getDigestKey(userId: string, frequency: DigestFrequency): string {
        switch (frequency) {
            case 'hourly':
                return REDIS_KEYS.DIGEST_HOURLY(userId);
            case 'daily':
                return REDIS_KEYS.DIGEST_DAILY(userId);
            case 'weekly':
                return REDIS_KEYS.DIGEST_WEEKLY(userId);
            default:
                return REDIS_KEYS.DIGEST_DAILY(userId);
        }
    }

    /**
     * Force send digest for a user (admin operation)
     */
    async forceSendDigest(userId: string): Promise<boolean> {
        const preferences = await UserPreferences.findByUserId(userId);
        if (!preferences) return false;

        const frequency = preferences.channels?.email?.digestFrequency as DigestFrequency ?? 'daily';
        await this.sendDigestForUser(userId, frequency);
        return true;
    }

    /**
     * Clear pending digest for a user
     */
    async clearDigest(userId: string, frequency?: DigestFrequency): Promise<void> {
        const frequencies: DigestFrequency[] = frequency
            ? [frequency]
            : ['hourly', 'daily', 'weekly'];

        for (const freq of frequencies) {
            const key = this.getDigestKey(userId, freq);
            await redis.del(key);
        }

        logger.info('Digest cleared', { userId, frequencies });
    }
}

// Export singleton
export const digestService = new DigestService();
