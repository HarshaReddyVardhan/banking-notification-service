/**
 * Banking Notification Service - Preferences Routes
 * 
 * API endpoints for managing user notification preferences.
 */

import { Router, Request, Response } from 'express';
import {
    asyncHandler,
    authenticateUser,
    validateBody,
    updatePreferencesSchema,
    registerDeviceSchema,
    requireUserId,
} from '../middleware';
import { UserPreferences } from '../models';
import { rateLimiter } from '../redis/RateLimiter';

const router = Router();

/**
 * GET /preferences
 * Get user notification preferences
 */
router.get(
    '/',
    authenticateUser,
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);

        const preferences = await UserPreferences.findOrCreateByUserId(userId);

        // Return preferences without encrypted fields
        const response = {
            userId: preferences.userId,
            channels: {
                websocket: {
                    enabled: preferences.channels?.websocket?.enabled ?? true,
                },
                sms: {
                    enabled: preferences.channels?.sms?.enabled ?? true,
                    hasPhoneNumber: !!preferences.channels?.sms?.phoneNumber,
                    verifiedAt: preferences.channels?.sms?.verifiedAt,
                },
                email: {
                    enabled: preferences.channels?.email?.enabled ?? true,
                    hasEmail: !!preferences.channels?.email?.address,
                    verifiedAt: preferences.channels?.email?.verifiedAt,
                    digestEnabled: preferences.channels?.email?.digestEnabled ?? false,
                    digestFrequency: preferences.channels?.email?.digestFrequency ?? 'daily',
                    digestTime: preferences.channels?.email?.digestTime ?? '09:00',
                },
                push: {
                    enabled: preferences.channels?.push?.enabled ?? true,
                    deviceCount: preferences.channels?.push?.devices?.length ?? 0,
                },
            },
            notificationTypes: Object.fromEntries(preferences.notificationTypes ?? new Map()),
            quietHours: preferences.quietHours,
            rateLimits: preferences.rateLimits,
            doNotContact: {
                enabled: preferences.doNotContact?.enabled ?? false,
                until: preferences.doNotContact?.until,
            },
            createdAt: preferences.createdAt,
            updatedAt: preferences.updatedAt,
        };

        res.json({
            success: true,
            data: response,
            correlationId: req.correlationId,
        });
    })
);

/**
 * PUT /preferences
 * Update user notification preferences
 */
router.put(
    '/',
    authenticateUser,
    validateBody(updatePreferencesSchema),
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);
        const updates = req.body;

        const preferences = await UserPreferences.findOrCreateByUserId(userId);

        // Update channels
        if (updates.channels) {
            if (updates.channels.websocket) {
                preferences.channels.websocket = {
                    ...preferences.channels.websocket,
                    ...updates.channels.websocket,
                };
            }
            if (updates.channels.sms) {
                if (updates.channels.sms.phoneNumber) {
                    preferences.setEncryptedPhoneNumber(updates.channels.sms.phoneNumber);
                    delete updates.channels.sms.phoneNumber;
                }
                preferences.channels.sms = {
                    ...preferences.channels.sms,
                    ...updates.channels.sms,
                };
            }
            if (updates.channels.email) {
                if (updates.channels.email.address) {
                    preferences.setEncryptedEmail(updates.channels.email.address);
                    delete updates.channels.email.address;
                }
                preferences.channels.email = {
                    ...preferences.channels.email,
                    ...updates.channels.email,
                };
            }
            if (updates.channels.push) {
                preferences.channels.push = {
                    ...preferences.channels.push,
                    ...updates.channels.push,
                };
            }
        }

        // Update notification types
        if (updates.notificationTypes) {
            for (const [eventType, prefs] of Object.entries(updates.notificationTypes)) {
                preferences.notificationTypes.set(eventType as any, prefs as {
                    enabled: boolean;
                    channels: ('websocket' | 'sms' | 'email' | 'push')[];
                    quietHoursOverride: boolean;
                });
            }
        }

        // Update quiet hours
        if (updates.quietHours) {
            preferences.quietHours = {
                ...preferences.quietHours,
                ...updates.quietHours,
            };
        }

        // Update rate limits
        if (updates.rateLimits) {
            preferences.rateLimits = {
                ...preferences.rateLimits,
                ...updates.rateLimits,
            };
        }

        // Update do-not-contact
        if (updates.doNotContact !== undefined) {
            preferences.doNotContact = {
                ...preferences.doNotContact,
                ...updates.doNotContact,
                updatedAt: new Date(),
            };
        }

        await preferences.save();

        res.json({
            success: true,
            message: 'Preferences updated successfully',
            correlationId: req.correlationId,
        });
    })
);

