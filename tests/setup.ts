/**
 * Jest Test Setup
 * 
 * Global setup for all tests including environment variables
 * and mock configurations.
 */

// Set test environment variables
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3003';
process.env['DB_HOST'] = 'localhost';
process.env['DB_PORT'] = '5432';
process.env['DB_NAME'] = 'banking_notifications_test';
process.env['DB_USER'] = 'test_user';
process.env['DB_PASSWORD'] = 'test_password';
process.env['DB_SSL'] = 'false';
process.env['MONGO_URL'] = 'mongodb://localhost:27017/banking_notifications_test';
process.env['REDIS_HOST'] = 'localhost';
process.env['REDIS_PORT'] = '6379';
process.env['REDIS_PASSWORD'] = '';
process.env['KAFKA_BROKERS'] = 'localhost:9092';
process.env['FIELD_ENCRYPTION_KEY'] = '0123456789abcdef0123456789abcdef';
process.env['INTERNAL_API_KEY'] = 'test_api_key';
process.env['TWILIO_ENABLED'] = 'false';
process.env['SENDGRID_ENABLED'] = 'false';
process.env['FIREBASE_ENABLED'] = 'false';
process.env['LOG_LEVEL'] = 'error';

// Global test timeout
jest.setTimeout(10000);

// Mock external services
jest.mock('../src/channels/SMSHandler', () => ({
    smsHandler: {
        send: jest.fn().mockResolvedValue({ channel: 'sms', status: 'sent' }),
        isAvailable: jest.fn().mockReturnValue(true),
    },
    SMSHandler: jest.fn(),
}));

jest.mock('../src/channels/EmailHandler', () => ({
    emailHandler: {
        send: jest.fn().mockResolvedValue({ channel: 'email', status: 'sent' }),
        sendDigest: jest.fn().mockResolvedValue({ channel: 'email', status: 'sent' }),
        isAvailable: jest.fn().mockReturnValue(true),
    },
    EmailHandler: jest.fn(),
}));

jest.mock('../src/channels/PushHandler', () => ({
    pushHandler: {
        send: jest.fn().mockResolvedValue({ channel: 'push', status: 'sent' }),
        isAvailable: jest.fn().mockReturnValue(true),
    },
    PushHandler: jest.fn(),
}));

jest.mock('../src/channels/WebSocketHandler', () => ({
    webSocketHandler: {
        send: jest.fn().mockResolvedValue({ channel: 'websocket', status: 'delivered' }),
        isUserOnline: jest.fn().mockResolvedValue(true),
    },
    WebSocketHandler: jest.fn(),
}));

// Clean up after all tests
afterAll(async () => {
    // Close any open handles
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
});
