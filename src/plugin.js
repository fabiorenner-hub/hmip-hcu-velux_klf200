'use strict';

/**
 * Bridge between the Homematic IP HCU Connect API and a Velux KLF-200 gateway.
 *
 * Conforms to Connect API 1.0.1. Message flow:
 *
 *   Startup:   ws OPEN
 *              plugin --PLUGIN_STATE_RESPONSE(READY|CONFIG_REQUIRED|ERROR)--> HCU
 *              HCU     --DISCOVER_REQUEST-->           plugin
 *              plugin --DISCOVER_RESPONSE--->          HCU    (devices with deviceType)
 *              HCU     --INCLUSION_EVENT-->           plugin
 *              plugin --STATUS_EVENT (per device)-->  HCU
 *
 *   Control:   HCU     --CONTROL_REQUEST-->           plugin
 *              plugin --CONTROL_RESPONSE(success,deviceId)--> HCU
 *              plugin --STATUS_EVENT--->              HCU   (when KLF confirms)
 *
 *   Config:    HCU     --CONFIG_TEMPLATE_REQUEST-->   plugin
 *              plugin --CONFIG_TEMPLATE_RESPONSE-->   HCU   (groups + properties map)
 *              HCU     --CONFIG_UPDATE_REQUEST-->     plugin
 *              plugin --CONFIG_UPDATE_RESPONSE(APPLIED|FAILED|PENDING)--> HCU
 *              plugin --PLUGIN_STATE_RESPONSE(READY)--> HCU  (new state after update)
 */

const logger = require('./logger');
const { HcuClient } = require('./hcu-client');
const { VeluxClient } = require('./velux-client');
const { toDevice, toStatus, toStatusEvent, parseDeviceId } = require('./device-mapper');
const cfg = require('./config');

class VeluxPlugin {
    constructor() {
        this.hcu = new HcuClient();
        this.velux = new VeluxClient();
        this.includedDevices = new Set(); // device ids accepted by the HCU
    }

    async start() {
        this._wireVelux();
        this._wireHcu();
        this.hcu.start();
        // Velux only connects once config is present; fire-and-forget.
        this.velux.start().catch((err) => logger.error('Velux start failed:', err));
    }

    async stop() {
        this.hcu.stop();
        await this.velux.stop();
    }

    _wireVelux() {
        this.velux.on('ready', () => {
            logger.info(`Velux ready with ${this.velux.listNodes().length} node(s)`);
            // Don't push statuses here; the HCU will react to our implicit
            // PluginState(READY) with a DiscoverRequest first, and only once
            // it has sent back an InclusionEvent do we know which deviceIds
            // it has accepted. Sending statuses early triggers "Device not
            // found".
            this.hcu.sendPluginState(this._readiness());
        });
        // Only forward actual position changes via STATUS_EVENT. Metadata
        // changes (rename/order/placement from GW_NODE_INFORMATION_CHANGED_NTF
        // or the periodic full-info poll) are delivered to the HCU on the
        // next DiscoverRequest — forwarding them as STATUS_EVENT floods the
        // message queue and stalls the HCU ↔ iOS sync ("Verbindung wird
        // hergestellt").
        this.velux.on('positionChanged', (node) => this._emitStatusEvent(node));
    }

