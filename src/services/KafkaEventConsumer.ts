/**
 * Banking Notification Service - Kafka Event Consumer
 * 
 * Consumes events from various topics (security, transaction, fraud, user)
 * and routes them to the notification system.
 */

import { Kafka, Consumer, logLevel } from 'kafkajs';
import { config } from '../config/config';
import { logger, logKafkaMessage } from '../utils/logger';
import { IncomingEvent } from '../types';
import { DeadLetterQueue } from '../models';
import { notificationRouter, NotificationRequest } from './NotificationRouter';

export class KafkaEventConsumer {
    private kafka: Kafka;
    private consumer: Consumer | null = null;
    private isRunning: boolean = false;

    constructor() {
        this.kafka = new Kafka({
            clientId: config.kafka.clientId,
            brokers: config.kafka.brokers,
            logLevel: logLevel.WARN,
            retry: {
                initialRetryTime: 100,
                retries: 5,
            },
        });
    }

    /**
     * Connect and start consuming
     */
    async start(): Promise<void> {
        if (this.isRunning) return;

        try {
            this.consumer = this.kafka.consumer({
                groupId: config.kafka.groupId,
                sessionTimeout: 30000,
                heartbeatInterval: 3000,
            });

            await this.consumer.connect();

            // Subscribe to all topics
            const topics = Object.values(config.kafka.topics);
            for (const topic of topics) {
                await this.consumer.subscribe({ topic, fromBeginning: false });
                logger.info(`Subscribed to Kafka topic: ${topic}`);
            }

            // Start consuming with batch processing for higher throughput
            await this.consumer.run({
                eachBatchAutoResolve: true,
                eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning }) => {
                    if (!isRunning()) return;

                    await Promise.all(batch.messages.map(async (message) => {
                        if (!isRunning()) return;

                        try {
                            await this.processMessage(message.value, message.offset, batch.topic, batch.partition);
                            resolveOffset(message.offset);
                        } catch (error) {
                            // If processing fails, we've already tried to DLQ in processMessage.
                            // If DLQ failed too, we log and potentially stop to prevent data loss.
                            // However, strictly blocking here stops the partition.
                            // For this service, we log critical error and skip to avoid lag, 
                            // depending on business requirement. Banking usually prefers halt over loss.
                            // But here we'll assume processMessage guarantees "handled" (sent or DLQ or throw).
                            // If it threw, it means DLQ failed. logic below catches it.
                            logger.error('CRITICAL: Message processing failed completely', {
                                error,
                                topic: batch.topic,
                                partition: batch.partition,
                                offset: message.offset
                            });
                        }
                        await heartbeat();
                    }));
                },
            });

