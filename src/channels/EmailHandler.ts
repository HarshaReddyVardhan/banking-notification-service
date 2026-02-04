/**
 * Banking Notification Service - Email Channel Handler (SendGrid)
 * 
 * Handles email delivery via SendGrid API for non-urgent notifications.
 * Supports templates, HTML content, and digest batching.
 */

import sgMail from '@sendgrid/mail';
import { config } from '../config/config';
import { logger, logChannelDelivery } from '../utils/logger';
import { EmailPayload, DeliveryResult, NotificationPayload } from '../types';

export class EmailHandler {
    private enabled: boolean;
    private fromEmail: string;
    private fromName: string;

    constructor() {
        this.enabled = config.sendgrid.enabled;
        this.fromEmail = config.sendgrid.fromEmail;
        this.fromName = config.sendgrid.fromName;

        if (this.enabled && config.sendgrid.apiKey) {
            sgMail.setApiKey(config.sendgrid.apiKey);
            logger.info('SendGrid email client initialized');
        } else {
            logger.warn('SendGrid email client not initialized - disabled or missing API key');
        }
    }

    /**
     * Send email notification
     */
    async send(
        toEmail: string,
        toName: string | undefined,
        notification: NotificationPayload
    ): Promise<DeliveryResult> {
        if (!this.enabled) {
            logger.warn('Email sending skipped - SendGrid not enabled');
            return {
                channel: 'email',
                status: 'failed',
                error: 'Email channel not enabled',
            };
        }

        if (!this.validateEmail(toEmail)) {
            return {
                channel: 'email',
                status: 'failed',
                error: 'Invalid email address format',
            };
        }

        const startTime = Date.now();

        try {
            const msg = this.buildMessage(toEmail, toName, notification);
            const [response] = await sgMail.send(msg);
            const latencyMs = Date.now() - startTime;

            const messageId = response.headers['x-message-id'] as string;

            logChannelDelivery({
                channel: 'email',
                notificationId: notification.notificationId,
                userId: notification.userId,
                status: 'sent',
                provider: 'sendgrid',
                providerMessageId: messageId,
                latencyMs,
            });

            return {
                channel: 'email',
                status: 'sent',
                providerMessageId: messageId,
                sentAt: new Date(),
            };
        } catch (error) {
            const latencyMs = Date.now() - startTime;
            const errorMessage = this.extractSendGridError(error);

            logChannelDelivery({
                channel: 'email',
                notificationId: notification.notificationId,
                userId: notification.userId,
                status: 'failed',
                provider: 'sendgrid',
                latencyMs,
                error: errorMessage,
            });

            return {
                channel: 'email',
                status: 'failed',
                error: errorMessage,
            };
        }
    }

    /**
     * Send raw email payload
     */
    async sendRaw(payload: EmailPayload): Promise<DeliveryResult> {
        if (!this.enabled) {
            return {
                channel: 'email',
                status: 'failed',
                error: 'Email channel not enabled',
            };
        }

        try {
            const msg: any = {
                to: {
                    email: payload.to,
                    name: payload.toName,
                },
                from: {
                    email: this.fromEmail,
                    name: this.fromName,
                },
                subject: payload.subject,
            };

            // Use template or raw content
            if (payload.templateId) {
                msg.templateId = payload.templateId;
                msg.dynamicTemplateData = payload.templateData;
            } else if (payload.htmlContent) {
                msg.html = payload.htmlContent;
                msg.text = payload.textContent;
            }

            const [response] = await sgMail.send(msg);

            return {
                channel: 'email',
                status: 'sent',
                providerMessageId: response.headers['x-message-id'] as string,
                sentAt: new Date(),
            };
        } catch (error) {
            return {
                channel: 'email',
                status: 'failed',
                error: this.extractSendGridError(error),
            };
        }
    }

    /**
     * Send digest email with multiple notifications
     */
    async sendDigest(
        toEmail: string,
        toName: string | undefined,
        notifications: NotificationPayload[],
        frequency: 'hourly' | 'daily' | 'weekly'
    ): Promise<DeliveryResult> {
        if (!this.enabled) {
            return {
                channel: 'email',
                status: 'failed',
                error: 'Email channel not enabled',
            };
        }

        const templateId = config.sendgrid.templates.digest;
        const subject = this.getDigestSubject(frequency);

        try {
            const msg: any = {
                to: {
                    email: toEmail,
                    name: toName,
                },
                from: {
                    email: this.fromEmail,
                    name: this.fromName,
                },
                subject,
            };

            if (templateId) {
                msg.templateId = templateId;
                msg.dynamicTemplateData = {
                    user_name: toName ?? 'Valued Customer',
                    frequency,
                    notification_count: notifications.length,
                    notifications: notifications.map((n) => ({
                        title: n.title,
                        message: n.message,
                        timestamp: n.createdAt.toISOString(),
                        type: n.eventType,
                    })),
                    unsubscribe_link: `${config.websocket.gatewayUrl}/unsubscribe?email=${encodeURIComponent(toEmail)}`,
                };
            } else {
                // Fallback to HTML content
                msg.html = this.buildDigestHtml(notifications, frequency);
                msg.text = this.buildDigestText(notifications, frequency);
            }

            const [response] = await sgMail.send(msg);

            logger.info('Digest email sent', {
                toEmail,
                frequency,
                notificationCount: notifications.length,
            });

            return {
                channel: 'email',
                status: 'sent',
                providerMessageId: response.headers['x-message-id'] as string,
                sentAt: new Date(),
            };
        } catch (error) {
            return {
                channel: 'email',
                status: 'failed',
                error: this.extractSendGridError(error),
            };
        }
    }

