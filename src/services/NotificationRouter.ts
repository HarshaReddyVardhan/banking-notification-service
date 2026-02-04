/**
 * Banking Notification Service - Notification Router
 * 
 * Core service that routes notifications to appropriate channels
 * based on user preferences, quiet hours, and rate limits.
 */

import { v4 as uuidv4 } from 'uuid';
import { logger, logNotification } from '../utils/logger';
import {
    NotificationPayload,
    NotificationChannel,
    NotificationEventType,
    NotificationPriority,
    DeliveryResult,
    EVENT_TYPE_CONFIGS,
    UserContactInfo,
} from '../types';
import { UserPreferences, IUserPreferences, NotificationEvent } from '../models';
import { rateLimiter } from '../redis/RateLimiter';
import { deduplicationService } from '../redis/DeduplicationService';
import { webSocketHandler, smsHandler, emailHandler, pushHandler } from '../channels';

export interface RouteResult {
    notificationId: string;
    userId: string;
    eventType: NotificationEventType;
    results: DeliveryResult[];
    skippedChannels: Array<{ channel: NotificationChannel; reason: string }>;
    queued: boolean;
    digestQueued: boolean;
}

export interface NotificationRequest {
    userId: string;
    eventType: NotificationEventType;
    title: string;
    message: string;
    eventSourceId?: string;
    data?: Record<string, unknown>;
    priority?: NotificationPriority;
    correlationId?: string;
}

export class NotificationRouter {
    /**
     * Route notification to appropriate channels
     */
    async route(request: NotificationRequest): Promise<RouteResult> {
        const startTime = Date.now();
        const notificationId = uuidv4();
        const eventConfig = EVENT_TYPE_CONFIGS[request.eventType];
        const priority = request.priority ?? eventConfig.priority;

        const result: RouteResult = {
            notificationId,
            userId: request.userId,
            eventType: request.eventType,
            results: [],
            skippedChannels: [],
            queued: false,
            digestQueued: false,
        };

        try {
            // 1. Check deduplication
            const dedupResult = await deduplicationService.checkAndMark(
                request.userId,
                request.eventType,
                request.eventSourceId,
                notificationId,
                eventConfig.dedupWindowMs
            );

            if (dedupResult.isDuplicate) {
                logger.info('Duplicate notification skipped', {
                    notificationId,
                    userId: request.userId,
                    eventType: request.eventType,
                    originalNotificationId: dedupResult.originalNotificationId,
                });
                result.skippedChannels.push({
                    channel: 'websocket', // All channels
                    reason: 'Duplicate notification',
                });
                return result;
            }

            // 2. Load user preferences
            const preferences = await UserPreferences.findOrCreateByUserId(request.userId);

            // 3. Check do-not-contact
            if (preferences.doNotContact?.enabled) {
                logger.info('User has do-not-contact enabled', { userId: request.userId });
                result.skippedChannels.push({
                    channel: 'websocket',
                    reason: 'User has opted out of notifications',
                });
                return result;
            }

            // 4. Determine channels to use
            const channels = this.selectChannels(
                preferences,
                request.eventType,
                eventConfig.defaultChannels,
                priority
            );

            // 5. Check quiet hours
            const inQuietHours = preferences.isInQuietHours();
            const bypassQuietHours = eventConfig.bypassQuietHours ||
                preferences.shouldBypassQuietHours(request.eventType) ||
                priority === 'critical';

            if (inQuietHours && !bypassQuietHours) {
                // Queue for later or digest
                logger.info('Notification queued due to quiet hours', {
                    userId: request.userId,
                    eventType: request.eventType,
                });

                if (eventConfig.allowDigest && preferences.channels?.email?.digestEnabled) {
                    result.digestQueued = true;
                    // Store in digest queue (handled by DigestService)
                } else {
                    result.queued = true;
                    // Store for sending after quiet hours end
                }
                return result;
            }

            // 6. Build notification payload
            const payload: NotificationPayload = {
                notificationId,
                userId: request.userId,
                eventType: request.eventType,
                eventSourceId: request.eventSourceId,
                title: request.title,
                message: request.message,
                data: request.data,
                priority,
                channels,
                correlationId: request.correlationId,
                createdAt: new Date(),
            };

            // 7. Load user contact info
            const contactInfo = await this.loadUserContactInfo(request.userId, preferences);

            // 8. Send to each channel
            const deliveryPromises: Promise<void>[] = [];

            for (const channel of channels) {
                deliveryPromises.push(
                    this.sendToChannel(channel, payload, preferences, contactInfo, result)
                );
            }

            await Promise.all(deliveryPromises);

            // 9. Log notification
            const duration = Date.now() - startTime;
            logNotification({
                notificationId,
                userId: request.userId,
                eventType: request.eventType,
                channels,
                status: result.results.some((r) => r.status === 'sent' || r.status === 'delivered') ? 'success' : 'failed',
                correlationId: request.correlationId,
                durations: { total_ms: duration },
            });

            return result;
        } catch (error) {
            logger.error('Notification routing failed', {
                notificationId,
                userId: request.userId,
                eventType: request.eventType,
                error,
            });
            throw error;
        }
    }

    /**
     * Select channels based on preferences and priority
     */
    private selectChannels(
        preferences: IUserPreferences,
        eventType: NotificationEventType,
        defaultChannels: NotificationChannel[],
        priority: NotificationPriority
    ): NotificationChannel[] {
        // Get user-enabled channels for this event type
        let channels = preferences.getEnabledChannelsForEvent(eventType, defaultChannels);

        // For critical priority, ensure at least one real-time channel
        if (priority === 'critical' && channels.length === 0) {
            // Fall back to websocket (always on)
            if (preferences.isChannelEnabled('websocket')) {
                channels = ['websocket'];
            }
        }

        return channels;
    }