    _wireHcu() {
        this.hcu.on('open', () => {
            logger.info(`Plugin ${cfg.pluginId} connected to HCU.`);
            // Send the initial PLUGIN_STATE_RESPONSE with the true readiness
            // state. Sending an uninformed "READY" when KLF is not yet
            // connected makes HCU run an immediate DiscoverRequest against an
            // empty node list and cache it until the next restart.
            this.hcu.sendPluginState(this._readiness());
        });

        this.hcu.on('PLUGIN_STATE_REQUEST', (_body, env) => {
            // Use sendPluginState so the friendlyName is included consistently.
            const status = this._readiness();
            this.hcu.send(
                'PLUGIN_STATE_RESPONSE',
                {
                    pluginReadinessStatus: status,
                    friendlyName: {
                        de: 'Velux KLF-200',
                        en: 'Velux KLF-200',
                    },
                },
                env,
            );
        });

        this.hcu.on('DISCOVER_REQUEST', (_body, env) => {
            const devices = this.velux.listNodes().map(toDevice);
            this.hcu.send('DISCOVER_RESPONSE', { success: true, devices }, env);
        });

        this.hcu.on('INCLUSION_EVENT', (body) => {
            const ids = body.deviceIds || [];
            ids.forEach((id) => this.includedDevices.add(id));
            logger.info(`HCU included ${ids.length} device(s); total ${this.includedDevices.size}`);
            // Spec §3.2: "Handle any incoming InclusionEvent by sending a
            // StatusResponse containing states of all included plugin
            // devices." StatusResponse body is { success, devices: Set<Device> }.
            const devices = this.velux
                .listNodes()
                .map(toStatus)
                .filter((d) => this.includedDevices.has(d.deviceId));
            if (devices.length) {
                this.hcu.send('STATUS_RESPONSE', { success: true, devices });
            }
        });

        this.hcu.on('EXCLUSION_EVENT', (body) => {
            (body.deviceIds || []).forEach((id) => this.includedDevices.delete(id));
            logger.info(`HCU excluded ${body.deviceIds ? body.deviceIds.length : 0} device(s)`);
        });

        this.hcu.on('STATUS_REQUEST', (body, env) => {
            const wanted = new Set(body.deviceIds || []);
            const devices = this.velux
                .listNodes()
                .map(toStatus)
                .filter((s) => wanted.size === 0 || wanted.has(s.deviceId));
            this.hcu.send('STATUS_RESPONSE', { success: true, devices }, env);
        });

        this.hcu.on('CONTROL_REQUEST', (body, env) => this._handleControl(body, env));

        this.hcu.on('CONFIG_TEMPLATE_REQUEST', (body, env) =>
            this._sendConfigTemplate(env, (body && body.languageCode) || 'de'),
        );
        this.hcu.on('CONFIG_UPDATE_REQUEST', (body, env) => this._handleConfigUpdate(body, env));

        this.hcu.on('ERROR_RESPONSE', (body) => {
            logger.warn('HCU ERROR_RESPONSE:', body);
        });
    }

    _readiness() {
        if (!cfg.velux.host || !cfg.velux.password) return 'CONFIG_REQUIRED';
        // HCU only accepts READY | CONFIG_REQUIRED | ERROR.
        if (!this.velux.connected) return 'ERROR';
        return 'READY';
    }

    _pushAllStatuses() {
        const statuses = this.velux
            .listNodes()
            .map(toStatus)
            .filter((s) => this.includedDevices.has(s.deviceId));
        if (statuses.length) this.hcu.send('STATUS_RESPONSE', { success: true, devices: statuses });
    }

    _emitStatusEvent(node) {
        const event = toStatusEvent(node);
        // STATUS_EVENT (§6.3.10) is only valid for devices the HCU has
        // already included via INCLUSION_EVENT; otherwise we get "Device
        // not found" back.
        if (!this.includedDevices.has(event.deviceId)) {
            logger.debug(`Skipping STATUS_EVENT for non-included ${event.deviceId}`);
            return;
        }
        const levelFeat = (event.features || []).find((f) => f.type === 'shutterLevel');
        const shown = levelFeat ? levelFeat.shutterLevel : '?';
        logger.info(`STATUS_EVENT -> ${event.deviceId} shutterLevel=${shown}`);
        this.hcu.send('STATUS_EVENT', event);
    }

    async _handleControl(body, env) {
        const { deviceId, features, path } = body;
        const nodeId = parseDeviceId(deviceId);
        if (nodeId == null) {
            return this._controlError(env, deviceId, 'UNKNOWN_DEVICE', `Unknown device ${deviceId}`);
        }

        try {
            // The HCU sends either a desired feature state (shutterLevel) or a
            // system-style path like /hmip/device/control/setShutterLevel.
            const desiredLevel = (features || []).find((f) => f.type === 'shutterLevel');
            const isStop = path && path.endsWith('/stop');

            if (isStop) {
                await this.velux.stopMovement(nodeId);
            } else if (desiredLevel && typeof desiredLevel.shutterLevel === 'number') {
                await this.velux.setShutterLevel(nodeId, desiredLevel.shutterLevel);
            } else {
                return this._controlError(env, deviceId, 'INVALID_REQUEST', 'No supported control payload');
            }

            // ControlResponse schema (Connect API 6.3.3):
            //   { success: boolean, deviceId: String }
            this.hcu.send('CONTROL_RESPONSE', { success: true, deviceId }, env);
        } catch (err) {
            logger.error(`Control failed for ${deviceId}:`, err);
            this._controlError(env, deviceId, 'INTERNAL_ERROR', err.message || 'unknown');
        }
    }

    _controlError(env, deviceId, key, message) {
        this.hcu.send(
            'CONTROL_RESPONSE',
            {
                success: false,
                deviceId,
                error: { code: key, message },
            },
            env,
        );
    }

