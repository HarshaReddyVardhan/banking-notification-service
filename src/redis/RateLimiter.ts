/**
 * Banking Notification Service - Rate Limiter
 * 
 * Enforces per-user rate limits across notification channels
 * using Redis counters with automatic TTL expiration.
 */

import { redis, REDIS_KEYS, REDIS_TTL } from './client';
import { config } from '../config/config';
import { logger } from '../utils/logger';
import { NotificationChannel } from '../types';

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    limit: number;
    resetAt: Date;
    waitMs?: number;
}

export interface UserRateLimits {
    smsPerHour: number;
    smsPerDay: number;
    emailPerHour: number;
    emailPerDay: number;
    pushPerHour: number;
    pushPerDay: number;
}

export class RateLimiter {
    private defaultLimits: UserRateLimits;

    constructor() {
        this.defaultLimits = {
            smsPerHour: config.rateLimit.sms.perHour,
            smsPerDay: config.rateLimit.sms.perDay,
            emailPerHour: config.rateLimit.email.perHour,
            emailPerDay: config.rateLimit.email.perDay,
            pushPerHour: config.rateLimit.push.perHour,
            pushPerDay: config.rateLimit.push.perDay,
        };
    }

    /**
     * Check if a notification can be sent (doesn't increment counter)
     */
    async checkLimit(
        userId: string,
        channel: NotificationChannel,
        userLimits?: Partial<UserRateLimits>
    ): Promise<RateLimitResult> {
        if (channel === 'websocket') {
            // WebSocket has no rate limit (internal, free)
            return { allowed: true, remaining: -1, limit: -1, resetAt: new Date() };
        }

        const limits = { ...this.defaultLimits, ...userLimits };
        const { hourKey, dayKey, hourLimit, dayLimit } = this.getChannelKeys(userId, channel, limits);

        try {
            const [hourCount, dayCount] = await Promise.all([
                redis.get(hourKey),
                redis.get(dayKey),
            ]);

            const currentHour = parseInt(hourCount ?? '0', 10);
            const currentDay = parseInt(dayCount ?? '0', 10);

            // Check hourly limit first (more restrictive)
            if (currentHour >= hourLimit) {
                const hourTTL = await redis.ttl(hourKey);
                return {
                    allowed: false,
                    remaining: 0,
                    limit: hourLimit,
                    resetAt: new Date(Date.now() + (hourTTL > 0 ? hourTTL * 1000 : REDIS_TTL.RATE_LIMIT_HOUR * 1000)),
                    waitMs: hourTTL > 0 ? hourTTL * 1000 : REDIS_TTL.RATE_LIMIT_HOUR * 1000,
                };
            }

            // Check daily limit
            if (currentDay >= dayLimit) {
                const dayTTL = await redis.ttl(dayKey);
                return {
                    allowed: false,
                    remaining: 0,
                    limit: dayLimit,
                    resetAt: new Date(Date.now() + (dayTTL > 0 ? dayTTL * 1000 : REDIS_TTL.RATE_LIMIT_DAY * 1000)),
                    waitMs: dayTTL > 0 ? dayTTL * 1000 : REDIS_TTL.RATE_LIMIT_DAY * 1000,
                };
            }

            const remaining = Math.min(hourLimit - currentHour, dayLimit - currentDay);
            const hourTTL = await redis.ttl(hourKey);

            return {
                allowed: true,
                remaining,
                limit: hourLimit,
                resetAt: new Date(Date.now() + (hourTTL > 0 ? hourTTL * 1000 : REDIS_TTL.RATE_LIMIT_HOUR * 1000)),
            };
        } catch (error) {
            logger.error('Rate limit check failed', { userId, channel, error });
            // Allow on error to avoid blocking notifications
            return { allowed: true, remaining: -1, limit: -1, resetAt: new Date() };
        }
    }

    /**
     * Increment rate limit counters (call after sending notification)
     */
    async incrementCounter(
        userId: string,
        channel: NotificationChannel,
        userLimits?: Partial<UserRateLimits>
    ): Promise<void> {
        if (channel === 'websocket') return;

        const limits = { ...this.defaultLimits, ...userLimits };
        const { hourKey, dayKey } = this.getChannelKeys(userId, channel, limits);

        try {
            const pipeline = redis.pipeline();

            // Increment hourly counter with TTL
            pipeline.incr(hourKey);
            pipeline.expire(hourKey, REDIS_TTL.RATE_LIMIT_HOUR);

            // Increment daily counter with TTL
            pipeline.incr(dayKey);
            pipeline.expire(dayKey, REDIS_TTL.RATE_LIMIT_DAY);

            await pipeline.exec();
        } catch (error) {
            logger.error('Rate limit increment failed', { userId, channel, error });
        }
    }

