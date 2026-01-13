/**
 * Banking Notification Service - Notification Event Model (PostgreSQL)
 * 
 * Stores notification delivery history for audit, retry, and querying.
 * Retains 1 year of data with archival to S3 for compliance.
 */

import {
    Model,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    CreationOptional,
} from 'sequelize';
import { sequelize } from './database';
import {
    NotificationChannel,
    NotificationEventType,
    NotificationPriority,
    DeliveryStatus,
} from '../../types';

export class NotificationEvent extends Model<
    InferAttributes<NotificationEvent>,
    InferCreationAttributes<NotificationEvent>
> {
    // Primary key
    declare notificationId: CreationOptional<string>;

    // User & Event identification
    declare userId: string;
    declare eventType: NotificationEventType;
    declare eventSourceId: CreationOptional<string | null>; // transaction_id, fraud_case_id, etc.

    // Notification content
    declare title: string;
    declare message: string;
    declare metadata: CreationOptional<Record<string, unknown> | null>;

    // Delivery information
    declare channel: NotificationChannel;
    declare priority: NotificationPriority;
    declare deliveryStatus: DeliveryStatus;
    declare deliveryProvider: CreationOptional<string | null>; // 'internal', 'twilio', 'sendgrid', 'firebase'
    declare providerMessageId: CreationOptional<string | null>;

    // Retry tracking
    declare retryCount: CreationOptional<number>;
    declare lastRetryAt: CreationOptional<Date | null>;
    declare nextRetryAt: CreationOptional<Date | null>;
    declare errorMessage: CreationOptional<string | null>;

    // Timestamps
    declare createdAt: CreationOptional<Date>;
    declare sentAt: CreationOptional<Date | null>;
    declare deliveredAt: CreationOptional<Date | null>;
    declare readAt: CreationOptional<Date | null>;

    // Tracking
    declare correlationId: CreationOptional<string | null>;
    declare idempotencyKey: CreationOptional<string | null>; // For deduplication

    // Instance methods

    /**
     * Check if notification should be retried
     */
    shouldRetry(maxAttempts: number): boolean {
        if (this.deliveryStatus !== 'failed' && this.deliveryStatus !== 'retrying') {
            return false;
        }
        return this.retryCount < maxAttempts;
    }

    /**
     * Calculate next retry delay using exponential backoff
     */
    getNextRetryDelay(retrySchedule: Record<number, number>): number {
        const attemptNumber = this.retryCount + 1;
        return retrySchedule[attemptNumber] ?? retrySchedule[5] ?? 3600000;
    }

    /**
     * Mark as sent
     */
    async markSent(providerMessageId?: string): Promise<void> {
        this.deliveryStatus = 'sent';
        this.sentAt = new Date();
        if (providerMessageId) {
            this.providerMessageId = providerMessageId;
        }
        await this.save();
    }

    /**
     * Mark as delivered
     */
    async markDelivered(): Promise<void> {
        this.deliveryStatus = 'delivered';
        this.deliveredAt = new Date();
        await this.save();
    }

    /**
     * Mark as failed
     */
    async markFailed(error: string): Promise<void> {
        this.deliveryStatus = 'failed';
        this.errorMessage = error;
        this.lastRetryAt = new Date();
        await this.save();
    }

    /**
     * Mark as retrying
     */
    async markRetrying(nextRetryAt: Date): Promise<void> {
        this.deliveryStatus = 'retrying';
        this.retryCount = (this.retryCount ?? 0) + 1;
        this.lastRetryAt = new Date();
        this.nextRetryAt = nextRetryAt;
        await this.save();
    }

    /**
     * Mark as read
     */
    async markRead(): Promise<void> {
        this.readAt = new Date();
        await this.save();
    }
}

// Model initialization
NotificationEvent.init(
    {
        notificationId: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
            field: 'notification_id',
        },
        userId: {
            type: DataTypes.UUID,
            allowNull: false,
            field: 'user_id',
        },
        eventType: {
            type: DataTypes.STRING(50),
            allowNull: false,
            field: 'event_type',
        },
        eventSourceId: {
            type: DataTypes.STRING(255),
            allowNull: true,
            field: 'event_source_id',
        },
        title: {
            type: DataTypes.STRING(255),
            allowNull: false,
        },
        message: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        metadata: {
            type: DataTypes.JSONB,
            allowNull: true,
        },
        channel: {
            type: DataTypes.STRING(20),
            allowNull: false,
            validate: {
                isIn: [['websocket', 'sms', 'email', 'push']],
            },
        },
        priority: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'medium',
            validate: {
                isIn: [['low', 'medium', 'high', 'critical']],
            },
        },
        deliveryStatus: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'pending',
            field: 'delivery_status',
            validate: {
                isIn: [['pending', 'sent', 'delivered', 'failed', 'retrying', 'rate_limited', 'queued_for_digest']],
            },
        },
        deliveryProvider: {
            type: DataTypes.STRING(50),
            allowNull: true,
            field: 'delivery_provider',
        },
        providerMessageId: {
            type: DataTypes.STRING(255),
            allowNull: true,
            field: 'provider_message_id',
        },
        retryCount: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
            field: 'retry_count',
        },
        lastRetryAt: {
            type: DataTypes.DATE,
            allowNull: true,
            field: 'last_retry_at',
        },
        nextRetryAt: {
            type: DataTypes.DATE,
            allowNull: true,
            field: 'next_retry_at',
        },
        errorMessage: {
            type: DataTypes.TEXT,
            allowNull: true,
            field: 'error_message',
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
            field: 'created_at',
        },
        sentAt: {
            type: DataTypes.DATE,
            allowNull: true,
            field: 'sent_at',
        },
        deliveredAt: {
            type: DataTypes.DATE,
            allowNull: true,
            field: 'delivered_at',
        },
        readAt: {
            type: DataTypes.DATE,
            allowNull: true,
            field: 'read_at',
        },
        correlationId: {
            type: DataTypes.STRING(100),
            allowNull: true,
            field: 'correlation_id',
        },
        idempotencyKey: {
            type: DataTypes.STRING(255),
            allowNull: true,
            field: 'idempotency_key',
        },
    },
    {
        sequelize,
        tableName: 'notification_events',
        modelName: 'NotificationEvent',
        timestamps: false, // We handle timestamps manually
        indexes: [
            // Query by user and time for notification history
            {
                name: 'idx_notification_user_created',
                fields: ['user_id', 'created_at'],
            },
            // Find failed notifications for retry
            {
                name: 'idx_notification_channel_status',
                fields: ['channel', 'delivery_status'],
            },
            // Find all notifications for a specific event source (e.g., transaction)
            {
                name: 'idx_notification_event_source',
                fields: ['event_source_id'],
            },
            // Time-series queries
            {
                name: 'idx_notification_created',
                fields: ['created_at'],
            },
            // Retry scheduling
            {
                name: 'idx_notification_next_retry',
                fields: ['next_retry_at'],
                where: {
                    delivery_status: 'retrying',
                },
            },
            // Deduplication
            {
                unique: true,
                name: 'idx_notification_idempotency',
                fields: ['idempotency_key'],
                where: {
                    idempotency_key: { $ne: null } as unknown,
                },
            },
        ],
    }
);

export default NotificationEvent;