    _sendConfigTemplate(env, languageCode) {
        const de = String(languageCode || 'de').toLowerCase().startsWith('de');
        const t = (deText, enText) => (de ? deText : enText);

        this.hcu.send(
            'CONFIG_TEMPLATE_RESPONSE',
            {
                groups: {
                    connection: {
                        friendlyName: t('KLF-200 Verbindung', 'KLF-200 connection'),
                        description: t(
                            'Zugangsdaten zum Velux KLF-200 Gateway.',
                            'Credentials for the Velux KLF-200 gateway.',
                        ),
                        order: 1,
                    },
                    filter: {
                        friendlyName: t('Geräteauswahl', 'Device selection'),
                        description: t(
                            'Optionale Einschränkung auf bestimmte Node-IDs.',
                            'Optional restriction to specific node IDs.',
                        ),
                        order: 2,
                    },
                    reliability: {
                        friendlyName: t('Verbindungsstabilität', 'Connection reliability'),
                        description: t(
                            'Keep-Alive- und Tagesreset-Optionen, die helfen, einen festgefahrenen KLF-200 zu vermeiden.',
                            'Keep-alive and daily-reset options that help avoid a wedged KLF-200.',
                        ),
                        order: 3,
                    },
                },
                properties: {
                    VELUX_HOST: {
                        dataType: 'STRING',
                        friendlyName: t('KLF-200 Hostname oder IP', 'KLF-200 hostname or IP'),
                        description: t(
                            'Hostname oder IP des KLF-200 Gateways im lokalen Netzwerk.',
                            'Hostname or IP of the KLF-200 gateway on your local network.',
                        ),
                        minimumLength: 3,
                        maximumLength: 255,
                        currentValue: cfg.velux.host,
                        required: true,
                        groupId: 'connection',
                        order: 1,
                    },
                    VELUX_PASSWORD: {
                        dataType: 'PASSWORD',
                        friendlyName: t('KLF-200 WLAN-Passwort', 'KLF-200 Wi-Fi password'),
                        description: t(
                            'Das auf dem KLF-200 Gerät aufgedruckte WLAN-Passwort.',
                            'The Wi-Fi password printed on the KLF-200 device.',
                        ),
                        minimumLength: 1,
                        maximumLength: 128,
                        required: true,
                        groupId: 'connection',
                        order: 2,
                    },
                    VELUX_NODES: {
                        dataType: 'STRING',
                        friendlyName: t('Node-IDs (optional)', 'Node IDs (optional)'),
                        description: t(
                            'Komma-getrennte Liste von Node-IDs, die angebunden werden sollen. Leer = alle Geräte.',
                            'Comma-separated list of node IDs to expose. Leave empty for all devices.',
                        ),
                        minimumLength: 0,
                        maximumLength: 255,
                        currentValue: cfg.velux.nodeFilter.join(','),
                        required: false,
                        groupId: 'filter',
                        order: 1,
                    },
                    VELUX_KEEPALIVE_MINUTES: {
                        dataType: 'INTEGER',
                        friendlyName: t('Keep-Alive Intervall (Minuten)', 'Keep-alive interval (minutes)'),
                        description: t(
                            'Wie oft das Plugin einen leichten Ping zum KLF-200 sendet, um die TLS-Sitzung offen zu halten. 0 deaktiviert den Ping.',
                            'How often the plugin sends a lightweight ping to the KLF-200 to keep the TLS session alive. 0 disables it.',
                        ),
                        minimumValue: 0,
                        maximumValue: 60,
                        currentValue: cfg.velux.keepaliveMinutes,
                        required: false,
                        groupId: 'reliability',
                        order: 1,
                    },
                    VELUX_DAILY_RESET_MODE: {
                        dataType: 'STRING',
                        friendlyName: t('Tägliche Wartung', 'Daily maintenance'),
                        description: t(
                            'Erlaubte Werte: OFF (aus), RECONNECT (weiche Trennung & Reconnect), REBOOT (echter Hardware-Neustart des KLF-200, ca. 60s nicht erreichbar).',
                            'Allowed values: OFF, RECONNECT (soft drop & reconnect), REBOOT (hardware power-cycle of the KLF-200, ~60s unreachable).',
                        ),
                        minimumLength: 3,
                        maximumLength: 9,
                        currentValue: cfg.velux.dailyResetMode,
                        required: false,
                        groupId: 'reliability',
                        order: 2,
                    },
                    VELUX_DAILY_RESET_TIME: {
                        dataType: 'STRING',
                        friendlyName: t('Reset-Zeit (HH:MM)', 'Reset time (HH:MM)'),
                        description: t(
                            'Lokale Uhrzeit für den täglichen Reset im Format HH:MM (24h). Standard 03:00.',
                            'Local time for the daily reset in HH:MM (24h) format. Default 03:00.',
                        ),
                        minimumLength: 4,
                        maximumLength: 5,
                        currentValue: cfg.velux.dailyResetTime,
                        required: false,
                        groupId: 'reliability',
                        order: 3,
                    },
                },
            },
            env,
        );
    }

