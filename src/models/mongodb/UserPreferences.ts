/**
 * Banking Notification Service - User Preferences Model (MongoDB)
 * 
 * Stores user notification preferences including channel settings,
 * notification types, quiet hours, rate limits, and do-not-contact status.
 */

import mongoose, { Schema, Document, Model } from 'mongoose';
import CryptoJS from 'crypto-js';
import { config } from '../../config/config';
import { NotificationChannel, NotificationEventType, DigestFrequency } from '../../types';

// ==================== Encryption Helpers ====================

function encryptField(value: string): string {
    return CryptoJS.AES.encrypt(value, config.security.fieldEncryptionKey).toString();
}

function decryptField(encrypted: string): string {
    const bytes = CryptoJS.AES.decrypt(encrypted, config.security.fieldEncryptionKey);
    return bytes.toString(CryptoJS.enc.Utf8);
}

// ==================== Sub-Schemas ====================

const WebSocketChannelSchema = new Schema({
    enabled: { type: Boolean, default: true },
    onWhenOnlineOnly: { type: Boolean, default: true },
}, { _id: false });

const SMSChannelSchema = new Schema({
    enabled: { type: Boolean, default: true },
    phoneNumber: { type: String }, // Encrypted
    verifiedAt: { type: Date },
}, { _id: false });

const EmailChannelSchema = new Schema({
    enabled: { type: Boolean, default: true },
    address: { type: String }, // Encrypted
    verifiedAt: { type: Date },
    digestEnabled: { type: Boolean, default: false },
    digestFrequency: {
        type: String,
        enum: ['immediate', 'hourly', 'daily', 'weekly'],
        default: 'daily',
    },
    digestTime: { type: String, default: '09:00' }, // HH:MM format
}, { _id: false });

const PushDeviceSchema = new Schema({
    deviceId: { type: String, required: true },
    deviceName: { type: String },
    token: { type: String, required: true }, // Encrypted
    platform: { type: String, enum: ['ios', 'android'], required: true },
    lastActiveAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
}, { _id: false });

const PushChannelSchema = new Schema({
    enabled: { type: Boolean, default: true },
    devices: [PushDeviceSchema],
}, { _id: false });

const ChannelsSchema = new Schema({
    websocket: { type: WebSocketChannelSchema, default: () => ({}) },
    sms: { type: SMSChannelSchema, default: () => ({}) },
    email: { type: EmailChannelSchema, default: () => ({}) },
    push: { type: PushChannelSchema, default: () => ({}) },
}, { _id: false });

const NotificationTypePreferenceSchema = new Schema({
    enabled: { type: Boolean, default: true },
    channels: [{ type: String, enum: ['websocket', 'sms', 'email', 'push'] }],
    quietHoursOverride: { type: Boolean, default: false },
}, { _id: false });

const QuietHoursSchema = new Schema({
    enabled: { type: Boolean, default: false },
    start: { type: String, default: '22:00' }, // HH:MM format
    end: { type: String, default: '07:00' },
    timezone: { type: String, default: 'America/New_York' },
    criticalAlertsBypass: { type: Boolean, default: true },
}, { _id: false });

const RateLimitsSchema = new Schema({
    smsPerHour: { type: Number, default: 10 },
    smsPerDay: { type: Number, default: 50 },
    emailPerHour: { type: Number, default: 20 },
    emailPerDay: { type: Number, default: 100 },
    pushPerHour: { type: Number, default: 30 },
    pushPerDay: { type: Number, default: 200 },
}, { _id: false });

const DoNotContactSchema = new Schema({
    enabled: { type: Boolean, default: false },
    reason: {
        type: String,
        enum: ['user_requested', 'unsubscribed', 'invalid_contact', 'compliance'],
    },
    until: { type: Date }, // Optional: re-enable after date
    updatedBy: { type: String }, // Admin/support user ID
    updatedAt: { type: Date },
}, { _id: false });

// ==================== Main Schema ====================

export interface IUserPreferences extends Document {
    userId: string;
    channels: {
        websocket: { enabled: boolean; onWhenOnlineOnly: boolean };
        sms: { enabled: boolean; phoneNumber?: string; verifiedAt?: Date };
        email: {
            enabled: boolean;
            address?: string;
            verifiedAt?: Date;
            digestEnabled: boolean;
            digestFrequency: DigestFrequency;
            digestTime: string;
        };
        push: {
            enabled: boolean;
            devices: Array<{
                deviceId: string;
                deviceName?: string;
                token: string;
                platform: 'ios' | 'android';
                lastActiveAt?: Date;
                createdAt: Date;
            }>;
        };
    };
    notificationTypes: Map<NotificationEventType, {
        enabled: boolean;
        channels: NotificationChannel[];
        quietHoursOverride: boolean;
    }>;
    quietHours: {
        enabled: boolean;
        start: string;
        end: string;
        timezone: string;
        criticalAlertsBypass: boolean;
    };
    rateLimits: {
        smsPerHour: number;
        smsPerDay: number;
        emailPerHour: number;
        emailPerDay: number;
        pushPerHour: number;
        pushPerDay: number;
    };
    doNotContact: {
        enabled: boolean;
        reason?: string;
        until?: Date;
        updatedBy?: string;
        updatedAt?: Date;
    };
    createdAt: Date;
    updatedAt: Date;

