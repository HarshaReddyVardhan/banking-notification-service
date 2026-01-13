/**
 * Banking Notification Service - Types
 * 
 * Core type definitions for the notification system including
 * event types, channels, preferences, and delivery status.
 */

// ==================== Notification Channels ====================

export type NotificationChannel = 'websocket' | 'sms' | 'email' | 'push';

// ==================== Notification Priority ====================

export type NotificationPriority = 'low' | 'medium' | 'high' | 'critical';

// ==================== Event Types ====================

export type NotificationEventType =
    // Transfer-related
    | 'transfer_initiated'
    | 'transfer_processing'
    | 'transfer_approved'
    | 'transfer_rejected'
    | 'transfer_completed'
    | 'transfer_failed'
    // Security-related
    | 'login_attempt'
    | 'login_failed'
    | 'account_locked'
    | 'password_changed'
    | 'new_device_added'
    | 'suspicious_activity'
    | 'fraud_detected'
    // Account-related
    | 'low_balance_alert'
    | 'large_transaction'
    | 'recurring_payment_due'
    | 'account_statement_ready'
    | 'promotional_offer'
    // Compliance & Regulatory
    | 'kyc_verification_needed'
    | 'regulatory_alert'
    | 'data_access_logged'
    | 'session_expired'
    // General
    | 'general_notification';

// ==================== Delivery Status ====================

export type DeliveryStatus =
    | 'pending'
    | 'sent'
    | 'delivered'
    | 'failed'
    | 'retrying'
    | 'rate_limited'
    | 'queued_for_digest';

// ==================== Digest Frequency ====================

export type DigestFrequency = 'immediate' | 'hourly' | 'daily' | 'weekly';

// ==================== Event Configuration ====================

export interface EventTypeConfig {
    eventType: NotificationEventType;
    defaultChannels: NotificationChannel[];
    priority: NotificationPriority;
    bypassQuietHours: boolean;
    allowDigest: boolean;
    dedupWindowMs: number;
}

