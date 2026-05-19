'use strict';

/**
 * Central configuration. The same image runs both remotely (dev) and
 * installed on the HCU. Defaults follow the Connect API container
 * contract (see docs 4.2 "Container environment").
 *
 * Auth token precedence:
 *   1. /TOKEN file (present when running as installed plugin)
 *   2. HMIP_HCU_AUTH_TOKEN env var (for remote development)
 *
 * Velux settings persistence:
 *   Values entered via the HCU config UI are stored to
 *   ${VELUX_DATA_DIR:-/data}/config.json so they survive plugin restarts.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ID = process.env.HMIP_PLUGIN_ID || 'de.homematicip.plugin.velux';

function readTokenFile(p) {
    try {
        return fs.readFileSync(p, 'utf8').trim();
    } catch (_) {
        return '';
    }
}

const tokenFromFile = readTokenFile('/TOKEN');
const authToken = tokenFromFile || process.env.HMIP_HCU_AUTH_TOKEN || '';

// Running as installed plugin? Then we talk to host.containers.internal.
// Otherwise fall back to hcu1-XXXX.local or whatever ENV provides.
const isInstalled = Boolean(tokenFromFile);
const defaultHost = isInstalled ? 'host.containers.internal' : 'hcu1.local';

const DATA_DIR = process.env.VELUX_DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function parseNodeFilter(value) {
    return String(value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n));
}

function loadPersisted() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
            return JSON.parse(raw) || {};
        }
    } catch (err) {
        // logger not yet available at load time
        console.warn('[config] could not load persisted config:', err.message);
    }
    return {};
}

const persisted = loadPersisted();

const velux = {
    host: persisted.host || process.env.VELUX_HOST || '',
    password: persisted.password || process.env.VELUX_PASSWORD || '',
    nodeFilter: Array.isArray(persisted.nodeFilter)
        ? persisted.nodeFilter.filter((n) => Number.isFinite(n))
        : parseNodeFilter(process.env.VELUX_NODES),
    reconnectDelayMs: 10000,
    // How often to send a cheap GW_GET_VERSION_REQ to keep the KLF TLS
    // session warm. 0 disables the keep-alive entirely.
    keepaliveMinutes: Number.isFinite(persisted.keepaliveMinutes)
        ? persisted.keepaliveMinutes
        : Number.isFinite(Number(process.env.VELUX_KEEPALIVE_MINUTES))
        ? Number(process.env.VELUX_KEEPALIVE_MINUTES)
        : 5,
    // Daily KLF-200 maintenance:
    //   'OFF'       — do nothing
    //   'RECONNECT' — drop the TLS session and reconnect (cheap, ~5s)
    //   'REBOOT'    — send GW_REBOOT_REQ; the gateway power-cycles, ~60s
    //                 of unreachability before the next connect succeeds.
    // Migrate the previous boolean dailyResetEnabled into the new field
    // so existing installs keep their behaviour.
    dailyResetMode: (() => {
        if (typeof persisted.dailyResetMode === 'string') {
            const m = String(persisted.dailyResetMode).toUpperCase();
            if (['OFF', 'RECONNECT', 'REBOOT'].includes(m)) return m;
        }
        if (typeof persisted.dailyResetEnabled === 'boolean') {
            return persisted.dailyResetEnabled ? 'RECONNECT' : 'OFF';
        }
        const env = String(process.env.VELUX_DAILY_RESET_MODE || '').toUpperCase();
        if (['OFF', 'RECONNECT', 'REBOOT'].includes(env)) return env;
        if (String(process.env.VELUX_DAILY_RESET_ENABLED || '').toLowerCase() === 'false') {
            return 'OFF';
        }
        return 'RECONNECT';
    })(),
    // Local-time HH:MM at which the daily maintenance fires.
    dailyResetTime:
        (typeof persisted.dailyResetTime === 'string' && persisted.dailyResetTime) ||
        process.env.VELUX_DAILY_RESET_TIME ||
        '03:00',
};

function saveVelux() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(
            CONFIG_FILE,
            JSON.stringify(
                {
                    host: velux.host,
                    password: velux.password,
                    nodeFilter: velux.nodeFilter,
                    keepaliveMinutes: velux.keepaliveMinutes,
                    dailyResetMode: velux.dailyResetMode,
                    dailyResetTime: velux.dailyResetTime,
                },
                null,
                2,
            ),
            'utf8',
        );
        return true;
    } catch (err) {
        console.warn('[config] could not persist velux config:', err.message);
        return false;
    }
}

module.exports = {
    pluginId: PLUGIN_ID,
    isInstalled,

    hcu: {
        host: process.env.HMIP_HCU_HOST || defaultHost,
        port: Number(process.env.HMIP_HCU_PORT || 9001),
        authToken,
        reconnectDelayMs: 5000,
    },

    velux,
    saveVelux,

    log: {
        level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
    },
};