    /**
     * Send notification to a specific channel
     */
    private async sendToChannel(
        channel: NotificationChannel,
        payload: NotificationPayload,
        preferences: IUserPreferences,
        contactInfo: UserContactInfo,
        result: RouteResult
    ): Promise<void> {
        // Check rate limit
        const rateLimitResult = await rateLimiter.consumeLimit(
            payload.userId,
            channel,
            {
                smsPerHour: preferences.rateLimits?.smsPerHour,
                smsPerDay: preferences.rateLimits?.smsPerDay,
                emailPerHour: preferences.rateLimits?.emailPerHour,
                emailPerDay: preferences.rateLimits?.emailPerDay,
                pushPerHour: preferences.rateLimits?.pushPerHour,
                pushPerDay: preferences.rateLimits?.pushPerDay,
            }
        );

        if (!rateLimitResult.allowed) {
            result.skippedChannels.push({
                channel,
                reason: `Rate limit exceeded. Resets at ${rateLimitResult.resetAt.toISOString()}`,
            });

            // Store in database with rate_limited status
            await this.storeNotification(payload, channel, 'rate_limited');
            return;
        }

        let deliveryResult: DeliveryResult;

        try {
            switch (channel) {
                case 'websocket':
                    deliveryResult = await webSocketHandler.send(payload.userId, payload);
                    break;

                case 'sms':
                    if (!contactInfo.phoneNumber || !contactInfo.phoneVerified) {
                        result.skippedChannels.push({
                            channel,
                            reason: 'Phone number not verified',
                        });
                        return;
                    }
                    deliveryResult = await smsHandler.send(contactInfo.phoneNumber, payload);
                    break;

                case 'email':
                    if (!contactInfo.email || !contactInfo.emailVerified) {
                        result.skippedChannels.push({
                            channel,
                            reason: 'Email not verified',
                        });
                        return;
                    }
                    deliveryResult = await emailHandler.send(
                        contactInfo.email,
                        undefined, // toName
                        payload
                    );
                    break;

                case 'push':
                    if (!contactInfo.pushTokens?.length) {
                        result.skippedChannels.push({
                            channel,
                            reason: 'No push tokens registered',
                        });
                        return;
                    }
                    deliveryResult = await pushHandler.send(
                        contactInfo.pushTokens.map((t) => ({
                            token: t.token,
                            platform: t.platform,
                        })),
                        payload
                    );
                    break;

                default:
                    result.skippedChannels.push({
                        channel,
                        reason: `Unknown channel: ${channel}`,
                    });
                    return;
            }

            result.results.push(deliveryResult);

            // Store notification in database
            await this.storeNotification(
                payload,
                channel,
                deliveryResult.status,
                deliveryResult.providerMessageId,
                deliveryResult.error
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            result.results.push({
                channel,
                status: 'failed',
                error: errorMessage,
            });
            await this.storeNotification(payload, channel, 'failed', undefined, errorMessage);
        }
    }

    /**
     * Load user contact information
     */
    private async loadUserContactInfo(
        userId: string,
        preferences: IUserPreferences
    ): Promise<UserContactInfo> {
        const contactInfo: UserContactInfo = {
            userId,
        };

        // Get phone from preferences (encrypted)
        const phone = preferences.getDecryptedPhoneNumber();
        if (phone) {
            contactInfo.phoneNumber = phone;
            contactInfo.phoneVerified = !!preferences.channels?.sms?.verifiedAt;
        }

        // Get email from preferences (encrypted)
        const email = preferences.getDecryptedEmail();
        if (email) {
            contactInfo.email = email;
            contactInfo.emailVerified = !!preferences.channels?.email?.verifiedAt;
        }

        // Get push tokens
        if (preferences.channels?.push?.devices?.length) {
            contactInfo.pushTokens = preferences.channels.push.devices.map((d) => ({
                token: d.token, // Should be decrypted if encrypted
                deviceId: d.deviceId,
                platform: d.platform as 'ios' | 'android',
            }));
        }

        return contactInfo;
    }

    /**
     * Store notification in database
     */
    private async storeNotification(
        payload: NotificationPayload,
        channel: NotificationChannel,
        status: string,
        providerMessageId?: string,
        error?: string
    ): Promise<void> {
        try {
            await NotificationEvent.create({
                notificationId: payload.notificationId,
                userId: payload.userId,
                eventType: payload.eventType,
                eventSourceId: payload.eventSourceId,
                title: payload.title,
                message: payload.message,
                metadata: payload.data,
                channel,
                priority: payload.priority,
                deliveryStatus: status as 'pending' | 'sent' | 'delivered' | 'failed' | 'retrying' | 'rate_limited' | 'queued_for_digest',
                deliveryProvider: this.getProviderForChannel(channel),
                providerMessageId,
                errorMessage: error,
                correlationId: payload.correlationId,
                idempotencyKey: `${payload.userId}:${payload.eventType}:${payload.eventSourceId ?? 'none'}:${channel}`,
                sentAt: status === 'sent' || status === 'delivered' ? new Date() : undefined,
            });
        } catch (error) {
            logger.error('Failed to store notification', {
                notificationId: payload.notificationId,
                channel,
                error,
            });
        }
    }

    /**
     * Get provider name for channel
     */
    private getProviderForChannel(channel: NotificationChannel): string {
        switch (channel) {
            case 'websocket': return 'internal';
            case 'sms': return 'twilio';
            case 'email': return 'sendgrid';
            case 'push': return 'firebase';
            default: return 'unknown';
        }
    }
}

// Export singleton
export const notificationRouter = new NotificationRouter();
