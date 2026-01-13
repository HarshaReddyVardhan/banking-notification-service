/**
 * Banking Notification Service - Kafka Event Publisher
 * 
 * Publishes notification events to Kafka for audit and analytics.
 */

import { Kafka, Producer, Partitioners, CompressionTypes } from 'kafkajs';
import { config } from '../config/config';
import { logger } from '../utils/logger';
import { NotificationPayload, DeliveryResult } from '../types';

/**
 * Notification event types for publishing
 */
export type NotificationEventType =
    | 'notification.sent'
    | 'notification.delivered'
    | 'notification.failed'
    | 'notification.read'
    | 'notification.retry.scheduled'
    | 'notification.dlq.moved';

/**
 * Notification event structure
 */
interface NotificationEvent {
    eventType: NotificationEventType;
    timestamp: string;
    service: string;
    version: string;
    correlationId?: string;
    payload: Record<string, unknown>;
}

/**
 * Kafka Event Publisher for notification events
 */
export class NotificationEventPublisher {
    private kafka: Kafka;
    private producer: Producer | null = null;
    private isConnected: boolean = false;
    private readonly serviceName = 'banking-notification-service';
    private readonly eventVersion = '1.0';

    constructor() {
        this.kafka = new Kafka({
            clientId: config.kafka.clientId,
            brokers: config.kafka.brokers,
            retry: {
                initialRetryTime: 100,
                retries: 5,
            },
        });
    }

    /**
     * Initialize and connect the producer
     */
    async connect(): Promise<void> {
        if (this.isConnected) return;

        try {
            this.producer = this.kafka.producer({
                createPartitioner: Partitioners.DefaultPartitioner,
                allowAutoTopicCreation: true,
                transactionTimeout: 30000,
            });

            await this.producer.connect();
            this.isConnected = true;
            logger.info('Kafka notification producer connected');
        } catch (error) {
            logger.error('Failed to connect Kafka producer', { error });
        }
    }

    /**
     * Disconnect the producer
     */
    async disconnect(): Promise<void> {
        if (this.producer && this.isConnected) {
            await this.producer.disconnect();
            this.isConnected = false;
            logger.info('Kafka notification producer disconnected');
        }
    }

    /**
     * Publish notification sent event
     */
    async publishNotificationSent(
        notification: NotificationPayload,
        results: DeliveryResult[]
    ): Promise<void> {
        await this.publish('notification.sent', {
            notificationId: notification.notificationId,
            userId: notification.userId,
            eventType: notification.eventType,
            channels: results.map((r) => ({
                channel: r.channel,
                status: r.status,
                providerMessageId: r.providerMessageId,
            })),
            priority: notification.priority,
            sentAt: new Date().toISOString(),
        }, notification.correlationId);
    }

    /**
     * Publish notification delivery confirmation
     */
    async publishNotificationDelivered(
        notificationId: string,
        userId: string,
        channel: string,
        providerMessageId?: string
    ): Promise<void> {
        await this.publish('notification.delivered', {
            notificationId,
            userId,
            channel,
            providerMessageId,
            deliveredAt: new Date().toISOString(),
        });
    }

    /**
     * Publish notification failure
     */
    async publishNotificationFailed(
        notificationId: string,
        userId: string,
        channel: string,
        error: string,
        retryCount: number
    ): Promise<void> {
        await this.publish('notification.failed', {
            notificationId,
            userId,
            channel,
            error,
            retryCount,
            failedAt: new Date().toISOString(),
        });
    }

    /**
     * Publish notification read event
     */
    async publishNotificationRead(
        notificationId: string,
        userId: string
    ): Promise<void> {
        await this.publish('notification.read', {
            notificationId,
            userId,
            readAt: new Date().toISOString(),
        });
    }

    /**
     * Publish a notification event
     */
    private async publish(
        eventType: NotificationEventType,
        payload: Record<string, unknown>,
        correlationId?: string
    ): Promise<void> {
        if (!this.producer || !this.isConnected) {
            logger.debug('Notification event (Kafka offline)', {
                eventType,
                ...payload,
            });
            return;
        }

        const event: NotificationEvent = {
            eventType,
            timestamp: new Date().toISOString(),
            service: this.serviceName,
            version: this.eventVersion,
            correlationId,
            payload,
        };

        try {
            await this.producer.send({
                topic: config.kafka.topics.notification,
                compression: CompressionTypes.GZIP,
                messages: [
                    {
                        key: payload['userId'] as string | undefined ?? eventType,
                        value: JSON.stringify(event),
                        headers: {
                            'event-type': eventType,
                            'event-version': this.eventVersion,
                            'source-service': this.serviceName,
                        },
                    },
                ],
            });

            logger.debug('Notification event published', { eventType, correlationId });
        } catch (error) {
            logger.error('Failed to publish notification event', {
                eventType,
                error,
            });
        }
    }
}

// Export singleton
export const notificationEventPublisher = new NotificationEventPublisher();
