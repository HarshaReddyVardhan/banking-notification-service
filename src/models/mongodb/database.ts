/**
 * Banking Notification Service - MongoDB Connection
 * 
 * Mongoose connection setup for user notification preferences.
 */

import mongoose from 'mongoose';
import { config } from '../../config/config';
import { logger } from '../../utils/logger';

/**
 * Initialize MongoDB connection
 */
export async function initializeMongoDB(): Promise<void> {
    try {
        await mongoose.connect(config.mongodb.url, config.mongodb.options);

        logger.info('MongoDB connection established', {
            url: config.mongodb.url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'), // Mask credentials
        });

        // Connection event handlers
        mongoose.connection.on('error', (err) => {
            logger.error('MongoDB connection error', { error: err });
        });

        mongoose.connection.on('disconnected', () => {
            logger.warn('MongoDB disconnected');
        });

        mongoose.connection.on('reconnected', () => {
            logger.info('MongoDB reconnected');
        });

    } catch (error) {
        logger.error('Failed to connect to MongoDB', { error });
        throw error;
    }
}

/**
 * Close MongoDB connection gracefully
 */
export async function closeMongoDB(): Promise<void> {
    try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed');
    } catch (error) {
        logger.error('Error closing MongoDB connection', { error });
    }
}

export { mongoose };
