/**
 * Banking Notification Service - Dead Letter Queue Model (PostgreSQL)
 * 
 * Stores notifications that failed after all retry attempts.
 * Supports manual review and resolution by support team.
 */

import {
    Model,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    CreationOptional,
} from 'sequelize';
import { sequelize } from './database';
import { NotificationChannel, NotificationEventType, NotificationPriority } from '../../types';

export type DLQStatus = 'pending_review' | 'under_review' | 'resolved' | 'abandoned';
export type DLQResolutionType = 'manual_retry' | 'contact_updated' | 'user_notified' | 'skipped';

export class DeadLetterQueue extends Model<
    InferAttributes<DeadLetterQueue>,
    InferCreationAttributes<DeadLetterQueue>
> {
    // Primary key
    declare id: CreationOptional<string>;

    // Original notification details
    declare originalNotificationId: string;
    declare userId: string;
    declare eventType: NotificationEventType;
    declare eventSourceId: CreationOptional<string | null>;
    declare channel: NotificationChannel;
    declare priority: NotificationPriority;

    // Content
    declare title: string;
    declare message: string;
    declare metadata: CreationOptional<Record<string, unknown> | null>;

    // Failure details
    declare failureReason: string;
    declare totalAttempts: number;
    declare lastAttemptAt: Date;
    declare failureHistory: CreationOptional<Array<{ timestamp: string; error: string }> | null>;

    // Resolution tracking
    declare status: DLQStatus;
    declare resolvedBy: CreationOptional<string | null>; // Admin/support user ID
    declare resolvedAt: CreationOptional<Date | null>;
    declare resolutionType: CreationOptional<DLQResolutionType | null>;
    declare resolutionNotes: CreationOptional<string | null>;

    // Timestamps
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;

    // Instance methods

    /**
     * Mark as under review
     */
    async startReview(reviewerId: string): Promise<void> {
        this.status = 'under_review';
        this.resolvedBy = reviewerId;
        await this.save();
    }

    /**
     * Resolve the dead letter
     */
    async resolve(
        resolutionType: DLQResolutionType,
        notes?: string
    ): Promise<void> {
        this.status = 'resolved';
        this.resolvedAt = new Date();
        this.resolutionType = resolutionType;
        this.resolutionNotes = notes ?? null;
        await this.save();
    }

    /**
     * Abandon the notification (no further action)
     */
    async abandon(notes?: string): Promise<void> {
        this.status = 'abandoned';
        this.resolvedAt = new Date();
        this.resolutionType = 'skipped';
        this.resolutionNotes = notes ?? null;
        await this.save();
    }
}

// Model initialization
DeadLetterQueue.init(
    {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        originalNotificationId: {
            type: DataTypes.UUID,
            allowNull: false,
            field: 'original_notification_id',
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
        channel: {
            type: DataTypes.STRING(20),
            allowNull: false,
        },
        priority: {
            type: DataTypes.STRING(20),
            allowNull: false,
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
        failureReason: {
            type: DataTypes.TEXT,
            allowNull: false,
            field: 'failure_reason',
        },
        totalAttempts: {
            type: DataTypes.INTEGER,
            allowNull: false,
            field: 'total_attempts',
        },
        lastAttemptAt: {
            type: DataTypes.DATE,
            allowNull: false,
            field: 'last_attempt_at',
        },
        failureHistory: {
            type: DataTypes.JSONB,
            allowNull: true,
            field: 'failure_history',
        },
        status: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'pending_review',
            validate: {
                isIn: [['pending_review', 'under_review', 'resolved', 'abandoned']],
            },
        },
        resolvedBy: {
            type: DataTypes.UUID,
            allowNull: true,
            field: 'resolved_by',
        },
        resolvedAt: {
            type: DataTypes.DATE,
            allowNull: true,
            field: 'resolved_at',
        },
        resolutionType: {
            type: DataTypes.STRING(30),
            allowNull: true,
            field: 'resolution_type',
        },
        resolutionNotes: {
            type: DataTypes.TEXT,
            allowNull: true,
            field: 'resolution_notes',
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
            field: 'created_at',
        },
        updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
            field: 'updated_at',
        },
    },
    {
        sequelize,
        tableName: 'dead_letter_queue',
        modelName: 'DeadLetterQueue',
        timestamps: true,
        indexes: [
            // Find pending items for review
            {
                name: 'idx_dlq_status',
                fields: ['status'],
            },
            // User-specific failures
            {
                name: 'idx_dlq_user',
                fields: ['user_id'],
            },
            // Channel-specific failures
            {
                name: 'idx_dlq_channel',
                fields: ['channel', 'status'],
            },
            // Priority for triage
            {
                name: 'idx_dlq_priority',
                fields: ['priority', 'status'],
            },
        ],
    }
);

export default DeadLetterQueue;
