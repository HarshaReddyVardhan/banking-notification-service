/**
 * Banking Notification Service - Redis Client
 * 
 * Shared Redis connection for rate limiting, queuing, and caching.
 */

import Redis, { RedisOptions } from 'ioredis';
import { config } from '../config/config';
import { logger } from '../utils/logger';

// Build Redis options
const redisOptions: RedisOptions = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    tls: config.redis.tls ? {} : undefined,
    retryStrategy: (times: number) => {
        const delay = Math.min(times * 100, 3000);
        logger.warn(`Redis reconnecting, attempt ${times}`, { delay });
        return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
};

// Create Redis client
export const redis = new Redis(redisOptions);

// Connection event handlers
redis.on('connect', () => {
    logger.info('Redis client connected');
});

redis.on('ready', () => {
    logger.info('Redis client ready');
});

redis.on('error', (err) => {
    logger.error('Redis client error', { error: err.message });
});

redis.on('close', () => {
    logger.warn('Redis connection closed');
});

/**
 * Initialize Redis connection
 */
export async function initializeRedis(): Promise<void> {
    try {
        await redis.connect();
        await redis.ping();
        logger.info('Redis connection established', {
            host: config.redis.host,
            port: config.redis.port,
        });
    } catch (error) {
        logger.error('Failed to connect to Redis', { error });
        throw error;
    }
}

/**
 * Close Redis connection gracefully
 */
export async function closeRedis(): Promise<void> {
    try {
        await redis.quit();
        logger.info('Redis connection closed');
    } catch (error) {
        logger.error('Error closing Redis connection', { error });
    }
}

// Key prefixes for namespacing
export const REDIS_KEYS = {
    // Rate limiting
    RATE_LIMIT_SMS_HOUR: (userId: string) => `ratelimit:sms:hour:${userId}`,
    RATE_LIMIT_SMS_DAY: (userId: string) => `ratelimit:sms:day:${userId}`,
    RATE_LIMIT_EMAIL_HOUR: (userId: string) => `ratelimit:email:hour:${userId}`,
    RATE_LIMIT_EMAIL_DAY: (userId: string) => `ratelimit:email:day:${userId}`,
    RATE_LIMIT_PUSH_HOUR: (userId: string) => `ratelimit:push:hour:${userId}`,
    RATE_LIMIT_PUSH_DAY: (userId: string) => `ratelimit:push:day:${userId}`,

    // Queues
    QUEUE_SMS: 'queue:sms',
    QUEUE_EMAIL: 'queue:email',
    QUEUE_PUSH: 'queue:push',
    QUEUE_RETRY: 'queue:retry',

    // Deduplication
    DEDUP: (userId: string, eventType: string, sourceId: string) =>
        `dedup:${userId}:${eventType}:${sourceId}`,

    // Digest queues
    DIGEST_HOURLY: (userId: string) => `digest:hourly:${userId}`,
    DIGEST_DAILY: (userId: string) => `digest:daily:${userId}`,
    DIGEST_WEEKLY: (userId: string) => `digest:weekly:${userId}`,

    // WebSocket connection tracking
    WEBSOCKET_USER: (userId: string) => `websocket:user:${userId}`,

    // User preferences cache
    PREFERENCES_CACHE: (userId: string) => `cache:prefs:${userId}`,

    // Delivery tracking
    DELIVERY: (notificationId: string) => `delivery:${notificationId}`,
};

// TTL values in seconds
export const REDIS_TTL = {
    RATE_LIMIT_HOUR: 3600,      // 1 hour
    RATE_LIMIT_DAY: 86400,      // 24 hours
    DEDUP: 300,                  // 5 minutes (default)
    PREFERENCES_CACHE: 300,      // 5 minutes
    DELIVERY_TRACKING: 86400,    // 24 hours
    DIGEST_QUEUE: 604800,        // 7 days
    WEBSOCKET_MAPPING: 3600,     // 1 hour
};
