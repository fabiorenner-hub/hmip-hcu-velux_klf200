'use strict';

const { log } = require('./config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[log.level] ?? LEVELS.info;

function ts() {
    return new Date().toISOString();
}

function make(level) {
    const n = LEVELS[level];
    return (...args) => {
        if (n <= current) {
            // eslint-disable-next-line no-console
            console[level === 'debug' ? 'log' : level](`[${ts()}] [${level.toUpperCase()}]`, ...args);
        }
    };
}

module.exports = {
    error: make('error'),
    warn: make('warn'),
    info: make('info'),
    debug: make('debug'),
};
