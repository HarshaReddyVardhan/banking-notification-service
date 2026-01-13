/**
 * Banking Notification Service - Middleware Index
 * 
 * Exports all middleware functions.
 */

export { errorHandler, notFoundHandler, asyncHandler, ApiError } from './errorHandler';
export { authenticateInternalApi, authenticateUser, optionalAuth, requireUserId } from './authentication';
export {
    validateBody,
    validateQuery,
    validateUuidParam,
    sendNotificationSchema,
    updatePreferencesSchema,
    registerDeviceSchema,
    historyQuerySchema,
} from './validation';
