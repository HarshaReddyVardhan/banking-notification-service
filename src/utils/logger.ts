/**
 * Banking Notification Service - Logger
 * 
 * Structured logging with Winston for production-grade observability.
 * Supports both JSON (production) and pretty (development) formats.
 */

import winston from 'winston';
import { config } from '../config/config';

// Custom log format for development
const devFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} [${level}]: ${message} ${metaStr}`;
    })
);

// JSON format for production
const prodFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Create logger instance
export const logger = winston.createLogger({
    level: config.logging.level,
    format: config.logging.format === 'pretty' ? devFormat : prodFormat,
    defaultMeta: {
        service: config.serviceName,
        environment: config.nodeEnv,
    },
    transports: [
        new winston.transports.Console(),
    ],
});

// Request context for tracking
interface RequestLogData {
    method: string;
    path: string;
    statusCode: number;
    responseTime: number;
    ip: string;
    correlationId: string;
}

export function createRequestLogData(
    method: string,
    path: string,
    statusCode: number,
    responseTime: number,
    ip: string,
    correlationId: string
): RequestLogData {
    return {
        method,
        path,
        statusCode,
        responseTime,
        ip,
        correlationId,
    };
}

// Notification-specific logging
interface NotificationLogData {
    notificationId: string;
    userId: string;
    eventType: string;
    channels: string[];
    status: string;
    correlationId?: string;
    durations?: Record<string, number>;
    error?: string;
}

export function logNotification(data: NotificationLogData): void {
    const level = data.status === 'failed' ? 'error' : 'info';
    logger.log(level, 'Notification processed', data);
}

// Channel-specific logging
interface ChannelLogData {
    channel: 'websocket' | 'sms' | 'email' | 'push';
    notificationId: string;
    userId: string;
    status: 'sent' | 'failed' | 'queued' | 'rate_limited';
    provider?: string;
    providerMessageId?: string;
    latencyMs?: number;
    error?: string;
}

export function logChannelDelivery(data: ChannelLogData): void {
    const level = data.status === 'failed' ? 'error' : 'info';
    logger.log(level, `${data.channel.toUpperCase()} delivery`, data);
}

// Kafka consumer logging
interface KafkaLogData {
    topic: string;
    partition: number;
    offset: string;
    eventType: string;
    processingTimeMs: number;
    status: 'success' | 'failed';
    error?: string;
}

export function logKafkaMessage(data: KafkaLogData): void {
    const level = data.status === 'failed' ? 'error' : 'debug';
    logger.log(level, 'Kafka message processed', data);
}