    /**
     * Build email message for a notification
     */
    private buildMessage(
        toEmail: string,
        toName: string | undefined,
        notification: NotificationPayload
    ): any {
        const msg: any = {
            to: {
                email: toEmail,
                name: toName,
            },
            from: {
                email: this.fromEmail,
                name: this.fromName,
            },
            subject: notification.title,
            trackingSettings: {
                clickTracking: { enable: true },
                openTracking: { enable: true },
            },
        };

        // Try to use template based on event type
        const templateId = this.getTemplateForEventType(notification.eventType);

        if (templateId) {
            msg.templateId = templateId;
            msg.dynamicTemplateData = {
                user_name: toName ?? 'Valued Customer',
                title: notification.title,
                message: notification.message,
                event_type: notification.eventType,
                timestamp: new Date().toISOString(),
                actions: notification.actions,
                ...notification.data,
            };
        } else {
            // Fallback to HTML content
            msg.html = this.buildHtmlContent(notification);
            msg.text = this.buildTextContent(notification);
        }

        return msg;
    }

    /**
     * Get SendGrid template ID for event type
     */
    private getTemplateForEventType(eventType: string): string | undefined {
        const templates = config.sendgrid.templates;

        if (eventType.startsWith('transfer_')) {
            return templates.transactionComplete;
        }
        if (eventType.includes('login') || eventType.includes('security') || eventType.includes('fraud')) {
            return templates.securityAlert;
        }
        return undefined;
    }

    /**
     * Build HTML email content
     */
    private buildHtmlContent(notification: NotificationPayload): string {
        const actionsHtml = notification.actions?.map((a: any) =>
            `<a href="${a.url}" style="display:inline-block;padding:10px 20px;background:#0066cc;color:#fff;text-decoration:none;border-radius:5px;margin:5px;">${a.label}</a>`
        ).join('') ?? '';

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
                <div style="background:#f8f9fa;padding:20px;border-radius:8px;">
                    <h1 style="color:#0066cc;margin-bottom:10px;">${notification.title}</h1>
                    <p style="margin-bottom:20px;">${notification.message}</p>
                    ${actionsHtml ? `<div style="margin:20px 0;">${actionsHtml}</div>` : ''}
                    <hr style="border:none;border-top:1px solid #ddd;margin:20px 0;">
                    <p style="font-size:12px;color:#666;">
                        This email was sent from Banking App. 
                        <a href="#">Unsubscribe</a> | <a href="#">Manage Preferences</a>
                    </p>
                </div>
            </body>
            </html>
        `;
    }

    /**
     * Build plain text email content
     */
    private buildTextContent(notification: NotificationPayload): string {
        let text = `${notification.title}\n\n${notification.message}\n\n`;

        if (notification.actions?.length) {
            text += 'Actions:\n';
            for (const action of notification.actions) {
                text += `- ${action.label}: ${action.url}\n`;
            }
        }

        text += '\n---\nThis email was sent from Banking App.\n';
        text += 'To unsubscribe, visit: [unsubscribe link]';

        return text;
    }

    /**
     * Build digest HTML content
     */
    private buildDigestHtml(notifications: NotificationPayload[], frequency: string): string {
        const itemsHtml = notifications.map((n) => `
            <div style="padding:15px;border-bottom:1px solid #eee;">
                <h3 style="margin:0 0 5px;color:#0066cc;">${n.title}</h3>
                <p style="margin:0;color:#666;">${n.message}</p>
                <small style="color:#999;">${n.createdAt.toLocaleString()}</small>
            </div>
        `).join('');

        return `
            <!DOCTYPE html>
            <html>
            <body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
                <h1>Your ${frequency} Banking Summary</h1>
                <p>Here's what happened with your account:</p>
                <div style="border:1px solid #ddd;border-radius:8px;overflow:hidden;">
                    ${itemsHtml}
                </div>
                <p style="font-size:12px;color:#666;margin-top:20px;">
                    <a href="#">Unsubscribe</a> | <a href="#">Manage Digest Preferences</a>
                </p>
            </body>
            </html>
        `;
    }

    /**
     * Build digest plain text content
     */
    private buildDigestText(notifications: NotificationPayload[], frequency: string): string {
        let text = `Your ${frequency} Banking Summary\n\n`;

        for (const n of notifications) {
            text += `${n.title}\n${n.message}\n${n.createdAt.toLocaleString()}\n\n`;
        }

        text += '---\nTo unsubscribe or manage preferences, visit your account settings.';
        return text;
    }

    /**
     * Get digest email subject
     */
    private getDigestSubject(frequency: string): string {
        const dateStr = new Date().toLocaleDateString();
        return `Your ${frequency.charAt(0).toUpperCase() + frequency.slice(1)} Banking Summary - ${dateStr}`;
    }

    /**
     * Validate email format
     */
    private validateEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    /**
     * Extract error message from SendGrid error
     */
    private extractSendGridError(error: unknown): string {
        if (error && typeof error === 'object') {
            const sgError = error as { response?: { body?: { errors?: Array<{ message: string }> } } };
            const errors = sgError.response?.body?.errors;
            if (errors?.length) {
                return errors.map((e) => e.message).join('; ');
            }
        }
        return error instanceof Error ? error.message : 'Unknown SendGrid error';
    }

    /**
     * Check if email is available
     */
    isAvailable(): boolean {
        return this.enabled;
    }
}

// Export singleton
export const emailHandler = new EmailHandler();
