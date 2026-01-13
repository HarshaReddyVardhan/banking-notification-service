/**
 * Unit Tests - Rate Limiter
 * 
 * Tests for the Redis-based rate limiting service.
 */

import { RateLimiter } from '../../src/redis/RateLimiter';

// Mock Redis
const mockRedis = {
    get: jest.fn(),
    ttl: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    pipeline: jest.fn().mockReturnValue({
        incr: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
    }),
    eval: jest.fn(),
    del: jest.fn(),
};

jest.mock('../../src/redis/client', () => ({
    redis: mockRedis,
    REDIS_KEYS: {
        RATE_LIMIT_SMS_HOUR: (userId: string) => `ratelimit:sms:hour:${userId}`,
        RATE_LIMIT_SMS_DAY: (userId: string) => `ratelimit:sms:day:${userId}`,
        RATE_LIMIT_EMAIL_HOUR: (userId: string) => `ratelimit:email:hour:${userId}`,
        RATE_LIMIT_EMAIL_DAY: (userId: string) => `ratelimit:email:day:${userId}`,
        RATE_LIMIT_PUSH_HOUR: (userId: string) => `ratelimit:push:hour:${userId}`,
        RATE_LIMIT_PUSH_DAY: (userId: string) => `ratelimit:push:day:${userId}`,
    },
    REDIS_TTL: {
        RATE_LIMIT_HOUR: 3600,
        RATE_LIMIT_DAY: 86400,
    },
}));

jest.mock('../../src/config/config', () => ({
    config: {
        rateLimit: {
            sms: { perHour: 10, perDay: 50 },
            email: { perHour: 20, perDay: 100 },
            push: { perHour: 30, perDay: 200 },
        },
    },
}));

describe('RateLimiter', () => {
    let rateLimiter: RateLimiter;

    beforeEach(() => {
        rateLimiter = new RateLimiter();
        jest.clearAllMocks();
    });

    describe('checkLimit()', () => {
        it('should allow WebSocket without rate limit', async () => {
            const result = await rateLimiter.checkLimit('user-123', 'websocket');

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(-1);
            expect(mockRedis.get).not.toHaveBeenCalled();
        });

        it('should allow SMS when under limit', async () => {
            mockRedis.get.mockResolvedValueOnce('5').mockResolvedValueOnce('20');
            mockRedis.ttl.mockResolvedValue(1800);

            const result = await rateLimiter.checkLimit('user-123', 'sms');

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(5); // 10 - 5 = 5
        });

        it('should deny SMS when hourly limit exceeded', async () => {
            mockRedis.get.mockResolvedValueOnce('10').mockResolvedValueOnce('20');
            mockRedis.ttl.mockResolvedValue(1800);

            const result = await rateLimiter.checkLimit('user-123', 'sms');

            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });

        it('should deny SMS when daily limit exceeded', async () => {
            mockRedis.get.mockResolvedValueOnce('5').mockResolvedValueOnce('50');
            mockRedis.ttl.mockResolvedValue(3600);

            const result = await rateLimiter.checkLimit('user-123', 'sms');

            expect(result.allowed).toBe(false);
        });
    });

    describe('consumeLimit()', () => {
        it('should atomically check and increment', async () => {
            mockRedis.eval.mockResolvedValue([1, 9, 10, 3600]);

            const result = await rateLimiter.consumeLimit('user-123', 'sms');

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(9);
            expect(mockRedis.eval).toHaveBeenCalled();
        });

        it('should return denied when limit reached', async () => {
            mockRedis.eval.mockResolvedValue([0, 10, 10, 1800]);

            const result = await rateLimiter.consumeLimit('user-123', 'sms');

            expect(result.allowed).toBe(false);
            expect(result.waitMs).toBeDefined();
        });
    });

    describe('resetLimits()', () => {
        it('should reset limits for all channels', async () => {
            await rateLimiter.resetLimits('user-123');

            expect(mockRedis.del).toHaveBeenCalledWith(
                expect.stringContaining('sms'),
                expect.stringContaining('sms'),
                expect.stringContaining('email'),
                expect.stringContaining('email'),
                expect.stringContaining('push'),
                expect.stringContaining('push')
            );
        });

        it('should reset limits for specific channel', async () => {
            await rateLimiter.resetLimits('user-123', 'sms');

            expect(mockRedis.del).toHaveBeenCalledWith(
                expect.stringContaining('sms:hour'),
                expect.stringContaining('sms:day')
            );
        });
    });
});
