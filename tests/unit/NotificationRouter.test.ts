/**
 * Unit Tests - Notification Router
 * 
 * Tests for the core notification routing logic.
 */

import { NotificationRouter } from '../../src/services/NotificationRouter';
import { EVENT_TYPE_CONFIGS } from '../../src/types';

// Mock dependencies
jest.mock('../../src/models', () => ({
    UserPreferences: {
        findOrCreateByUserId: jest.fn().mockResolvedValue({
            userId: 'test-user-id',
            channels: {
                websocket: { enabled: true },
                sms: { enabled: true, phoneNumber: 'encrypted', verifiedAt: new Date() },
                email: { enabled: true, address: 'encrypted', verifiedAt: new Date() },
                push: { enabled: true, devices: [{ token: 'test-token', platform: 'ios' }] },
            },
            notificationTypes: new Map(),
            quietHours: { enabled: false },
            rateLimits: {},
            doNotContact: { enabled: false },
            getEnabledChannelsForEvent: jest.fn().mockReturnValue(['websocket', 'push']),
            isInQuietHours: jest.fn().mockReturnValue(false),
            shouldBypassQuietHours: jest.fn().mockReturnValue(false),
            isChannelEnabled: jest.fn().mockReturnValue(true),
            getDecryptedPhoneNumber: jest.fn().mockReturnValue('+15551234567'),
            getDecryptedEmail: jest.fn().mockReturnValue('test@example.com'),
        }),
    },
    NotificationEvent: {
        create: jest.fn().mockResolvedValue({}),
    },
}));

jest.mock('../../src/redis/RateLimiter', () => ({
    rateLimiter: {
        consumeLimit: jest.fn().mockResolvedValue({
            allowed: true,
            remaining: 10,
            limit: 50,
            resetAt: new Date(),
        }),
    },
}));

jest.mock('../../src/redis/DeduplicationService', () => ({
    deduplicationService: {
        checkAndMark: jest.fn().mockResolvedValue({
            isDuplicate: false,
        }),
    },
}));

describe('NotificationRouter', () => {
    let router: NotificationRouter;

    beforeEach(() => {
        router = new NotificationRouter();
        jest.clearAllMocks();
    });

    describe('route()', () => {
        it('should route notification successfully', async () => {
            const result = await router.route({
                userId: 'test-user-id',
                eventType: 'transfer_completed',
                title: 'Transfer Complete',
                message: 'Your transfer was successful',
                eventSourceId: 'txn-123',
                priority: 'high',
            });

            expect(result.notificationId).toBeDefined();
            expect(result.userId).toBe('test-user-id');
            expect(result.eventType).toBe('transfer_completed');
            expect(result.queued).toBe(false);
            expect(result.digestQueued).toBe(false);
        });

        it('should skip duplicate notifications', async () => {
            const { deduplicationService } = require('../../src/redis/DeduplicationService');
            deduplicationService.checkAndMark.mockResolvedValueOnce({
                isDuplicate: true,
                originalNotificationId: 'orig-123',
            });

            const result = await router.route({
                userId: 'test-user-id',
                eventType: 'transfer_completed',
                title: 'Transfer Complete',
                message: 'Your transfer was successful',
            });

            expect(result.skippedChannels).toHaveLength(1);
            expect(result.skippedChannels[0]?.reason).toContain('Duplicate');
        });

        it('should skip notifications for do-not-contact users', async () => {
            const { UserPreferences } = require('../../src/models');
            UserPreferences.findOrCreateByUserId.mockResolvedValueOnce({
                userId: 'test-user-id',
                doNotContact: { enabled: true },
                channels: {},
                notificationTypes: new Map(),
                quietHours: {},
                rateLimits: {},
                getEnabledChannelsForEvent: jest.fn().mockReturnValue([]),
                isInQuietHours: jest.fn().mockReturnValue(false),
            });

            const result = await router.route({
                userId: 'test-user-id',
                eventType: 'transfer_completed',
                title: 'Transfer Complete',
                message: 'Your transfer was successful',
            });

            expect(result.skippedChannels).toHaveLength(1);
            expect(result.skippedChannels[0]?.reason).toContain('opted out');
        });
    });

    describe('EVENT_TYPE_CONFIGS', () => {
        it('should have configurations for all event types', () => {
            expect(EVENT_TYPE_CONFIGS.transfer_completed).toBeDefined();
            expect(EVENT_TYPE_CONFIGS.fraud_detected).toBeDefined();
            expect(EVENT_TYPE_CONFIGS.account_locked).toBeDefined();
        });

        it('should have correct priority for critical events', () => {
            expect(EVENT_TYPE_CONFIGS.fraud_detected.priority).toBe('critical');
            expect(EVENT_TYPE_CONFIGS.account_locked.priority).toBe('critical');
            expect(EVENT_TYPE_CONFIGS.suspicious_activity.priority).toBe('critical');
        });

        it('should bypass quiet hours for critical events', () => {
            expect(EVENT_TYPE_CONFIGS.fraud_detected.bypassQuietHours).toBe(true);
            expect(EVENT_TYPE_CONFIGS.account_locked.bypassQuietHours).toBe(true);
        });
    });
});