    /**
     * Consume rate limit (check + increment atomically)
     */
    async consumeLimit(
        userId: string,
        channel: NotificationChannel,
        userLimits?: Partial<UserRateLimits>
    ): Promise<RateLimitResult> {
        if (channel === 'websocket') {
            return { allowed: true, remaining: -1, limit: -1, resetAt: new Date() };
        }

        const limits = { ...this.defaultLimits, ...userLimits };
        const { hourKey, dayKey, hourLimit, dayLimit } = this.getChannelKeys(userId, channel, limits);

        try {
            // Use Lua script for atomic check-and-increment
            const luaScript = `
                local hourKey = KEYS[1]
                local dayKey = KEYS[2]
                local hourLimit = tonumber(ARGV[1])
                local dayLimit = tonumber(ARGV[2])
                local hourTTL = tonumber(ARGV[3])
                local dayTTL = tonumber(ARGV[4])
                
                local hourCount = tonumber(redis.call('GET', hourKey) or '0')
                local dayCount = tonumber(redis.call('GET', dayKey) or '0')
                
                if hourCount >= hourLimit then
                    return {0, hourCount, hourLimit, redis.call('TTL', hourKey)}
                end
                
                if dayCount >= dayLimit then
                    return {0, dayCount, dayLimit, redis.call('TTL', dayKey)}
                end
                
                redis.call('INCR', hourKey)
                redis.call('EXPIRE', hourKey, hourTTL)
                redis.call('INCR', dayKey)
                redis.call('EXPIRE', dayKey, dayTTL)
                
                local remaining = math.min(hourLimit - hourCount - 1, dayLimit - dayCount - 1)
                return {1, remaining, hourLimit, redis.call('TTL', hourKey)}
            `;

            const result = await redis.eval(
                luaScript,
                2,
                hourKey,
                dayKey,
                hourLimit,
                dayLimit,
                REDIS_TTL.RATE_LIMIT_HOUR,
                REDIS_TTL.RATE_LIMIT_DAY
            ) as [number, number, number, number];

            const [allowed, remaining, limit, ttl] = result;

            return {
                allowed: allowed === 1,
                remaining,
                limit,
                resetAt: new Date(Date.now() + (ttl > 0 ? ttl * 1000 : REDIS_TTL.RATE_LIMIT_HOUR * 1000)),
                waitMs: allowed === 0 ? (ttl > 0 ? ttl * 1000 : REDIS_TTL.RATE_LIMIT_HOUR * 1000) : undefined,
            };
        } catch (error) {
            logger.error('Rate limit consume failed', { userId, channel, error });
            return { allowed: true, remaining: -1, limit: -1, resetAt: new Date() };
        }
    }

    /**
     * Get current usage for a user
     */
    async getUsage(userId: string): Promise<Record<string, { hour: number; day: number }>> {
        const channels: NotificationChannel[] = ['sms', 'email', 'push'];
        const usage: Record<string, { hour: number; day: number }> = {};

        for (const channel of channels) {
            const { hourKey, dayKey } = this.getChannelKeys(userId, channel, this.defaultLimits);
            const [hourCount, dayCount] = await Promise.all([
                redis.get(hourKey),
                redis.get(dayKey),
            ]);
            usage[channel] = {
                hour: parseInt(hourCount ?? '0', 10),
                day: parseInt(dayCount ?? '0', 10),
            };
        }

        return usage;
    }

    /**
     * Reset rate limits for a user (admin operation)
     */
    async resetLimits(userId: string, channel?: NotificationChannel): Promise<void> {
        const channels: NotificationChannel[] = channel ? [channel] : ['sms', 'email', 'push'];

        const keys: string[] = [];
        for (const ch of channels) {
            const { hourKey, dayKey } = this.getChannelKeys(userId, ch, this.defaultLimits);
            keys.push(hourKey, dayKey);
        }

        if (keys.length > 0) {
            await redis.del(...keys);
            logger.info('Rate limits reset', { userId, channels });
        }
    }

    /**
     * Get Redis keys and limits for a channel
     */
    private getChannelKeys(
        userId: string,
        channel: NotificationChannel,
        limits: UserRateLimits
    ): { hourKey: string; dayKey: string; hourLimit: number; dayLimit: number } {
        switch (channel) {
            case 'sms':
                return {
                    hourKey: REDIS_KEYS.RATE_LIMIT_SMS_HOUR(userId),
                    dayKey: REDIS_KEYS.RATE_LIMIT_SMS_DAY(userId),
                    hourLimit: limits.smsPerHour,
                    dayLimit: limits.smsPerDay,
                };
            case 'email':
                return {
                    hourKey: REDIS_KEYS.RATE_LIMIT_EMAIL_HOUR(userId),
                    dayKey: REDIS_KEYS.RATE_LIMIT_EMAIL_DAY(userId),
                    hourLimit: limits.emailPerHour,
                    dayLimit: limits.emailPerDay,
                };
            case 'push':
                return {
                    hourKey: REDIS_KEYS.RATE_LIMIT_PUSH_HOUR(userId),
                    dayKey: REDIS_KEYS.RATE_LIMIT_PUSH_DAY(userId),
                    hourLimit: limits.pushPerHour,
                    dayLimit: limits.pushPerDay,
                };
            default:
                throw new Error(`Unknown channel: ${channel}`);
        }
    }

    /**
     * Close Redis connection
     */
    async close(): Promise<void> {
        // Redis client is shared, don't close here
    }
}

// Export singleton
export const rateLimiter = new RateLimiter();