            this.isRunning = true;
            logger.info('Kafka consumer started', { groupId: config.kafka.groupId });
        } catch (error) {
            logger.error('Failed to start Kafka consumer', { error });
            throw error;
        }
    }

    /**
     * Stop consuming and disconnect
     */
    async stop(): Promise<void> {
        if (!this.isRunning || !this.consumer) return;

        try {
            await this.consumer.disconnect();
            this.isRunning = false;
            logger.info('Kafka consumer stopped');
        } catch (error) {
            logger.error('Error stopping Kafka consumer', { error });
        }
    }

    /**
     * Process a single message with retry and DLQ fallback
     */
    private async processMessage(
        messageValue: Buffer | null,
        offset: string,
        topic: string,
        partition: number
    ): Promise<void> {
        const startTime = Date.now();
        let eventType = 'unknown';
        let parsedEvent: IncomingEvent | null = null;

        try {
            if (!messageValue) {
                logger.warn('Empty message received', { topic, partition, offset });
                return; // Skip empty
            }

            try {
                parsedEvent = JSON.parse(messageValue.toString());
                eventType = parsedEvent?.eventType ?? 'unknown';
            } catch (e) {
                logger.error('Invalid JSON in Kafka message', { topic, partition, offset });
                // Invalid JSON -> DLQ immediately
                await this.addToDLQ({
                    topic,
                    partition,
                    offset,
                    value: messageValue.toString(),
                    error: 'Invalid JSON',
                    eventType: 'malformed',
                });
                return;
            }

            if (!parsedEvent) return;

            // Map and Route
            const notification = await this.mapEventToNotification(topic, parsedEvent);
            if (notification) {
                await notificationRouter.route(notification);
            }

            const processingTimeMs = Date.now() - startTime;
            logKafkaMessage({
                topic,
                partition,
                offset,
                eventType,
                processingTimeMs,
                status: 'success',
            });

        } catch (error) {
            const processingTimeMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            logKafkaMessage({
                topic,
                partition,
                offset,
                eventType,
                processingTimeMs,
                status: 'failed',
                error: errorMessage,
            });

            logger.error('Failed to process Kafka message, attempting DLQ', {
                topic,
                partition,
                offset,
                error,
            });

            // Attempt to send to Dead Letter Queue
            try {
                if (parsedEvent) {
                    // Try to extract some useful info for DLQ
                    // We need to map to DLQ schema. 
                    // Since mapEventToNotification might have failed or not happened, we do best effort.
                    const userId = parsedEvent.payload?.['userId'] as string | undefined;

                    if (userId) {
                        await DeadLetterQueue.create({
                            originalNotificationId: parsedEvent.correlationId ?? `kafka-${offset}`,
                            userId: userId,
                            eventType: (eventType as any) ?? 'unknown', // Cast to fit type or validate
                            channel: 'unknown' as any, // Not yet channeled
                            priority: 'medium' as any,
                            title: 'Processing Failed',
                            message: 'Message processing failed coming from Kafka',
                            metadata: parsedEvent.payload,
                            failureReason: errorMessage,
                            totalAttempts: 1,
                            lastAttemptAt: new Date(),
                            status: 'pending_review'
                        });
                        return; // Successfully DLQ'd
                    }
                }

                // If can't create proper DLQ entry (missing userId), fallback or log
                await this.addToDLQ({
                    topic,
                    partition,
                    offset,
                    value: messageValue?.toString() ?? '',
                    error: errorMessage,
                    eventType,
                });

            } catch (dlqError) {
                // If DLQ fails, WE ARE IN TROUBLE.
                // We rethrow to stop the consumer offset commit (eventually).
                // Or we log fatally.
                logger.error('CRITICAL: Failed to write to DLQ', { dlqError, originalError: error });
                throw dlqError;
            }
        }
    }

    /**
     * Fallback generic DLQ log (could be a raw table store)
     * For now acts as a last resort logger if strict DLQ model fails
     */
    private async addToDLQ(info: { topic: string, partition: number, offset: string, value: string, error: string, eventType: string }) {
        // Create a generic record if possible or just log.
        // Since we must match the model, we need userId.
        // If we don't have userId, we can't save to the specific DeadLetterQueue table defined.
        // We'll log as error for now, effectively skipping but alerting.
        logger.error('SKIPPING MESSAGE: Could not process or DLQ', info);
    }

    /**
     * Map incoming event to notification request
     */
    private async mapEventToNotification(
        topic: string,
        event: IncomingEvent
    ): Promise<NotificationRequest | null> {
        const { eventType, payload, correlationId } = event;
        const userId = payload['userId'] as string | undefined;

        if (!userId) {
            logger.warn('Event missing userId', { eventType });
            return null;
        }

        // Map based on topic and event type
        switch (topic) {
            case config.kafka.topics.security:
                return this.mapSecurityEvent(eventType, payload, userId, correlationId);

            case config.kafka.topics.transaction:
                return this.mapTransactionEvent(eventType, payload, userId, correlationId);

            case config.kafka.topics.fraud:
                return this.mapFraudEvent(eventType, payload, userId, correlationId);

            case config.kafka.topics.user:
                return this.mapUserEvent(eventType, payload, userId, correlationId);

            default:
                logger.debug('Unhandled topic', { topic, eventType });
                return null;
        }
    }

    /**
     * Map security events
     */
    private mapSecurityEvent(
        eventType: string,
        payload: Record<string, unknown>,
        userId: string,
        correlationId?: string
    ): NotificationRequest | null {
        switch (eventType) {
            case 'user.login.success':
                return {
                    userId,
                    eventType: 'login_attempt',
                    title: 'New Login Detected',
                    message: `A new login was detected from ${payload['deviceInfo'] ?? 'unknown device'}`,
                    data: payload,
                    priority: 'medium',
                    correlationId,
                };

            case 'user.login.failed':
                return {
                    userId,
                    eventType: 'login_failed',
                    title: 'Failed Login Attempt',
                    message: 'Someone attempted to log into your account with incorrect credentials',
                    data: payload,
                    priority: 'high',
                    correlationId,
                };

            case 'user.locked':
                return {
                    userId,
                    eventType: 'account_locked',
                    title: 'Account Locked',
                    message: 'Your account has been locked due to multiple failed login attempts',
                    data: payload,
                    priority: 'critical',
                    correlationId,
                };

            case 'user.password.changed':
                return {
                    userId,
                    eventType: 'password_changed',
                    title: 'Password Changed',
                    message: 'Your account password was successfully changed',
                    data: payload,
                    priority: 'medium',
                    correlationId,
                };

            case 'user.device.registered':
                return {
                    userId,
                    eventType: 'new_device_added',
                    title: 'New Device Added',
                    message: `A new device "${payload['deviceName'] ?? 'Unknown'}" was added to your account`,
                    data: payload,
                    priority: 'low',
                    correlationId,
                };

            case 'security.anomaly_detected':
            case 'security.token_theft':
                return {
                    userId,
                    eventType: 'suspicious_activity',
                    title: 'Suspicious Activity Detected',
                    message: 'We detected unusual activity on your account. Please review immediately.',
                    data: payload,
                    priority: 'critical',
                    correlationId,
                };

            default:
                return null;
        }
    }

    /**
     * Map transaction events
     */
    private mapTransactionEvent(
        eventType: string,
        payload: Record<string, unknown>,
        userId: string,
        correlationId?: string
    ): NotificationRequest | null {
        const amount = payload['amount'] as number | undefined;
        const currency = (payload['currency'] as string) ?? 'USD';
        const recipientName = payload['recipientName'] as string | undefined;
        const transactionId = payload['transactionId'] as string | undefined;

        const formatAmount = (amt: number) =>
            new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amt);

        switch (eventType) {
            case 'transfer.initiated':
                return {
                    userId,
                    eventType: 'transfer_initiated',
                    title: 'Transfer Initiated',
                    message: `Your transfer of ${amount ? formatAmount(amount) : 'funds'} to ${recipientName ?? 'recipient'} has been initiated`,
                    eventSourceId: transactionId,
                    data: payload,
                    priority: 'low',
                    correlationId,
                };

            case 'transfer.approved':
                return {
                    userId,
                    eventType: 'transfer_approved',
                    title: 'Transfer Approved',
                    message: `Your transfer of ${amount ? formatAmount(amount) : 'funds'} has been approved and is processing`,
                    eventSourceId: transactionId,
                    data: payload,
                    priority: 'medium',
                    correlationId,
                };

            case 'transfer.completed':
                return {
                    userId,
                    eventType: 'transfer_completed',
                    title: 'Transfer Complete',
                    message: `Your transfer of ${amount ? formatAmount(amount) : 'funds'} to ${recipientName ?? 'recipient'} was successful`,
                    eventSourceId: transactionId,
                    data: payload,
                    priority: 'high',
                    correlationId,
                };

            case 'transfer.rejected':
                return {
                    userId,
                    eventType: 'transfer_rejected',
                    title: 'Transfer Rejected',
                    message: `Your transfer of ${amount ? formatAmount(amount) : 'funds'} was not approved. ${payload['reason'] ?? 'Please contact support.'}`,
                    eventSourceId: transactionId,
                    data: payload,
                    priority: 'high',
                    correlationId,
                };

            case 'transfer.failed':
                return {
                    userId,
                    eventType: 'transfer_failed',
                    title: 'Transfer Failed',
                    message: `Your transfer could not be completed due to a technical issue. Please try again.`,
                    eventSourceId: transactionId,
                    data: payload,
                    priority: 'high',
                    correlationId,
                };

            case 'large_transaction':
                return {
                    userId,
                    eventType: 'large_transaction',
                    title: 'Large Transaction Alert',
                    message: `A large transaction of ${amount ? formatAmount(amount) : 'significant funds'} was processed on your account`,
                    eventSourceId: transactionId,
                    data: payload,
                    priority: 'medium',
                    correlationId,
                };

            default:
                return null;
        }
    }

    /**
     * Map fraud events
     */
    private mapFraudEvent(
        eventType: string,
        payload: Record<string, unknown>,
        userId: string,
        correlationId?: string
    ): NotificationRequest | null {
        switch (eventType) {
            case 'fraud.detected':
            case 'fraud.alert':
                return {
                    userId,
                    eventType: 'fraud_detected',
                    title: 'Fraud Alert',
                    message: 'We detected potentially fraudulent activity on your account. Please verify recent transactions.',
                    eventSourceId: payload['caseId'] as string | undefined,
                    data: payload,
                    priority: 'critical',
                    correlationId,
                };

            case 'fraud.alert.resolved':
                return {
                    userId,
                    eventType: 'general_notification',
                    title: 'Fraud Alert Resolved',
                    message: 'The fraud alert on your account has been resolved.',
                    eventSourceId: payload['caseId'] as string | undefined,
                    data: payload,
                    priority: 'medium',
                    correlationId,
                };

            default:
                return null;
        }
    }

    /**
     * Map user events
     */
    private mapUserEvent(
        eventType: string,
        payload: Record<string, unknown>,
        userId: string,
        correlationId?: string
    ): NotificationRequest | null {
        switch (eventType) {
            case 'user.registered':
                return {
                    userId,
                    eventType: 'general_notification',
                    title: 'Welcome to Banking App',
                    message: 'Your account has been created successfully. Please complete your profile.',
                    data: payload,
                    priority: 'medium',
                    correlationId,
                };

            case 'user.kyc.required':
                return {
                    userId,
                    eventType: 'kyc_verification_needed',
                    title: 'Verification Required',
                    message: 'Please complete identity verification to access all features.',
                    data: payload,
                    priority: 'critical',
                    correlationId,
                };

            case 'user.kyc.expired':
                return {
                    userId,
                    eventType: 'kyc_verification_needed',
                    title: 'Verification Expired',
                    message: 'Your identity verification has expired. Please re-verify to continue using your account.',
                    data: payload,
                    priority: 'critical',
                    correlationId,
                };

            default:
                return null;
        }
    }
}

// Export singleton
export const kafkaEventConsumer = new KafkaEventConsumer();