    async _handleConfigUpdate(body, env) {
        try {
            // HCU sends body.properties as a flat map { KEY: value } where value
            // is the currentValue typed according to the template's dataType.
            const raw = body.properties || {};
            const get = (key) => {
                if (raw == null) return undefined;
                const v = raw[key];
                // Be liberal: accept both flat values and { currentValue } wrappers.
                if (v && typeof v === 'object' && 'currentValue' in v) return v.currentValue;
                return v;
            };

            const host = get('VELUX_HOST');
            const password = get('VELUX_PASSWORD');
            const nodes = get('VELUX_NODES');
            const keepalive = get('VELUX_KEEPALIVE_MINUTES');
            const dailyResetMode = get('VELUX_DAILY_RESET_MODE');
            const dailyResetTime = get('VELUX_DAILY_RESET_TIME');

            if (host !== undefined) cfg.velux.host = String(host || '').trim();
            if (password !== undefined && password !== null && password !== '') {
                cfg.velux.password = String(password);
            }
            if (nodes !== undefined) {
                cfg.velux.nodeFilter = String(nodes || '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map(Number)
                    .filter((n) => Number.isFinite(n));
            }
            if (keepalive !== undefined && keepalive !== null && keepalive !== '') {
                const n = Number(keepalive);
                if (Number.isFinite(n) && n >= 0 && n <= 60) {
                    cfg.velux.keepaliveMinutes = Math.floor(n);
                }
            }
            if (dailyResetMode !== undefined && dailyResetMode !== null && dailyResetMode !== '') {
                const m = String(dailyResetMode).trim().toUpperCase();
                if (['OFF', 'RECONNECT', 'REBOOT'].includes(m)) {
                    cfg.velux.dailyResetMode = m;
                } else {
                    this.hcu.send(
                        'CONFIG_UPDATE_RESPONSE',
                        {
                            status: 'FAILED',
                            message:
                                'Tägliche Wartung muss einer der Werte OFF, RECONNECT oder REBOOT sein.',
                        },
                        env,
                    );
                    return;
                }
            }
            if (dailyResetTime !== undefined && dailyResetTime !== null && dailyResetTime !== '') {
                const value = String(dailyResetTime).trim();
                if (/^\d{1,2}:\d{2}$/.test(value)) {
                    const [h, m] = value.split(':').map(Number);
                    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
                        cfg.velux.dailyResetTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                    }
                } else {
                    this.hcu.send(
                        'CONFIG_UPDATE_RESPONSE',
                        {
                            status: 'FAILED',
                            message:
                                'Reset-Zeit muss im Format HH:MM (24h) angegeben werden, z. B. 03:00.',
                        },
                        env,
                    );
                    return;
                }
            }

            if (!cfg.velux.host || !cfg.velux.password) {
                this.hcu.send(
                    'CONFIG_UPDATE_RESPONSE',
                    {
                        status: 'FAILED',
                        message: 'Host und Passwort müssen gesetzt sein.',
                    },
                    env,
                );
                return;
            }

            // Persist to disk so the plugin survives restarts with its config.
            if (typeof cfg.saveVelux === 'function') cfg.saveVelux();

            // Reconnect Velux with new credentials before confirming APPLIED so
            // the UI reflects reachability of the KLF-200. Errors inside
            // stop()/start() are caught and surfaced via the response instead
            // of aborting the whole update.
            try {
                await this.velux.stop();
            } catch (stopErr) {
                logger.warn('Velux stop during config update failed (ignored):', stopErr && stopErr.message ? stopErr.message : stopErr);
            }

            try {
                await this.velux.start();
                this.hcu.send('CONFIG_UPDATE_RESPONSE', { status: 'APPLIED' }, env);
            } catch (connectErr) {
                logger.error('Velux connect failed after config update:', connectErr);
                this.hcu.send(
                    'CONFIG_UPDATE_RESPONSE',
                    {
                        status: 'FAILED',
                        message:
                            'Konfiguration gespeichert, aber Verbindung zum KLF-200 fehlgeschlagen: ' +
                            (connectErr.message || 'unbekannter Fehler'),
                    },
                    env,
                );
            }

            this.hcu.sendPluginState(this._readiness());
        } catch (err) {
            logger.error('Config update failed:', err);
            this.hcu.send('CONFIG_UPDATE_RESPONSE', { status: 'FAILED', message: err.message }, env);
        }
    }
}

module.exports = { VeluxPlugin };
