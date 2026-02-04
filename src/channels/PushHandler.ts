/**
 * Banking Notification Service - Push Notification Handler (Firebase)
 * 
 * Handles push notifications via Firebase Cloud Messaging (FCM).
 * Supports both iOS (APNs) and Android devices.
 */

import admin from 'firebase-admin';
import { config } from '../config/config';
import { logger, logChannelDelivery } from '../utils/logger';
import { PushPayload, DeliveryResult, NotificationPayload } from '../types';

interface DeviceToken {
    token: string;
    platform: 'ios' | 'android';
}

export class PushHandler {
    private enabled: boolean;
    private initialized: boolean = false;

    constructor() {
        this.enabled = config.firebase.enabled;

        if (this.enabled && config.firebase.projectId && config.firebase.privateKeyPath) {
            try {
                // Initialize Firebase Admin SDK
                const serviceAccount = require(config.firebase.privateKeyPath);

                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                    projectId: config.firebase.projectId,
                });

                this.initialized = true;
                logger.info('Firebase push notification client initialized');
            } catch (error) {
                logger.error('Failed to initialize Firebase', { error });
            }
        } else {
            logger.warn('Firebase push client not initialized - disabled or missing configuration');
        }
    }

    /**
     * Send push notification to user's devices
     */
    async send(
        devices: DeviceToken[],
        notification: NotificationPayload
    ): Promise<DeliveryResult> {
        if (!this.enabled || !this.initialized) {
            logger.warn('Push sending skipped - Firebase not enabled');
            return {
                channel: 'push',
                status: 'failed',
                error: 'Push channel not enabled',
            };
        }

        if (!devices.length) {
            return {
                channel: 'push',
                status: 'failed',
                error: 'No device tokens provided',
            };
        }

        const startTime = Date.now();

        try {
            const payload = this.buildPayload(notification);
            const tokens = devices.map((d) => d.token);

            // Send to multiple devices
            const response = await admin.messaging().sendEachForMulticast({
                tokens,
                notification: {
                    title: notification.title,
                    body: notification.message,
                },
                data: payload.data as Record<string, string>,
                android: {
                    priority: notification.priority === 'critical' ? 'high' : 'normal',
                    ttl: 3600000, // 1 hour
                    notification: {
                        clickAction: 'OPEN_APP',
                    },
                },
                apns: {
                    headers: {
                        'apns-priority': notification.priority === 'critical' ? '10' : '5',
                    },
                    payload: {
                        aps: {
                            alert: {
                                title: notification.title,
                                body: notification.message,
                            },
                            sound: 'default',
                            badge: 1,
                        },
                    },
                },
            });

            const latencyMs = Date.now() - startTime;
            const successCount = response.successCount;
            const failureCount = response.failureCount;

            logChannelDelivery({
                channel: 'push',
                notificationId: notification.notificationId,
                userId: notification.userId,
                status: successCount > 0 ? 'sent' : 'failed',
                provider: 'firebase',
                latencyMs,
            });

            // Log individual failures for token cleanup
            if (failureCount > 0) {
                response.responses.forEach((resp, idx) => {
                    if (!resp.success && resp.error) {
                        logger.warn('Push notification failed for device', {
                            token: tokens[idx]?.substring(0, 10) + '...',
                            error: resp.error.message,
                            code: resp.error.code,
                        });
                    }
                });
            }

            if (successCount > 0) {
                return {
                    channel: 'push',
                    status: 'sent',
                    providerMessageId: response.responses[0]?.messageId,
                    sentAt: new Date(),
                };
            }

            return {
                channel: 'push',
                status: 'failed',
                error: `All ${failureCount} device(s) failed`,
            };
        } catch (error) {
            const latencyMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown Firebase error';

            logChannelDelivery({
                channel: 'push',
                notificationId: notification.notificationId,
                userId: notification.userId,
                status: 'failed',
                provider: 'firebase',
                latencyMs,
                error: errorMessage,
            });

            return {
                channel: 'push',
                status: 'failed',
                error: errorMessage,
            };
        }
    }

    /**
     * Send raw push payload
     */
    async sendRaw(payload: PushPayload): Promise<DeliveryResult> {
        if (!this.enabled || !this.initialized) {
            return {
                channel: 'push',
                status: 'failed',
                error: 'Push channel not enabled',
            };
        }

        try {
            const response = await admin.messaging().sendEachForMulticast({
                tokens: payload.deviceTokens,
                notification: {
                    title: payload.title,
                    body: payload.body,
                },
                data: payload.data as Record<string, string>,
                android: payload.android ? {
                    priority: payload.android.priority,
                    ttl: (payload.android.ttlSeconds ?? 3600) * 1000,
                } : undefined,
                apns: payload.apns ? {
                    headers: {
                        'apns-priority': String(payload.apns.priority),
                    },
                    payload: {
                        aps: {
                            badge: payload.apns.badge,
                        },
                    },
                } : undefined,
            });

            if (response.successCount > 0) {
                return {
                    channel: 'push',
                    status: 'sent',
                    providerMessageId: response.responses[0]?.messageId,
                    sentAt: new Date(),
                };
            }

            return {
                channel: 'push',
                status: 'failed',
                error: `All ${response.failureCount} device(s) failed`,
            };
        } catch (error) {
            return {
                channel: 'push',
                status: 'failed',
                error: error instanceof Error ? error.message : 'Unknown Firebase error',
            };
        }
    }

    /**
     * Send silent data-only push notification
     */
    async sendSilent(
        tokens: string[],
        data: Record<string, string>
    ): Promise<DeliveryResult> {
        if (!this.enabled || !this.initialized) {
            return {
                channel: 'push',
                status: 'failed',
                error: 'Push channel not enabled',
            };
        }

        try {
            const response = await admin.messaging().sendEachForMulticast({
                tokens,
                data,
                android: {
                    priority: 'normal',
                },
                apns: {
                    headers: {
                        'apns-priority': '5',
                        'apns-push-type': 'background',
                    },
                    payload: {
                        aps: {
                            'content-available': 1,
                        },
                    },
                },
            });

            return {
                channel: 'push',
                status: response.successCount > 0 ? 'sent' : 'failed',
                sentAt: response.successCount > 0 ? new Date() : undefined,
            };
        } catch (error) {
            return {
                channel: 'push',
                status: 'failed',
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * Validate device token with FCM
     */
    async validateToken(token: string): Promise<boolean> {
        if (!this.enabled || !this.initialized) {
            return false;
        }

        try {
            // Send a dry run to validate token
            await admin.messaging().send({
                token,
                notification: {
                    title: 'Validation',
                    body: 'Token validation test',
                },
            }, true); // dry run

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Build push payload from notification
     */
    private buildPayload(notification: NotificationPayload): PushPayload {
        const data: Record<string, string> = {
            notification_id: notification.notificationId,
            event_type: notification.eventType,
            user_id: notification.userId,
        };

        // Add action URL if present
        if (notification.actions?.length) {
            data['action_url'] = notification.actions[0]?.url ?? '';
        }

        // Add source ID for deep linking
        if (notification.eventSourceId) {
            data['source_id'] = notification.eventSourceId;
        }

        return {
            deviceTokens: [],
            title: notification.title,
            body: notification.message,
            data,
            android: {
                priority: notification.priority === 'critical' ? 'high' : 'normal',
                ttlSeconds: 3600,
            },
            apns: {
                priority: notification.priority === 'critical' ? 10 : 5,
                badge: 1,
            },
        };
    }

    /**
     * Check if push is available
     */
    isAvailable(): boolean {
        return this.enabled && this.initialized;
    }

    /**
     * Subscribe device to topic
     */
    async subscribeToTopic(tokens: string[], topic: string): Promise<void> {
        if (!this.initialized) return;

        try {
            await admin.messaging().subscribeToTopic(tokens, topic);
            logger.info('Devices subscribed to topic', { topic, count: tokens.length });
        } catch (error) {
            logger.error('Failed to subscribe to topic', { topic, error });
        }
    }

    /**
     * Unsubscribe device from topic
     */
    async unsubscribeFromTopic(tokens: string[], topic: string): Promise<void> {
        if (!this.initialized) return;

        try {
            await admin.messaging().unsubscribeFromTopic(tokens, topic);
            logger.info('Devices unsubscribed from topic', { topic, count: tokens.length });
        } catch (error) {
            logger.error('Failed to unsubscribe from topic', { topic, error });
        }
    }
}

// Export singleton
export const pushHandler = new PushHandler();
