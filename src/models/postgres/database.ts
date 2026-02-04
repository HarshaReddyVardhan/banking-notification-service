/**
 * Banking Notification Service - PostgreSQL Database Connection
 * 
 * Sequelize ORM setup for notification history storage.
 */

import { Sequelize, Options } from 'sequelize';
import { config } from '../../config/config';
import { logger } from '../../utils/logger';

// Build connection options
const sequelizeOptions: Options = {
    host: config.database.host,
    port: config.database.port,
    dialect: 'postgres',
    logging: (msg) => logger.debug(msg),
    pool: {
        min: config.database.pool.min,
        max: config.database.pool.max,
        acquire: config.database.pool.acquire,
        idle: config.database.pool.idle,
    },
    dialectOptions: config.database.ssl
        ? {
            ssl: {
                require: true,
                rejectUnauthorized: config.database.sslRejectUnauthorized,
            },
        }
        : {},
    define: {
        underscored: true, // Use snake_case for columns
        timestamps: true,
    },
};

// Create Sequelize instance
export const sequelize = new Sequelize(
    config.database.name,
    config.database.user,
    config.database.password,
    sequelizeOptions
);

/**
 * Initialize database connection and sync models
 */
export async function initializeDatabase(): Promise<void> {
    try {
        // Test connection
        await sequelize.authenticate();
        logger.info('PostgreSQL connection established', {
            host: config.database.host,
            database: config.database.name,
        });

        // Sync models (use migrations in production)
        if (config.isDevelopment()) {
            await sequelize.sync({ alter: true });
            logger.info('Database models synchronized');
        }
    } catch (error) {
        logger.error('Unable to connect to PostgreSQL', { error });
        throw error;
    }
}

/**
 * Close database connection gracefully
 */
export async function closeDatabase(): Promise<void> {
    try {
        await sequelize.close();
        logger.info('PostgreSQL connection closed');
    } catch (error) {
        logger.error('Error closing PostgreSQL connection', { error });
    }
}