/**
 * POST /preferences/devices
 * Register push notification device
 */
router.post(
    '/devices',
    authenticateUser,
    validateBody(registerDeviceSchema),
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);
        const { deviceId, deviceName, token, platform } = req.body;

        const preferences = await UserPreferences.findOrCreateByUserId(userId);

        // Initialize push devices array if needed
        if (!preferences.channels.push) {
            preferences.channels.push = { enabled: true, devices: [] };
        }
        if (!preferences.channels.push.devices) {
            preferences.channels.push.devices = [];
        }

        // Check if device already exists
        const existingIndex = preferences.channels.push.devices.findIndex(
            (d) => d.deviceId === deviceId
        );

        const deviceData = {
            deviceId,
            deviceName,
            token,
            platform: platform as 'ios' | 'android',
            lastActiveAt: new Date(),
            createdAt: new Date(),
        };

        if (existingIndex >= 0) {
            // Update existing device
            preferences.channels.push.devices[existingIndex] = {
                ...preferences.channels.push.devices[existingIndex],
                ...deviceData,
            };
        } else {
            // Add new device (limit to 10 devices per user)
            if (preferences.channels.push.devices.length >= 10) {
                // Remove oldest device
                preferences.channels.push.devices.shift();
            }
            preferences.channels.push.devices.push(deviceData);
        }

        await preferences.save();

        res.json({
            success: true,
            message: 'Device registered successfully',
            data: {
                deviceId,
                deviceCount: preferences.channels.push.devices.length,
            },
            correlationId: req.correlationId,
        });
    })
);

/**
 * DELETE /preferences/devices/:deviceId
 * Unregister push notification device
 */
router.delete(
    '/devices/:deviceId',
    authenticateUser,
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);
        const { deviceId } = req.params;

        const preferences = await UserPreferences.findOrCreateByUserId(userId);

        if (preferences.channels.push?.devices) {
            preferences.channels.push.devices = preferences.channels.push.devices.filter(
                (d) => d.deviceId !== deviceId
            );
            await preferences.save();
        }

        res.json({
            success: true,
            message: 'Device unregistered successfully',
            correlationId: req.correlationId,
        });
    })
);

/**
 * GET /preferences/usage
 * Get rate limit usage for current user
 */
router.get(
    '/usage',
    authenticateUser,
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);

        const usage = await rateLimiter.getUsage(userId);
        const preferences = await UserPreferences.findOrCreateByUserId(userId);

        res.json({
            success: true,
            data: {
                usage,
                limits: preferences.rateLimits,
            },
            correlationId: req.correlationId,
        });
    })
);

/**
 * POST /preferences/unsubscribe
 * Unsubscribe from all notifications
 */
router.post(
    '/unsubscribe',
    authenticateUser,
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);
        const { reason } = req.body as { reason?: string };

        const preferences = await UserPreferences.findOrCreateByUserId(userId);

        preferences.doNotContact = {
            enabled: true,
            reason: reason ?? 'user_requested',
            updatedAt: new Date(),
        };

        await preferences.save();

        res.json({
            success: true,
            message: 'Successfully unsubscribed from notifications',
            correlationId: req.correlationId,
        });
    })
);

/**
 * POST /preferences/resubscribe
 * Re-subscribe to notifications
 */
router.post(
    '/resubscribe',
    authenticateUser,
    asyncHandler(async (req: Request, res: Response) => {
        const userId = requireUserId(req);

        const preferences = await UserPreferences.findOrCreateByUserId(userId);

        preferences.doNotContact = {
            enabled: false,
            updatedAt: new Date(),
        };

        await preferences.save();

        res.json({
            success: true,
            message: 'Successfully re-subscribed to notifications',
            correlationId: req.correlationId,
        });
    })
);

export default router;
