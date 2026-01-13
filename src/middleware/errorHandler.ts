/**
 * Banking Notification Service - Error Handler Middleware
 * 
 * Centralized error handling with proper status codes and logging.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

// Custom error class for API errors
export class ApiError extends Error {
    statusCode: number;
    code: string;
    details?: Record<string, unknown>;

    constructor(
        statusCode: number,
        message: string,
        code: string = 'INTERNAL_ERROR',
        details?: Record<string, unknown>
    ) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }

    static badRequest(message: string, details?: Record<string, unknown>): ApiError {
        return new ApiError(400, message, 'BAD_REQUEST', details);
    }

    static unauthorized(message: string = 'Unauthorized'): ApiError {
        return new ApiError(401, message, 'UNAUTHORIZED');
    }

    static forbidden(message: string = 'Access forbidden'): ApiError {
        return new ApiError(403, message, 'FORBIDDEN');
    }

    static notFound(message: string = 'Resource not found'): ApiError {
        return new ApiError(404, message, 'NOT_FOUND');
    }

    static conflict(message: string, details?: Record<string, unknown>): ApiError {
        return new ApiError(409, message, 'CONFLICT', details);
    }

    static tooManyRequests(message: string = 'Too many requests'): ApiError {
        return new ApiError(429, message, 'RATE_LIMITED');
    }

    static internal(message: string = 'Internal server error'): ApiError {
        return new ApiError(500, message, 'INTERNAL_ERROR');
    }
}

/**
 * Global error handler middleware
 */
export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction
): void {
    const correlationId = (req as { correlationId?: string }).correlationId;

    if (err instanceof ApiError) {
        logger.warn('API error', {
            statusCode: err.statusCode,
            code: err.code,
            message: err.message,
            path: req.path,
            correlationId,
        });

        res.status(err.statusCode).json({
            success: false,
            error: {
                code: err.code,
                message: err.message,
                details: err.details,
            },
            correlationId,
        });
        return;
    }

    // Log unexpected errors
    logger.error('Unexpected error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        correlationId,
    });

    res.status(500).json({
        success: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
        },
        correlationId,
    });
}

/**
 * 404 Not Found handler
 */
export function notFoundHandler(req: Request, res: Response): void {
    const correlationId = (req as { correlationId?: string }).correlationId;

    res.status(404).json({
        success: false,
        error: {
            code: 'NOT_FOUND',
            message: `Route ${req.method} ${req.path} not found`,
        },
        correlationId,
    });
}

/**
 * Async handler wrapper to catch errors
 */
export function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
