/**
 * Banking Notification Service - Main Application Entry Point
 * 
 * Multi-channel notification service for real-time and asynchronous
 * delivery via WebSocket, SMS (Twilio), Email (SendGrid), and Push (Firebase).
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config/config';
import { initializeDatabase, closeDatabase, initializeMongoDB, closeMongoDB } from './models';
import { initializeRedis, closeRedis } from './redis/client';
import { notificationRoutes, preferencesRoutes, adminRoutes } from './routes';
import { errorHandler, notFoundHandler } from './middleware';
import { logger, createRequestLogData } from './utils/logger';
import { kafkaEventConsumer, retryService, digestService } from './services';

// Create Express app
const app = express();

// Trust proxy for X-Forwarded-* headers
app.set('trust proxy', 1);

// ==================== SECURITY MIDDLEWARE ====================

// Helmet for security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// CORS configuration
app.use(cors({
    origin: config.isProduction()
        ? process.env['ALLOWED_ORIGINS']?.split(',') ?? []
        : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'X-API-Key', 'X-User-ID'],
    credentials: true,
    maxAge: 86400,
}));

// Compression
app.use(compression());

// Body parsing
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ==================== REQUEST LOGGING ====================

// Add correlation ID to each request
app.use((req, _res, next) => {
    const correlationId = req.headers['x-correlation-id'] as string ?? uuidv4();
    req.correlationId = correlationId;
    next();
});

// Request logging
app.use((req, res, next) => {
    const startTime = Date.now();
    const correlationId = req.correlationId ?? '';

    res.on('finish', () => {
        const responseTime = Date.now() - startTime;
        const logData = createRequestLogData(
            req.method,
            req.originalUrl,
            res.statusCode,
            responseTime,
            req.ip ?? '0.0.0.0',
            correlationId
        );

        if (res.statusCode >= 500) {
            logger.error('Request completed', logData);
        } else if (res.statusCode >= 400) {
            logger.warn('Request completed', logData);
        } else {
            logger.info('Request completed', logData);
        }
    });

    next();
});

// ==================== ROUTES ====================

// API routes
app.use('/api/notifications', notificationRoutes);
app.use('/api/preferences', preferencesRoutes);
app.use('/api/admin', adminRoutes);

// Health check endpoint
app.get('/health', (_req, res) => {
    res.json({
        status: 'healthy',
        service: 'banking-notification-service',
        timestamp: new Date().toISOString(),
        version: process.env['npm_package_version'] ?? '1.0.0',
    });
});

// Readiness check (includes dependency checks)
app.get('/ready', async (_req, res) => {
    try {
        // Quick checks for dependencies
        const { sequelize } = await import('./models/postgres/database');
        await sequelize.authenticate();

        res.json({
            status: 'ready',
            service: 'banking-notification-service',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        res.status(503).json({
            status: 'not_ready',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// ==================== GRACEFUL SHUTDOWN ====================

async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    // Stop accepting new connections
    server.close(async () => {
        logger.info('HTTP server closed');

        try {
            // Stop Kafka consumer
            await kafkaEventConsumer.stop();

            // Stop background services
            await retryService.stop();
            await digestService.stop();

            // Close database connections
            await closeDatabase();
            await closeMongoDB();
            await closeRedis();

            logger.info('Graceful shutdown complete');
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown', { error });
            process.exit(1);
        }
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
}

// ==================== STARTUP ====================

let server: ReturnType<typeof app.listen>;

async function start(): Promise<void> {
    try {
        logger.info('Starting Banking Notification Service...');

        // Initialize databases
        await initializeDatabase();
        await initializeMongoDB();
        await initializeRedis();

        // Start Kafka consumer
        await kafkaEventConsumer.start();

        // Start background services
        await retryService.start();
        await digestService.start();

        // Start HTTP server
        server = app.listen(config.port, config.host, () => {
            logger.info('Banking Notification Service started', {
                port: config.port,
                host: config.host,
                environment: config.nodeEnv,
            });
        });

        // Tuning for Load Balancer compatibility (e.g., AWS ALB, Nginx)
        server.keepAliveTimeout = 65000; // 65 seconds
        server.headersTimeout = 66000;   // 66 seconds

        // Handle graceful shutdown
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

        // Handle unhandled rejections
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection', { reason, promise });
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception', { error });
            shutdown('uncaughtException');
        });

    } catch (error) {
        logger.error('Failed to start server', { error });
        process.exit(1);
    }
}

// Start the application
start();

export default app;
