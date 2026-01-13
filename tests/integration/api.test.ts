/**
 * Integration Tests - API Routes
 * 
 * Tests for the HTTP API endpoints.
 */

import request from 'supertest';
import express from 'express';

// Create minimal test app
const app = express();
app.use(express.json());

// Mock authentication middleware
jest.mock('../../src/middleware/authentication', () => ({
    authenticateInternalApi: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    authenticateUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        req.userId = 'test-user-123';
        next();
    },
    optionalAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    requireUserId: (req: express.Request) => req.userId ?? 'test-user-123',
}));

// Mock services
jest.mock('../../src/services/NotificationRouter', () => ({
    notificationRouter: {
        route: jest.fn().mockResolvedValue({
            notificationId: 'test-notification-123',
            userId: 'test-user-123',
            eventType: 'transfer_completed',
            results: [{ channel: 'websocket', status: 'delivered' }],
            skippedChannels: [],
            queued: false,
            digestQueued: false,
        }),
    },
}));

jest.mock('../../src/models', () => ({
    NotificationEvent: {
        findAndCountAll: jest.fn().mockResolvedValue({
            count: 1,
            rows: [{
                notificationId: 'test-notification-123',
                eventType: 'transfer_completed',
                title: 'Transfer Complete',
                message: 'Your transfer was successful',
                channel: 'websocket',
                deliveryStatus: 'delivered',
                createdAt: new Date(),
            }],
        }),
        findOne: jest.fn().mockResolvedValue({
            notificationId: 'test-notification-123',
            userId: 'test-user-123',
            markRead: jest.fn(),
        }),
        count: jest.fn().mockResolvedValue(5),
        update: jest.fn().mockResolvedValue([3]),
    },
    UserPreferences: {
        findOrCreateByUserId: jest.fn().mockResolvedValue({
            userId: 'test-user-123',
            channels: {
                websocket: { enabled: true },
                sms: { enabled: true },
                email: { enabled: true, digestEnabled: false },
                push: { enabled: true, devices: [] },
            },
            notificationTypes: new Map(),
            quietHours: { enabled: false },
            rateLimits: {},
            doNotContact: { enabled: false },
            save: jest.fn(),
            setEncryptedPhoneNumber: jest.fn(),
            setEncryptedEmail: jest.fn(),
        }),
    },
}));

// Import routes after mocks are set up
import notificationRoutes from '../../src/routes/notificationRoutes';
import preferencesRoutes from '../../src/routes/preferencesRoutes';

app.use('/api/notifications', notificationRoutes);
app.use('/api/preferences', preferencesRoutes);

describe('Notification API', () => {
    describe('POST /api/notifications/send', () => {
        it('should send notification successfully', async () => {
            const response = await request(app)
                .post('/api/notifications/send')
                .send({
                    userId: 'test-user-123',
                    eventType: 'transfer_completed',
                    title: 'Transfer Complete',
                    message: 'Your transfer was successful',
                })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.notificationId).toBeDefined();
        });

        it('should reject invalid request', async () => {
            const response = await request(app)
                .post('/api/notifications/send')
                .send({
                    // Missing required fields
                    title: 'Test',
                })
                .expect(400);

            expect(response.body.success).toBe(false);
        });
    });

    describe('GET /api/notifications/history', () => {
        it('should return notification history', async () => {
            const response = await request(app)
                .get('/api/notifications/history')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.notifications).toBeDefined();
            expect(response.body.data.pagination).toBeDefined();
        });

        it('should support pagination', async () => {
            const response = await request(app)
                .get('/api/notifications/history?page=1&limit=10')
                .expect(200);

            expect(response.body.data.pagination.page).toBe(1);
            expect(response.body.data.pagination.limit).toBe(10);
        });
    });

    describe('GET /api/notifications/unread/count', () => {
        it('should return unread count', async () => {
            const response = await request(app)
                .get('/api/notifications/unread/count')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.unreadCount).toBe(5);
        });
    });
});

describe('Preferences API', () => {
    describe('GET /api/preferences', () => {
        it('should return user preferences', async () => {
            const response = await request(app)
                .get('/api/preferences')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.channels).toBeDefined();
        });
    });

    describe('PUT /api/preferences', () => {
        it('should update preferences', async () => {
            const response = await request(app)
                .put('/api/preferences')
                .send({
                    quietHours: {
                        enabled: true,
                        start: '22:00',
                        end: '07:00',
                    },
                })
                .expect(200);

            expect(response.body.success).toBe(true);
        });

        it('should reject invalid preferences', async () => {
            const response = await request(app)
                .put('/api/preferences')
                .send({
                    quietHours: {
                        start: 'invalid', // Invalid time format
                    },
                })
                .expect(400);

            expect(response.body.success).toBe(false);
        });
    });

    describe('POST /api/preferences/devices', () => {
        it('should register push device', async () => {
            const response = await request(app)
                .post('/api/preferences/devices')
                .send({
                    deviceId: 'device-123',
                    deviceName: 'iPhone 15',
                    token: 'fcm-token-abc123',
                    platform: 'ios',
                })
                .expect(200);

            expect(response.body.success).toBe(true);
        });

        it('should reject invalid platform', async () => {
            const response = await request(app)
                .post('/api/preferences/devices')
                .send({
                    deviceId: 'device-123',
                    token: 'fcm-token-abc123',
                    platform: 'windows', // Invalid
                })
                .expect(400);

            expect(response.body.success).toBe(false);
        });
    });
});
