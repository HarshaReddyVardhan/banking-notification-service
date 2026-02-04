/**
 * Banking Notification Service - Deduplication Service
 * 
 * Prevents duplicate notifications using Redis-based sliding window.
 * Uses idempotency keys to ensure same event isn't notified twice.
 */

import { redis, REDIS_KEYS } from './client';
import { config } from '../config/config';
import { logger } from '../utils/logger';
import { NotificationEventType } from '../types';

export interface DedupResult {
    isDuplicate: boolean;
    originalNotificationId?: string;
    lastSentAt?: Date;
}

export class DeduplicationService {
    private defaultWindowMs: number;

    constructor() {
        this.defaultWindowMs = config.notification.dedupWindowMs;
    }

    /**
     * Generate deduplication key
     */
    private generateKey(
        userId: string,
        eventType: NotificationEventType,
        sourceId?: string
    ): string {
        const source = sourceId ?? 'none';
        return REDIS_KEYS.DEDUP(userId, eventType, source);
    }

    /**
     * Check if notification is a duplicate
     */
    async checkDuplicate(
        userId: string,
        eventType: NotificationEventType,
        sourceId?: string
    ): Promise<DedupResult> {
        const key = this.generateKey(userId, eventType, sourceId);

        try {
            const existing = await redis.get(key);

            if (existing) {
                const data = JSON.parse(existing);
                return {
                    isDuplicate: true,
                    originalNotificationId: data.notificationId,
                    lastSentAt: new Date(data.sentAt),
                };
            }

            return { isDuplicate: false };
        } catch (error) {
            logger.error('Deduplication check failed', { userId, eventType, sourceId, error });
            // Return not duplicate on error to avoid blocking
            return { isDuplicate: false };
        }
    }

    /**
     * Mark notification as sent (for deduplication)
     */
    async markSent(
        userId: string,
        eventType: NotificationEventType,
        sourceId: string | undefined,
        notificationId: string,
        windowMs?: number
    ): Promise<void> {
        const key = this.generateKey(userId, eventType, sourceId);
        const ttlSeconds = Math.ceil((windowMs ?? this.defaultWindowMs) / 1000);

        try {
            const data = JSON.stringify({
                notificationId,
                sentAt: new Date().toISOString(),
            });

            await redis.setex(key, ttlSeconds, data);
        } catch (error) {
            logger.error('Deduplication mark failed', { userId, eventType, sourceId, error });
        }
    }

    /**
     * Check and mark atomically using Lua script
     */
    async checkAndMark(
        userId: string,
        eventType: NotificationEventType,
        sourceId: string | undefined,
        notificationId: string,
        windowMs?: number
    ): Promise<DedupResult> {
        const key = this.generateKey(userId, eventType, sourceId);
        const ttlSeconds = Math.ceil((windowMs ?? this.defaultWindowMs) / 1000);

        try {
            const luaScript = `
                local key = KEYS[1]
                local data = ARGV[1]
                local ttl = tonumber(ARGV[2])
                
                local existing = redis.call('GET', key)
                
                if existing then
                    return existing
                end
                
                redis.call('SETEX', key, ttl, data)
                return nil
            `;

            const newData = JSON.stringify({
                notificationId,
                sentAt: new Date().toISOString(),
            });

            const result = await redis.eval(luaScript, 1, key, newData, ttlSeconds) as string | null;

            if (result) {
                const data = JSON.parse(result);
                return {
                    isDuplicate: true,
                    originalNotificationId: data.notificationId,
                    lastSentAt: new Date(data.sentAt),
                };
            }

            return { isDuplicate: false };
        } catch (error) {
            logger.error('Deduplication check-and-mark failed', { userId, eventType, sourceId, error });
            return { isDuplicate: false };
        }
    }

    /**
     * Clear deduplication entry (for retries)
     */
    async clearEntry(
        userId: string,
        eventType: NotificationEventType,
        sourceId?: string
    ): Promise<void> {
        const key = this.generateKey(userId, eventType, sourceId);

        try {
            await redis.del(key);
        } catch (error) {
            logger.error('Deduplication clear failed', { userId, eventType, sourceId, error });
        }
    }

    /**
     * Get TTL for an entry (for debugging)
     */
    async getEntryTTL(
        userId: string,
        eventType: NotificationEventType,
        sourceId?: string
    ): Promise<number> {
        const key = this.generateKey(userId, eventType, sourceId);

        try {
            return await redis.ttl(key);
        } catch {
            return -1;
        }
    }
}

// Export singleton
export const deduplicationService = new DeduplicationService();
