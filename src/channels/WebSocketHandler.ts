/**
 * Banking Notification Service - WebSocket Channel Handler
 * 
 * Sends real-time notifications via the WebSocket Gateway.
 * Latency target: <50ms for immediate user feedback.
 */

import { config } from '../../config/config';
import { logger, logChannelDelivery } from '../../utils/logger';
import { WebSocketPayload, DeliveryResult, NotificationPayload } from '../../types';

export interface WebSocketGatewayResponse {
    success: boolean;
    messageId?: string;
    userOnline?: boolean;
    error?: string;
}

export class WebSocketHandler {
    private gatewayUrl: string;
    private apiKey: string;
    private timeout: number = 5000; // 5 seconds

    constructor() {
        this.gatewayUrl = config.websocket.gatewayUrl;
        this.apiKey = config.websocket.apiKey;
    }

    /**
     * Send notification via WebSocket Gateway
     */
    async send(
        userId: string,
        notification: NotificationPayload
    ): Promise<DeliveryResult> {
        const startTime = Date.now();

        const payload: WebSocketPayload = {
            userId,
            notification: {
                type: notification.eventType,
                title: notification.title,
                message: notification.message,
                data: notification.data,
                actions: notification.actions,
                timestamp: new Date().toISOString(),
            },
        };

        try {
            const response = await this.sendToGateway(payload);
            const latencyMs = Date.now() - startTime;

            logChannelDelivery({
                channel: 'websocket',
                notificationId: notification.notificationId,
                userId,
                status: response.success ? 'sent' : 'failed',
                provider: 'internal',
                providerMessageId: response.messageId,
                latencyMs,
                error: response.error,
            });

            if (response.success) {
                return {
                    channel: 'websocket',
                    status: response.userOnline ? 'delivered' : 'sent',
                    providerMessageId: response.messageId,
                    sentAt: new Date(),
                };
            }

            return {
                channel: 'websocket',
                status: 'failed',
                error: response.error ?? 'Gateway returned failure',
            };
        } catch (error) {
            const latencyMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            logChannelDelivery({
                channel: 'websocket',
                notificationId: notification.notificationId,
                userId,
                status: 'failed',
                provider: 'internal',
                latencyMs,
                error: errorMessage,
            });

            return {
                channel: 'websocket',
                status: 'failed',
                error: errorMessage,
            };
        }
    }

    /**
     * Check if user is currently connected
     */
    async isUserOnline(userId: string): Promise<boolean> {
        try {
            const response = await fetch(
                `${this.gatewayUrl}/api/connections/${userId}`,
                {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': this.apiKey,
                    },
                    signal: AbortSignal.timeout(this.timeout),
                }
            );

            if (response.ok) {
                const data = await response.json() as { online?: boolean };
                return data.online ?? false;
            }

            return false;
        } catch (error) {
            logger.warn('Failed to check user online status', { userId, error });
            return false;
        }
    }

    /**
     * Send payload to WebSocket Gateway
     */
    private async sendToGateway(payload: WebSocketPayload): Promise<WebSocketGatewayResponse> {
        const response = await fetch(
            `${this.gatewayUrl}/api/notifications/send`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.apiKey,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(this.timeout),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            return {
                success: false,
                error: `Gateway error: ${response.status} - ${errorText}`,
            };
        }

        const data = await response.json() as WebSocketGatewayResponse;
        return data;
    }

    /**
     * Broadcast notification to multiple users
     */
    async broadcast(
        userIds: string[],
        notification: Omit<NotificationPayload, 'userId' | 'notificationId'>
    ): Promise<Map<string, DeliveryResult>> {
        const results = new Map<string, DeliveryResult>();

        // Send in parallel, but limit concurrency
        const batchSize = 50;
        for (let i = 0; i < userIds.length; i += batchSize) {
            const batch = userIds.slice(i, i + batchSize);
            const promises = batch.map(async (userId) => {
                const fullPayload: NotificationPayload = {
                    ...notification,
                    userId,
                    notificationId: `broadcast_${Date.now()}_${userId}`,
                };
                const result = await this.send(userId, fullPayload);
                results.set(userId, result);
            });
            await Promise.all(promises);
        }

        return results;
    }
}

// Export singleton
export const webSocketHandler = new WebSocketHandler();
