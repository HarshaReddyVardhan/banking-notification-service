/**
 * Banking Notification Service - SMS Channel Handler (Twilio)
 * 
 * Handles SMS delivery via Twilio API for urgent notifications.
 * Cost: ~$0.0075 per SMS (negotiated rate)
 */

import Twilio from 'twilio';
import { config } from '../config/config';
import { logger, logChannelDelivery } from '../utils/logger';
import { SMSPayload, DeliveryResult, NotificationPayload } from '../types';

export class SMSHandler {
    private client: Twilio.Twilio | null = null;
    private fromNumber: string;
    private enabled: boolean;

    constructor() {
        this.enabled = config.twilio.enabled;
        this.fromNumber = config.twilio.phoneNumber;

        if (this.enabled && config.twilio.accountSid && config.twilio.authToken) {
            this.client = Twilio(config.twilio.accountSid, config.twilio.authToken);
            logger.info('Twilio SMS client initialized');
        } else {
            logger.warn('Twilio SMS client not initialized - disabled or missing credentials');
        }
    }

    /**
     * Send SMS notification
     */
    async send(
        toPhoneNumber: string,
        notification: NotificationPayload
    ): Promise<DeliveryResult> {
        if (!this.enabled || !this.client) {
            logger.warn('SMS sending skipped - Twilio not enabled');
            return {
                channel: 'sms',
                status: 'failed',
                error: 'SMS channel not enabled',
            };
        }

        if (!this.validatePhoneNumber(toPhoneNumber)) {
            return {
                channel: 'sms',
                status: 'failed',
                error: 'Invalid phone number format',
            };
        }

        const startTime = Date.now();
        const message = this.formatMessage(notification);

        try {
            const result = await this.client.messages.create({
                body: message,
                from: this.fromNumber,
                to: toPhoneNumber,
                statusCallback: config.twilio.statusCallbackUrl,
            });

            const latencyMs = Date.now() - startTime;

            logChannelDelivery({
                channel: 'sms',
                notificationId: notification.notificationId,
                userId: notification.userId,
                status: 'sent',
                provider: 'twilio',
                providerMessageId: result.sid,
                latencyMs,
            });

            return {
                channel: 'sms',
                status: 'sent',
                providerMessageId: result.sid,
                sentAt: new Date(),
            };
        } catch (error) {
            const latencyMs = Date.now() - startTime;
            const errorMessage = this.extractTwilioError(error);

            logChannelDelivery({
                channel: 'sms',
                notificationId: notification.notificationId,
                userId: notification.userId,
                status: 'failed',
                provider: 'twilio',
                latencyMs,
                error: errorMessage,
            });

            return {
                channel: 'sms',
                status: 'failed',
                error: errorMessage,
            };
        }
    }

    /**
     * Send raw SMS payload
     */
    async sendRaw(payload: SMSPayload): Promise<DeliveryResult> {
        if (!this.enabled || !this.client) {
            return {
                channel: 'sms',
                status: 'failed',
                error: 'SMS channel not enabled',
            };
        }

        try {
            const result = await this.client.messages.create({
                body: payload.message,
                from: this.fromNumber,
                to: payload.to,
                statusCallback: payload.statusCallback ?? config.twilio.statusCallbackUrl,
            });

            return {
                channel: 'sms',
                status: 'sent',
                providerMessageId: result.sid,
                sentAt: new Date(),
            };
        } catch (error) {
            return {
                channel: 'sms',
                status: 'failed',
                error: this.extractTwilioError(error),
            };
        }
    }

    /**
     * Get delivery status from Twilio
     */
    async getDeliveryStatus(messageSid: string): Promise<string> {
        if (!this.client) {
            return 'unknown';
        }

        try {
            const message = await this.client.messages(messageSid).fetch();
            return message.status;
        } catch {
            return 'unknown';
        }
    }

    /**
     * Format notification for SMS
     * Max 160 characters for single segment
     */
    private formatMessage(notification: NotificationPayload): string {
        // Use title and truncated message
        let message = `${notification.title}: ${notification.message}`;

        // Add unsubscribe option for compliance
        const unsubscribe = '\nReply STOP to unsubscribe.';

        // Truncate if needed (leave room for unsubscribe)
        const maxLength = 160 - unsubscribe.length;
        if (message.length > maxLength) {
            message = message.substring(0, maxLength - 3) + '...';
        }

        return message + unsubscribe;
    }

    /**
     * Validate phone number format
     * Expects E.164 format: +[country code][number]
     */
    private validatePhoneNumber(phone: string): boolean {
        // E.164 format: + followed by 1-15 digits
        const e164Regex = /^\+[1-9]\d{1,14}$/;
        return e164Regex.test(phone);
    }

    /**
     * Extract error message from Twilio error
     */
    private extractTwilioError(error: unknown): string {
        if (error && typeof error === 'object') {
            const twilioError = error as { code?: number; message?: string; moreInfo?: string };
            if (twilioError.code && twilioError.message) {
                return `Twilio Error ${twilioError.code}: ${twilioError.message}`;
            }
        }
        return error instanceof Error ? error.message : 'Unknown Twilio error';
    }

    /**
     * Check if SMS is available
     */
    isAvailable(): boolean {
        return this.enabled && this.client !== null;
    }
}

// Export singleton
export const smsHandler = new SMSHandler();
