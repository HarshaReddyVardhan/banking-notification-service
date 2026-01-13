/**
 * Banking Notification Service - Configuration
 * 
 * Centralized configuration management with validation
 * for all service dependencies and external integrations.
 */

// Validation helpers
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function optionalEnv(name: string, defaultValue: string): string {
    return process.env[name] ?? defaultValue;
}

function optionalEnvInt(name: string, defaultValue: number): number {
    const value = process.env[name];
    return value ? parseInt(value, 10) : defaultValue;
}

function optionalEnvBool(name: string, defaultValue: boolean): boolean {
    const value = process.env[name];
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true';
}

export const config = {
    // Server
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    port: optionalEnvInt('PORT', 3003),
    host: optionalEnv('HOST', '0.0.0.0'),
    serviceName: 'banking-notification-service',

    // PostgreSQL (Notification History)
    database: {
        host: requireEnv('DB_HOST'),
        port: optionalEnvInt('DB_PORT', 5432),
        name: requireEnv('DB_NAME'),
        user: requireEnv('DB_USER'),
        password: requireEnv('DB_PASSWORD'),
        ssl: optionalEnvBool('DB_SSL', true),
        sslRejectUnauthorized: optionalEnvBool('DB_SSL_REJECT_UNAUTHORIZED', true),
        pool: {
            min: optionalEnvInt('DB_POOL_MIN', 5),
            max: optionalEnvInt('DB_POOL_MAX', 20),
            acquire: optionalEnvInt('DB_POOL_ACQUIRE', 30000),
            idle: optionalEnvInt('DB_POOL_IDLE', 10000),
        },
    },

    // MongoDB (User Preferences)
    mongodb: {
        url: requireEnv('MONGO_URL'),
        options: {
            maxPoolSize: optionalEnvInt('MONGO_POOL_SIZE', 10),
            serverSelectionTimeoutMS: optionalEnvInt('MONGO_TIMEOUT', 5000),
        },
    },

    // Redis
    redis: {
        host: requireEnv('REDIS_HOST'),
        port: optionalEnvInt('REDIS_PORT', 6379),
        password: process.env['REDIS_PASSWORD'],
        tls: optionalEnvBool('REDIS_TLS', false),
        db: optionalEnvInt('REDIS_DB', 0),
    },

    // Kafka
    kafka: {
        brokers: optionalEnv('KAFKA_BROKERS', 'localhost:9092').split(','),
        clientId: optionalEnv('KAFKA_CLIENT_ID', 'banking-notification-service'),
        groupId: optionalEnv('KAFKA_GROUP_ID', 'notification-service-group'),
        topics: {
            security: optionalEnv('KAFKA_SECURITY_TOPIC', 'security-events'),
            transaction: optionalEnv('KAFKA_TRANSACTION_TOPIC', 'transaction-events'),
            fraud: optionalEnv('KAFKA_FRAUD_TOPIC', 'fraud-events'),
            user: optionalEnv('KAFKA_USER_TOPIC', 'user-events'),
            notification: optionalEnv('KAFKA_NOTIFICATION_TOPIC', 'notification-events'),
        },
    },

    // Twilio (SMS)
    twilio: {
        accountSid: process.env['TWILIO_ACCOUNT_SID'] ?? '',
        authToken: process.env['TWILIO_AUTH_TOKEN'] ?? '',
        phoneNumber: process.env['TWILIO_PHONE_NUMBER'] ?? '',
        enabled: optionalEnvBool('TWILIO_ENABLED', false),
        statusCallbackUrl: process.env['TWILIO_STATUS_CALLBACK_URL'],
    },

    // SendGrid (Email)
    sendgrid: {
        apiKey: process.env['SENDGRID_API_KEY'] ?? '',
        fromEmail: optionalEnv('SENDGRID_FROM_EMAIL', 'notifications@banking.example.com'),
        fromName: optionalEnv('SENDGRID_FROM_NAME', 'Banking App'),
        enabled: optionalEnvBool('SENDGRID_ENABLED', false),
        templates: {
            transactionComplete: optionalEnv('SENDGRID_TEMPLATE_TRANSACTION', ''),
            securityAlert: optionalEnv('SENDGRID_TEMPLATE_SECURITY', ''),
            digest: optionalEnv('SENDGRID_TEMPLATE_DIGEST', ''),
            welcome: optionalEnv('SENDGRID_TEMPLATE_WELCOME', ''),
        },
    },

    // Firebase (Push Notifications)
    firebase: {
        projectId: process.env['FIREBASE_PROJECT_ID'] ?? '',
        privateKeyPath: process.env['FIREBASE_PRIVATE_KEY_PATH'],
        enabled: optionalEnvBool('FIREBASE_ENABLED', false),
    },

    // WebSocket Gateway
    websocket: {
        gatewayUrl: optionalEnv('WEBSOCKET_GATEWAY_URL', 'http://localhost:3001'),
        apiKey: process.env['WEBSOCKET_GATEWAY_API_KEY'] ?? '',
    },

    // Security
    security: {
        fieldEncryptionKey: requireEnv('FIELD_ENCRYPTION_KEY'),
        apiKeyHeader: optionalEnv('API_KEY_HEADER', 'X-API-Key'),
        internalApiKey: process.env['INTERNAL_API_KEY'] ?? '',
        jwtSecret: process.env['JWT_SECRET'] ?? '',
    },

    // Rate Limiting
    rateLimit: {
        windowMs: optionalEnvInt('RATE_LIMIT_WINDOW_MS', 900000),
        maxRequests: optionalEnvInt('RATE_LIMIT_MAX_REQUESTS', 100),
        sms: {
            perHour: optionalEnvInt('SMS_LIMIT_PER_HOUR', 10),
            perDay: optionalEnvInt('SMS_LIMIT_PER_DAY', 50),
        },
        email: {
            perHour: optionalEnvInt('EMAIL_LIMIT_PER_HOUR', 20),
            perDay: optionalEnvInt('EMAIL_LIMIT_PER_DAY', 100),
        },
        push: {
            perHour: optionalEnvInt('PUSH_LIMIT_PER_HOUR', 30),
            perDay: optionalEnvInt('PUSH_LIMIT_PER_DAY', 200),
        },
    },

    // Notification Settings
    notification: {
        dedupWindowMs: optionalEnvInt('DEDUP_WINDOW_MS', 300000), // 5 minutes
        maxRetryAttempts: optionalEnvInt('MAX_RETRY_ATTEMPTS', 5),
        retryInitialDelayMs: optionalEnvInt('RETRY_INITIAL_DELAY_MS', 1000),
        retryMaxDelayMs: optionalEnvInt('RETRY_MAX_DELAY_MS', 3600000), // 1 hour
        digestEnabled: optionalEnvBool('DIGEST_ENABLED', true),
        digestCheckIntervalMs: optionalEnvInt('DIGEST_CHECK_INTERVAL_MS', 60000),
    },

    // Logging
    logging: {
        level: optionalEnv('LOG_LEVEL', 'info'),
        format: optionalEnv('LOG_FORMAT', 'json'),
    },

    // Retry delay schedule (exponential backoff)
    retryDelaySchedule: {
        1: 1000,       // 1 second
        2: 5000,       // 5 seconds
        3: 30000,      // 30 seconds
        4: 300000,     // 5 minutes
        5: 3600000,    // 1 hour
    } as Record<number, number>,

    // Helper methods
    isProduction: (): boolean => config.nodeEnv === 'production',
    isDevelopment: (): boolean => config.nodeEnv === 'development',
};

export type Config = typeof config;
