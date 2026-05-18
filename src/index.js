'use strict';

const logger = require('./logger');
const { VeluxPlugin } = require('./plugin');
const cfg = require('./config');

async function main() {
    logger.info(`Starting ${cfg.pluginId} (log level ${cfg.log.level})`);
    const plugin = new VeluxPlugin();

    const shutdown = async (signal) => {
        logger.info(`Received ${signal}, shutting down`);
        try {
            await plugin.stop();
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('unhandledRejection', (err) => logger.error('unhandledRejection:', err));

    await plugin.start();
}

main().catch((err) => {
    logger.error('Fatal startup error:', err);
    process.exit(1);
});