// Default event configurations
export const EVENT_TYPE_CONFIGS: Record<NotificationEventType, EventTypeConfig> = {
    // Transfer events
    transfer_initiated: {
        eventType: 'transfer_initiated',
        defaultChannels: ['websocket'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 300000,
    },
    transfer_processing: {
        eventType: 'transfer_processing',
        defaultChannels: ['websocket'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 300000,
    },
    transfer_approved: {
        eventType: 'transfer_approved',
        defaultChannels: ['websocket', 'push'],
        priority: 'medium',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 300000,
    },
    transfer_rejected: {
        eventType: 'transfer_rejected',
        defaultChannels: ['websocket', 'sms', 'email'],
        priority: 'high',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 300000,
    },
    transfer_completed: {
        eventType: 'transfer_completed',
        defaultChannels: ['websocket', 'push'],
        priority: 'high',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 300000,
    },
    transfer_failed: {
        eventType: 'transfer_failed',
        defaultChannels: ['websocket', 'email'],
        priority: 'high',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 300000,
    },

    // Security events
    login_attempt: {
        eventType: 'login_attempt',
        defaultChannels: ['email'],
        priority: 'medium',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 300000,
    },
    login_failed: {
        eventType: 'login_failed',
        defaultChannels: ['sms', 'email'],
        priority: 'high',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 60000,
    },
    account_locked: {
        eventType: 'account_locked',
        defaultChannels: ['sms', 'websocket'],
        priority: 'critical',
        bypassQuietHours: true,
        allowDigest: false,
        dedupWindowMs: 0,
    },
    password_changed: {
        eventType: 'password_changed',
        defaultChannels: ['email'],
        priority: 'medium',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 0,
    },
    new_device_added: {
        eventType: 'new_device_added',
        defaultChannels: ['email'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 300000,
    },
    suspicious_activity: {
        eventType: 'suspicious_activity',
        defaultChannels: ['sms', 'websocket'],
        priority: 'critical',
        bypassQuietHours: true,
        allowDigest: false,
        dedupWindowMs: 0,
    },
    fraud_detected: {
        eventType: 'fraud_detected',
        defaultChannels: ['sms', 'websocket', 'push'],
        priority: 'critical',
        bypassQuietHours: true,
        allowDigest: false,
        dedupWindowMs: 0,
    },

    // Account events
    low_balance_alert: {
        eventType: 'low_balance_alert',
        defaultChannels: ['email', 'push'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 86400000, // 24 hours
    },
    large_transaction: {
        eventType: 'large_transaction',
        defaultChannels: ['sms', 'email'],
        priority: 'medium',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 300000,
    },
    recurring_payment_due: {
        eventType: 'recurring_payment_due',
        defaultChannels: ['email', 'push'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 86400000,
    },
    account_statement_ready: {
        eventType: 'account_statement_ready',
        defaultChannels: ['email'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 86400000,
    },
    promotional_offer: {
        eventType: 'promotional_offer',
        defaultChannels: ['email'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 86400000,
    },

    // Compliance events
    kyc_verification_needed: {
        eventType: 'kyc_verification_needed',
        defaultChannels: ['sms', 'email'],
        priority: 'critical',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 86400000,
    },
    regulatory_alert: {
        eventType: 'regulatory_alert',
        defaultChannels: ['email'],
        priority: 'critical',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 0,
    },
    data_access_logged: {
        eventType: 'data_access_logged',
        defaultChannels: ['email'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 300000,
    },
    session_expired: {
        eventType: 'session_expired',
        defaultChannels: ['websocket'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: false,
        dedupWindowMs: 300000,
    },
    general_notification: {
        eventType: 'general_notification',
        defaultChannels: ['websocket'],
        priority: 'low',
        bypassQuietHours: false,
        allowDigest: true,
        dedupWindowMs: 300000,
    },
};

// ==================== Notification Payload ====================

export interface NotificationPayload {
    notificationId: string;
    userId: string;
    eventType: NotificationEventType;
    eventSourceId?: string; // e.g., transaction_id, fraud_case_id
    title: string;
    message: string;
    data?: Record<string, unknown>;
    actions?: NotificationAction[];
    priority: NotificationPriority;
    channels: NotificationChannel[];
    correlationId?: string;
    createdAt: Date;
}

export interface NotificationAction {
    label: string;
    url: string;
    type: 'primary' | 'secondary';
}

// ==================== Channel-Specific Payloads ====================

export interface WebSocketPayload {
    userId: string;
    notification: {
        type: NotificationEventType;
        title: string;
        message: string;
        data?: Record<string, unknown>;
        actions?: NotificationAction[];
        timestamp: string;
    };
}

export interface SMSPayload {
    to: string;
    message: string;
    statusCallback?: string;
}

export interface EmailPayload {
    to: string;
    toName?: string;
    subject: string;
    templateId?: string;
    templateData?: Record<string, unknown>;
    htmlContent?: string;
    textContent?: string;
}

export interface PushPayload {
    deviceTokens: string[];
    title: string;
    body: string;
    data?: Record<string, unknown>;
    android?: {
        priority: 'high' | 'normal';
        ttlSeconds?: number;
    };
    apns?: {
        priority: number;
        badge?: number;
    };
}

// ==================== Incoming Events ====================

export interface IncomingEvent {
    eventType: string;
    timestamp: string;
    service: string;
    version: string;
    correlationId?: string;
    payload: Record<string, unknown>;
}

// ==================== Delivery Result ====================

export interface DeliveryResult {
    channel: NotificationChannel;
    status: DeliveryStatus;
    providerMessageId?: string;
    sentAt?: Date;
    error?: string;
    retryCount?: number;
}

// ==================== User Contact Info (for channel handlers) ====================

export interface UserContactInfo {
    userId: string;
    email?: string;
    emailVerified?: boolean;
    phoneNumber?: string;
    phoneVerified?: boolean;
    pushTokens?: Array<{
        token: string;
        deviceId: string;
        platform: 'ios' | 'android';
    }>;
}
