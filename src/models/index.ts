/**
 * Banking Notification Service - Models Index
 * 
 * Exports all database models and initialization functions.
 */

// PostgreSQL
export { sequelize, initializeDatabase, closeDatabase } from './postgres/database';
export { NotificationEvent } from './postgres/NotificationEvent';
export { DeadLetterQueue } from './postgres/DeadLetterQueue';

// MongoDB
export { mongoose, initializeMongoDB, closeMongoDB } from './mongodb/database';
export { UserPreferences, IUserPreferences } from './mongodb/UserPreferences';
