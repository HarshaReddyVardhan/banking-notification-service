/**
 * Banking Notification Service - Request Validation Middleware
 * 
 * Joi-based request validation for API endpoints.
 */

import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';
import { ApiError } from './errorHandler';

// ==================== Validation Schemas ====================

// Notification request validation
export const sendNotificationSchema = Joi.object({
    userId: Joi.string().uuid().required(),
    eventType: Joi.string().max(50).required(),
    title: Joi.string().max(255).required(),
    message: Joi.string().max(2000).required(),
    eventSourceId: Joi.string().max(255).optional(),
    priority: Joi.string().valid('low', 'medium', 'high', 'critical').optional(),
    data: Joi.object().optional(),
    channels: Joi.array().items(
        Joi.string().valid('websocket', 'sms', 'email', 'push')
    ).optional(),
    correlationId: Joi.string().max(100).optional(),
});

// User preferences update validation
export const updatePreferencesSchema = Joi.object({
    channels: Joi.object({
        websocket: Joi.object({
            enabled: Joi.boolean(),
        }).optional(),
        sms: Joi.object({
            enabled: Joi.boolean(),
            phoneNumber: Joi.string().pattern(/^\+[1-9]\d{1,14}$/).optional(),
        }).optional(),
        email: Joi.object({
            enabled: Joi.boolean(),
            address: Joi.string().email().optional(),
            digestEnabled: Joi.boolean(),
            digestFrequency: Joi.string().valid('immediate', 'hourly', 'daily', 'weekly'),
            digestTime: Joi.string().pattern(/^\d{2}:\d{2}$/).optional(),
        }).optional(),
        push: Joi.object({
            enabled: Joi.boolean(),
        }).optional(),
    }).optional(),
    notificationTypes: Joi.object().pattern(
        Joi.string(),
        Joi.object({
            enabled: Joi.boolean(),
            channels: Joi.array().items(
                Joi.string().valid('websocket', 'sms', 'email', 'push')
            ),
            quietHoursOverride: Joi.boolean(),
        })
    ).optional(),
    quietHours: Joi.object({
        enabled: Joi.boolean(),
        start: Joi.string().pattern(/^\d{2}:\d{2}$/),
        end: Joi.string().pattern(/^\d{2}:\d{2}$/),
        timezone: Joi.string().max(50),
        criticalAlertsBypass: Joi.boolean(),
    }).optional(),
    rateLimits: Joi.object({
        smsPerHour: Joi.number().integer().min(0).max(100),
        smsPerDay: Joi.number().integer().min(0).max(500),
        emailPerHour: Joi.number().integer().min(0).max(100),
        emailPerDay: Joi.number().integer().min(0).max(500),
        pushPerHour: Joi.number().integer().min(0).max(200),
        pushPerDay: Joi.number().integer().min(0).max(1000),
    }).optional(),
    doNotContact: Joi.object({
        enabled: Joi.boolean(),
        reason: Joi.string().valid('user_requested', 'unsubscribed', 'invalid_contact'),
        until: Joi.date().iso().optional(),
    }).optional(),
});

// Device registration validation
export const registerDeviceSchema = Joi.object({
    deviceId: Joi.string().max(255).required(),
    deviceName: Joi.string().max(100).optional(),
    token: Joi.string().max(1000).required(),
    platform: Joi.string().valid('ios', 'android').required(),
});

// Query params for notification history
export const historyQuerySchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    eventType: Joi.string().max(50).optional(),
    channel: Joi.string().valid('websocket', 'sms', 'email', 'push').optional(),
    status: Joi.string().valid('pending', 'sent', 'delivered', 'failed').optional(),
    startDate: Joi.date().iso().optional(),
    endDate: Joi.date().iso().optional(),
});

// ==================== Validation Middleware ====================

/**
 * Validate request body against schema
 */
export function validateBody(schema: Joi.ObjectSchema) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const { error, value } = schema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true,
        });

        if (error) {
            const details = error.details.map((d) => ({
                field: d.path.join('.'),
                message: d.message,
            }));

            throw ApiError.badRequest('Validation failed', { errors: details });
        }

        req.body = value;
        next();
    };
}

/**
 * Validate query parameters against schema
 */
export function validateQuery(schema: Joi.ObjectSchema) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const { error, value } = schema.validate(req.query, {
            abortEarly: false,
            stripUnknown: true,
        });

        if (error) {
            const details = error.details.map((d) => ({
                field: d.path.join('.'),
                message: d.message,
            }));

            throw ApiError.badRequest('Invalid query parameters', { errors: details });
        }

        req.query = value;
        next();
    };
}

/**
 * Validate UUID parameter
 */
export function validateUuidParam(paramName: string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const value = req.params[paramName];
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!value || !uuidRegex.test(value)) {
            throw ApiError.badRequest(`Invalid ${paramName} parameter`);
        }

        next();
    };
}