    // Methods
    getDecryptedPhoneNumber(): string | null;
    setEncryptedPhoneNumber(phone: string): void;
    getDecryptedEmail(): string | null;
    setEncryptedEmail(email: string): void;
    isChannelEnabled(channel: NotificationChannel): boolean;
    getEnabledChannelsForEvent(eventType: NotificationEventType, defaultChannels: NotificationChannel[]): NotificationChannel[];
    isInQuietHours(now?: Date): boolean;
    shouldBypassQuietHours(eventType: NotificationEventType): boolean;
}

const UserPreferencesSchema = new Schema<IUserPreferences>({
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    channels: { type: ChannelsSchema, default: () => ({}) },
    notificationTypes: {
        type: Map,
        of: NotificationTypePreferenceSchema,
        default: () => new Map(),
    },
    quietHours: { type: QuietHoursSchema, default: () => ({}) },
    rateLimits: { type: RateLimitsSchema, default: () => ({}) },
    doNotContact: { type: DoNotContactSchema, default: () => ({}) },
}, {
    timestamps: true,
    collection: 'user_notification_preferences',
});

// ==================== Instance Methods ====================

UserPreferencesSchema.methods.getDecryptedPhoneNumber = function (): string | null {
    const phone = this.channels?.sms?.phoneNumber;
    if (!phone) return null;
    try {
        return decryptField(phone);
    } catch {
        return null;
    }
};

UserPreferencesSchema.methods.setEncryptedPhoneNumber = function (phone: string): void {
    if (!this.channels) this.channels = {} as typeof this.channels;
    if (!this.channels.sms) this.channels.sms = { enabled: true };
    this.channels.sms.phoneNumber = encryptField(phone);
};

UserPreferencesSchema.methods.getDecryptedEmail = function (): string | null {
    const email = this.channels?.email?.address;
    if (!email) return null;
    try {
        return decryptField(email);
    } catch {
        return null;
    }
};

UserPreferencesSchema.methods.setEncryptedEmail = function (email: string): void {
    if (!this.channels) this.channels = {} as typeof this.channels;
    if (!this.channels.email) this.channels.email = { enabled: true, digestEnabled: false, digestFrequency: 'daily', digestTime: '09:00' };
    this.channels.email.address = encryptField(email);
};

UserPreferencesSchema.methods.isChannelEnabled = function (channel: NotificationChannel): boolean {
    if (this.doNotContact?.enabled) return false;
    return this.channels?.[channel]?.enabled ?? true;
};

UserPreferencesSchema.methods.getEnabledChannelsForEvent = function (
    eventType: NotificationEventType,
    defaultChannels: NotificationChannel[]
): NotificationChannel[] {
    // Check do-not-contact
    if (this.doNotContact?.enabled) return [];

    // Get user preferences for this event type
    const prefs = this.notificationTypes?.get(eventType);

    if (prefs && prefs.enabled === false) {
        return []; // User disabled this event type entirely
    }

    // Use user-configured channels or fall back to defaults
    const configuredChannels = prefs?.channels?.length ? prefs.channels : defaultChannels;

    // Filter by globally enabled channels
    return configuredChannels.filter((channel: NotificationChannel) =>
        this.isChannelEnabled(channel)
    );
};

UserPreferencesSchema.methods.isInQuietHours = function (now?: Date): boolean {
    if (!this.quietHours?.enabled) return false;

    const currentTime = now ?? new Date();

    // Parse quiet hours (simple HH:MM comparison)
    // In production, use a proper timezone library like moment-timezone
    const currentHHMM = currentTime.toTimeString().slice(0, 5);
    const start = this.quietHours.start;
    const end = this.quietHours.end;

    // Handle overnight quiet hours (e.g., 22:00 - 07:00)
    if (start > end) {
        return currentHHMM >= start || currentHHMM < end;
    }

    return currentHHMM >= start && currentHHMM < end;
};

UserPreferencesSchema.methods.shouldBypassQuietHours = function (eventType: NotificationEventType): boolean {
    // Check event-specific override
    const prefs = this.notificationTypes?.get(eventType);
    if (prefs?.quietHoursOverride) return true;

    // Check global critical alerts bypass
    return this.quietHours?.criticalAlertsBypass ?? true;
};

// ==================== Static Methods ====================

interface IUserPreferencesModel extends Model<IUserPreferences> {
    findByUserId(userId: string): Promise<IUserPreferences | null>;
    findOrCreateByUserId(userId: string): Promise<IUserPreferences>;
}

UserPreferencesSchema.statics.findByUserId = async function (userId: string): Promise<IUserPreferences | null> {
    return this.findOne({ userId });
};

UserPreferencesSchema.statics.findOrCreateByUserId = async function (userId: string): Promise<IUserPreferences> {
    let prefs = await this.findOne({ userId });
    if (!prefs) {
        prefs = await this.create({ userId });
    }
    return prefs;
};

// ==================== Export ====================

export const UserPreferences = mongoose.model<IUserPreferences, IUserPreferencesModel>(
    'UserPreferences',
    UserPreferencesSchema
);

export default UserPreferences;
