'use strict';

/**
 * Thin wrapper around the `velux-klf200-api` npm package (v0.1.7) keeping a
 * persistent TLS connection to a KLF-200 gateway.
 *
 * References (validated against source of velux-klf200-api@0.1.7):
 *   - KLF-200 API (technical spec): https://github.com/PLCHome/velux-klf200-api
 *   - Connect API contract (upstream): the HCU consumes our events via the
 *     HMIP Connect API, so the mapping 0..1 shutterLevel is HMIP-convention.
 *
 * Position encoding (tools.js getPosition):
 *   rawValue                          meaning
 *   0x0000 .. 0xC800                  RELATIVE 0..100 %   (value = raw/512)
 *   0xC900 .. 0xD0D0                  PERCENT_PM (delta)  -- not a position
 *   0xD100                            TARGET meta-code
 *   0xD200                            CURRENT meta-code (also "stop in place")
 *   0xD300                            DEFAULT meta-code
 *   0xD400                            IGNORE meta-code
 *   0xF7FF                            RELATIVE / no feedback
 * Only RELATIVE with a non-null value is a real position.
 *
 * Actuator OperatingState (klf.js OperatingStateTag):
 *   0 Nonexecuting       idle; last validated position is present
 *   1 Error              no reliable value
 *   2 Not used           unused slot placeholder (no real node here)
 *   3 Waiting for power  waiting; old position
 *   4 Executing          motor running; currentPosition is the start value
 *   5 Done               authoritative; currentPosition is the result
 *   255 State unknown
 * Only 5 is authoritative at runtime; 0 is acceptable at initial discovery
 * so we have a starting value for a node at rest.
 *
 * Session feedback (much more reliable than HOUSE_STATUS NTFs):
 *   GW_COMMAND_SEND_REQ  -> GW_COMMAND_SEND_CFM (+ sessionID)
 *   GW_COMMAND_RUN_STATUS_NTF: per-node runStatus + parameterValue
 *       runStatus 0 EXECUTION_COMPLETED, 1 FAILED, 2 ACTIVE
 *   GW_SESSION_FINISHED_NTF: session closed, no further NTFs
 *
 * The KLF drops idle TLS sessions after ~10–15 min, so we send a cheap
 * GW_GET_VERSION_REQ every 5 min and force a reconnect on repeated failure.
 */

const { EventEmitter } = require('events');
const velux = require('velux-klf200-api');
const logger = require('./logger');
const { velux: veluxCfg } = require('./config');

const API = velux.API;
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
const POSITION_POLL_INTERVAL_MS = 30 * 1000;
const POST_COMMAND_POLL_MS = 25 * 1000;
const PENDING_WINDOW_MS = 30 * 1000;

const RAW_MAX = 0xc800; // 51200 -> 100%
const RAW_UNKNOWN = 0xf7ff;
const RAW_STOP = 0xd200;
const MAX_KEEPALIVE_FAILURES = 2;

// The KLF-200 occasionally enters a state where its API listener rejects
// every new TCP connection with ECONNREFUSED, even though the device is
// otherwise responsive. Hammering it every reconnectDelayMs (10 s by
// default) only prolongs that state and floods the logs. After this many
// consecutive ECONNREFUSED-style failures we back off to a longer pause
// to give the gateway time to clean up its listener state.
const REFUSED_BACKOFF_THRESHOLD = 6;
const REFUSED_BACKOFF_MS = 60 * 1000;
// Error codes that indicate the KLF is reachable but actively rejects /
// drops the connection — exactly the failure mode the backoff targets.
const REFUSED_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ETIMEDOUT',
]);

// Actuator state codes from the KLF-200 API spec.
const STATE_NONEXECUTING = 0;
const STATE_ERROR = 1;
const STATE_NOT_USED = 2;
const STATE_WAITING = 3;
const STATE_EXECUTING = 4;
const STATE_DONE = 5;
const STATE_UNKNOWN = 255;

// RunStatus codes from GW_COMMAND_RUN_STATUS_NTF.
const RUN_COMPLETED = 0;
const RUN_FAILED = 1;
const RUN_ACTIVE = 2;

function normaliseShutterLevel(pos) {
    if (pos === undefined || pos === null) return undefined;

    // Defensive: some call sites may still pass a raw integer.
    if (typeof pos === 'number') {
        if (Number.isNaN(pos)) return undefined;
        if (pos === RAW_UNKNOWN || pos < 0 || pos > RAW_MAX) return undefined;
        return pos / RAW_MAX;
    }

    if (typeof pos !== 'object') return undefined;
    if (pos.valueType !== 'RELATIVE') return undefined;
    if (pos.value === null || pos.value === undefined) return undefined;
    if (typeof pos.value !== 'number' || Number.isNaN(pos.value)) return undefined;

    // Library value is 0..100 percent; convert to 0..1 for HMIP.
    return Math.max(0, Math.min(1, pos.value / 100));
}

function shutterLevelToRaw(level) {
    const clamped = Math.max(0, Math.min(1, level));
    return Math.round(clamped * RAW_MAX);
}

/**
 * Render a connection error in a single, human-readable line.
 *
 * The upstream `velux-klf200-api` reports transport failures by
 * concatenating the literal string `"tcp error"` with the underlying
 * `Error` object via implicit `toString()`, producing messages like
 * `"tcp errorError: connect ECONNREFUSED 192.168.10.105:51200"`. That's
 * noisy and easy to misread. Normalise to either `<CODE> <addr>:<port>`
 * when the original socket error is exposed, or to a cleaned-up message
 * with the duplicate prefix removed.
 */
function formatConnectError(err) {
    if (!err) return 'unknown error';

    // Sometimes the library passes through the original socket error.
    if (err.code && (err.address || err.host) && err.port) {
        const host = err.address || err.host;
        return `${err.code} ${host}:${err.port}`;
    }

    const raw = err.message || String(err);
    // Strip the duplicated "tcp errorError:" / "tcp error Error:" prefix.
    const cleaned = raw
        .replace(/^tcp error\s*Error:\s*/i, '')
        .replace(/^tcp error\s*/i, '');
    // If the cleaned line still mentions ECONN*, condense to "<CODE> <host>:<port>".
    const m = cleaned.match(/(ECONN\w+|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)\b.*?(\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-f:]+\]?|[\w.-]+):(\d+)/i);
    if (m) return `${m[1].toUpperCase()} ${m[2]}:${m[3]}`;
    return cleaned;
}

/**
 * Decide whether a connect error indicates the KLF actively refused or
 * dropped the socket (vs. a different problem like login/auth). Used to
 * decide when to switch from the fast 10 s retry to a longer back-off.
 */
function isRefusalError(err) {
    if (!err) return false;
    if (err.code && REFUSED_ERROR_CODES.has(err.code)) return true;
    const text = (err.message || String(err)).toUpperCase();
    for (const code of REFUSED_ERROR_CODES) {
        if (text.includes(code)) return true;
    }
    return false;
}

/**
 * Compute the milliseconds from now until the next occurrence of the given
 * local-time HH:MM. If the slot is already past today, return the time
 * until that slot tomorrow. Returns NaN if the input is malformed.
 *
 * Caller should treat any non-finite or non-positive return as "don't
 * schedule" rather than scheduling an immediate fire.
 */
function msUntilNextLocalTime(hhmm, now = new Date()) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(hhmm || ''));
    if (!m) return NaN;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return NaN;
    if (h < 0 || h > 23 || min < 0 || min > 59) return NaN;
    const next = new Date(now);
    next.setHours(h, min, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
}

class VeluxClient extends EventEmitter {
    constructor() {
        super();
        this.connected = false;
        this.nodes = new Map(); // nodeId -> { id, name, level }
        this._keepaliveTimer = null;
        this._positionPollTimer = null;
        this._reconnectTimer = null;
        this._readyFallbackTimer = null;
        this._dailyResetTimer = null;
        this._stopping = false;
        this._attached = false;
        this._readyEmitted = false;
        this._keepaliveFailures = 0;
        // Counts consecutive connect failures whose error code suggests the
        // KLF actively refused or dropped the socket (ECONNREFUSED &
        // friends). After REFUSED_BACKOFF_THRESHOLD we pause longer to let
        // the gateway clean up its API listener state.
        this._consecutiveRefusals = 0;
        // Track sessions we started via setShutterLevel/stopMovement so we
        // can match GW_COMMAND_RUN_STATUS_NTF back to a specific node.
        this._sessions = new Map(); // sessionID -> { nodeId, target, deadline }
    }

    async start() {
        this._stopping = false;
        await this._connect();
    }

    async stop() {
        this._stopping = true;
        this._clearTimers();
        this._readyEmitted = false;
        try {
            await velux.end();
        } catch (_) {
            /* ignore */
        }
        this.connected = false;
    }

    async _connect() {
        if (!veluxCfg.host || !veluxCfg.password) {
            logger.warn('KLF-200 host or password not configured yet, waiting for config.');
            return;
        }

        logger.info(`Connecting to KLF-200 at ${veluxCfg.host}`);
        try {
            await velux.connect(veluxCfg.host, {});
            await velux.login(veluxCfg.password);
            this.connected = true;
            this._consecutiveRefusals = 0;
            logger.info('KLF-200 login succeeded.');

            this._attachListeners();

            // Subscribe to status monitor so position updates arrive unsolicited.
            await velux.sendCommand({ api: API.GW_HOUSE_STATUS_MONITOR_ENABLE_REQ });
            await this.refreshNodes();
            this._schedulePoll();

            // Older firmwares occasionally drop the FINISHED notification.
            if (this._readyFallbackTimer) clearTimeout(this._readyFallbackTimer);
            this._readyFallbackTimer = setTimeout(() => {
                if (!this._readyEmitted) {
                    logger.warn(
                        'KLF-200 discovery FINISHED not received within 10s — emitting ready anyway.',
                    );
                    this._onDiscoveryFinished();
                }
            }, 10000);
        } catch (err) {
            logger.error(`KLF-200 connect failed: ${formatConnectError(err)}`);
            this.connected = false;
            if (isRefusalError(err)) {
                this._consecutiveRefusals += 1;
            } else {
                this._consecutiveRefusals = 0;
            }
            this._scheduleReconnect();
        }
    }

    _attachListeners() {
        if (this._attached) return;
        // Asynchronous broadcasts while idle (House Status Monitor).
        velux.on('GW_NODE_STATE_POSITION_CHANGED_NTF', (d) => this._onPositionChanged(d));
        velux.on('GW_NODE_INFORMATION_CHANGED_NTF', (d) => this._onNodeInfoChanged(d));
        // Responses to GW_GET_ALL_NODES_INFORMATION_REQ / GW_GET_NODE_INFORMATION_REQ.
        velux.on('GW_GET_NODE_INFORMATION_NTF', (d) => this._onNodeInfoFull(d));
        velux.on('GW_GET_ALL_NODES_INFORMATION_NTF', (d) => this._onNodeInfoFull(d));
        velux.on('GW_GET_ALL_NODES_INFORMATION_FINISHED_NTF', () =>
            this._onDiscoveryFinished(),
        );
        // Session feedback (per-command).
        velux.on('GW_COMMAND_SEND_CFM', (d) => this._onCommandSendCfm(d));
        velux.on('GW_COMMAND_RUN_STATUS_NTF', (d) => this._onCommandRunStatus(d));
        velux.on('GW_SESSION_FINISHED_NTF', (d) => this._onSessionFinished(d));
        // Live status-request responses (GW_STATUS_REQUEST_REQ with statusType 3).
        velux.on('GW_STATUS_REQUEST_NTF', (d) => this._onStatusRequestNtf(d));
        // Transport / lifecycle.
        velux.on('error', (err) => this._onTransportError(err));
        velux.on('timeout', () => this._onClose());
        this._attached = true;
    }

    _onDiscoveryFinished() {
        if (this._readyEmitted) return;
        this._readyEmitted = true;
        if (this._readyFallbackTimer) clearTimeout(this._readyFallbackTimer);
        this._readyFallbackTimer = null;
        logger.info(`KLF-200 discovery finished with ${this.nodes.size} node(s)`);
        this.emit('ready');
    }

    _schedulePoll() {
        this._clearTimers();
        this._keepaliveFailures = 0;

        const keepaliveMin = Number.isFinite(veluxCfg.keepaliveMinutes)
            ? veluxCfg.keepaliveMinutes
            : KEEPALIVE_INTERVAL_MS / 60000;
        if (keepaliveMin > 0) {
            const intervalMs = Math.max(1, keepaliveMin) * 60 * 1000;
            logger.debug(`KLF-200 keep-alive every ${keepaliveMin} min`);
            this._keepaliveTimer = setInterval(() => {
                velux
                    .sendCommand({ api: API.GW_GET_VERSION_REQ })
                    .then(() => {
                        this._keepaliveFailures = 0;
                    })
                    .catch((e) => {
                        this._keepaliveFailures += 1;
                        logger.warn(
                            `KLF-200 keep-alive failed (${this._keepaliveFailures}/${MAX_KEEPALIVE_FAILURES + 1}):`,
                            e && e.message ? e.message : e,
                        );
                        if (this._keepaliveFailures > MAX_KEEPALIVE_FAILURES) {
                            logger.warn('KLF-200 considered dead, forcing reconnect.');
                            this._forceReconnect();
                        }
                    });
            }, intervalMs);
        } else {
            logger.info('KLF-200 keep-alive disabled (keepaliveMinutes=0).');
        }

        // Second timer: periodically ask each actuator for its *live*
        // position via io-homecontrol. GW_GET_ALL_NODES_INFORMATION_REQ only
        // reads the KLF's internal cache, which does not get updated when
        // someone moves the shutter with an original Velux remote (the
        // motor reports the new position back to the remote, not to the
        // KLF). GW_STATUS_REQUEST_REQ statusType=3 forces the KLF to query
        // each actuator over the air, which catches remote/rain/timer
        // originated movements.
        this._positionPollTimer = setInterval(() => {
            const ids = Array.from(this.nodes.keys());
            if (ids.length === 0) return;
            // KLF accepts up to 20 node IDs per request.
            const batches = [];
            for (let i = 0; i < ids.length; i += 20) {
                batches.push(ids.slice(i, i + 20));
            }
            batches.forEach((batch) =>
                this.requestLiveStatus(batch).catch((e) =>
                    logger.warn(
                        'Live poll failed:',
                        e && e.message ? e.message : e,
                    ),
                ),
            );
        }, POSITION_POLL_INTERVAL_MS);

        this._scheduleDailyReset();
    }

    /**
     * Schedule a daily forced reconnect at the configured local time
     * (default 03:00). The KLF-200's TLS state machine occasionally wedges
     * after long uptimes; tearing the session down once a day clears that
     * out before users notice.
     *
     * Implementation note: we use one-shot `setTimeout` rather than
     * `setInterval`. After firing, the next slot is computed fresh, which
     * stays accurate across DST transitions and avoids drift after the
     * machine sleeps/resumes.
     */
    _scheduleDailyReset() {
        if (this._dailyResetTimer) {
            clearTimeout(this._dailyResetTimer);
            this._dailyResetTimer = null;
        }
        if (!veluxCfg.dailyResetEnabled) return;

        const ms = msUntilNextLocalTime(veluxCfg.dailyResetTime);
        if (!Number.isFinite(ms) || ms <= 0) {
            logger.warn(
                `Invalid dailyResetTime "${veluxCfg.dailyResetTime}", expected HH:MM (24h). Daily reset disabled.`,
            );
            return;
        }
        const hours = (ms / 3600000).toFixed(2);
        logger.info(`KLF-200 daily reset scheduled for ${veluxCfg.dailyResetTime} (in ${hours} h).`);
        this._dailyResetTimer = setTimeout(() => {
            this._dailyResetTimer = null;
            logger.info('KLF-200 daily reset: forcing reconnect.');
            this._forceReconnect().catch((e) =>
                logger.warn('Daily reset _forceReconnect threw:', e && e.message ? e.message : e),
            );
            // _forceReconnect → _scheduleReconnect → _connect → on success
            // _schedulePoll → _scheduleDailyReset, so the next slot gets
            // re-armed automatically. As a safety net (in case the
            // reconnect keeps failing all day), arm the next slot here too.
            if (!this._stopping) {
                setTimeout(() => this._scheduleDailyReset(), 60 * 1000);
            }
        }, ms);
    }

    async _forceReconnect() {
        if (this._stopping) return;
        this._clearTimers();
        this.connected = false;
        this._readyEmitted = false;
        this._sessions.clear();
        try {
            await velux.end();
        } catch (_) {
            /* ignore */
        }
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this._stopping || this._reconnectTimer) return;
        const longBackoff = this._consecutiveRefusals >= REFUSED_BACKOFF_THRESHOLD;
        const delay = longBackoff ? REFUSED_BACKOFF_MS : veluxCfg.reconnectDelayMs;
        if (longBackoff) {
            logger.warn(
                `KLF-200 refused ${this._consecutiveRefusals} connects in a row — backing off ${Math.round(delay / 1000)}s before retrying.`,
            );
        }
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connect();
        }, delay);
    }

    _clearTimers() {
        if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);
        if (this._positionPollTimer) clearInterval(this._positionPollTimer);
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        if (this._readyFallbackTimer) clearTimeout(this._readyFallbackTimer);
        if (this._dailyResetTimer) clearTimeout(this._dailyResetTimer);
        this._keepaliveTimer = null;
        this._positionPollTimer = null;
        this._reconnectTimer = null;
        this._readyFallbackTimer = null;
        this._dailyResetTimer = null;
    }

    _onClose() {
        if (!this.connected) return;
        logger.warn('KLF-200 connection closed, scheduling reconnect.');
        this.connected = false;
        this._readyEmitted = false;
        this._sessions.clear();
        this._scheduleReconnect();
    }

    _onTransportError(err) {
        logger.warn(`KLF-200 transport error: ${formatConnectError(err)}`);
    }

    async refreshNodes() {
        logger.debug('Requesting all node information from KLF-200');
        await velux.sendCommand({ api: API.GW_GET_ALL_NODES_INFORMATION_REQ });
    }

    /**
     * Ask the KLF to query the live position from one or more actuators via
     * io-homecontrol, rather than returning its internal cache. This is the
     * only way to detect external changes (remote, rain sensor, timer) that
     * moved the motor without the KLF being involved.
     *
     * statusType 3 = "Main info": actuator replies with current + target
     * positions and last command originator. Each actuator replies with a
     * separate GW_STATUS_REQUEST_NTF.
     */
    async requestLiveStatus(nodeIds) {
        if (!this.connected) return;
        const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
        if (ids.length === 0) return;
        try {
            await velux.sendCommand({
                api: API.GW_STATUS_REQUEST_REQ,
                indexArrayCount: ids.length,
                indexArray: ids,
                statusType: 3, // Main info
            });
        } catch (err) {
            logger.warn(
                'GW_STATUS_REQUEST_REQ failed:',
                err && err.message ? err.message : err,
            );
        }
    }

    _readNodeId(data) {
        return data.nodeID !== undefined ? data.nodeID : data.NodeID;
    }

    _readPosition(data) {
        return data.currentPosition !== undefined ? data.currentPosition : data.CurrentPosition;
    }

    _readName(data) {
        return data.name || data.Name;
    }

    /**
     * Handles both GW_GET_NODE_INFORMATION_NTF (single) and
     * GW_GET_ALL_NODES_INFORMATION_NTF (burst). A `state === 2 (Not used)`
     * NTF represents an empty slot in the KLF node table — we skip it so no
     * ghost device is created.
     */
    _onNodeInfoFull(data) {
        if (!data) return;
        const id = this._readNodeId(data);
        if (id === undefined) return;
        const filter = veluxCfg.nodeFilter;
        if (filter.length && !filter.includes(id)) return;
        if (data.state === STATE_NOT_USED) return; // empty slot, skip

        const name = (this._readName(data) || `Velux ${id}`).toString().trim();
        const pos = this._readPosition(data);
        const existing = this.nodes.get(id);

        // Trust the reported position only in these states:
        //  - at initial discovery: Nonexecuting or Done (either is a settled value)
        //  - during runtime polling: only Done
        // Executing/Waiting/Error/Unknown positions are stale or meaningless.
        const trustedStates = existing ? [STATE_DONE] : [STATE_NONEXECUTING, STATE_DONE];
        const level = trustedStates.includes(data.state)
            ? normaliseShutterLevel(pos)
            : undefined;

        if (!existing) {
            const entry = { id, name, level };
            this.nodes.set(id, entry);
            this.emit('nodeDiscovered', entry);
            return;
        }

        existing.name = name;
        if (level === undefined) return;

        existing._pendingTarget = undefined;
        existing._pendingDeadline = 0;
        if (existing.level === level) return;
        existing.level = level;
        logger.info(`Velux node ${id} external update level=${level} (poll, state=Done)`);
        this.emit('positionChanged', existing);
    }

    _onNodeInfoChanged(data) {
        if (!data) return;
        const id = this._readNodeId(data);
        const entry = this.nodes.get(id);
        if (!entry) return;
        const name = this._readName(data);
        if (name) entry.name = name.toString().trim();
        this.emit('nodeChanged', entry);
    }

    /**
     * Handler for GW_NODE_STATE_POSITION_CHANGED_NTF broadcasts from the
     * House Status Monitor. Only state 5 (Done) with a RELATIVE position is
     * authoritative at runtime.
     */
    _onPositionChanged(data) {
        if (!data) return;
        const id = this._readNodeId(data);
        const entry = this.nodes.get(id);
        if (!entry) return;
        const pos = this._readPosition(data);
        const state = data.state;
        const stateTag = data.stateTag;

        if (state !== STATE_DONE) {
            logger.info(
                `Velux node ${id} NTF ignored (state=${stateTag || state}, rawValue=${pos && pos.rawValue})`,
            );
            return;
        }

        const level = normaliseShutterLevel(pos);
        if (level === undefined) {
            logger.info(
                `Velux node ${id} NTF state=Done but not RELATIVE (valueType=${pos && pos.valueType}, rawValue=${pos && pos.rawValue})`,
            );
            return;
        }

        entry._pendingTarget = undefined;
        entry._pendingDeadline = 0;
        if (entry.level === level) return;
        entry.level = level;
        logger.info(`Velux node ${id} position NTF state=Done level=${level}`);
        this.emit('positionChanged', entry);
    }

    /**
     * GW_COMMAND_SEND_CFM comes back right after we send a movement command.
     * It carries the sessionID that subsequent GW_COMMAND_RUN_STATUS_NTF and
     * GW_SESSION_FINISHED_NTF messages will reference. The lib also returns
     * the CFM as the resolved value of sendCommand(), but registering an
     * explicit handler lets us survive library-version differences.
     */
    _onCommandSendCfm(data) {
        if (!data || data.sessionID === undefined) return;
        logger.debug(`Velux command CFM session=${data.sessionID} status=${data.statusText || data.status}`);
    }

    /**
     * GW_COMMAND_RUN_STATUS_NTF is per-node. It contains:
     *   runStatus: 0 COMPLETED | 1 FAILED | 2 ACTIVE
     *   parameterValue: the actuator's reported position at that moment
     *   index: the node ID (from the request's indexArray)
     * A runStatus of 0 with a RELATIVE parameterValue is the most reliable
     * signal that a movement finished, and what the final position is.
     */
    _onCommandRunStatus(data) {
        if (!data) return;
        const nodeId = data.index;
        const entry = this.nodes.get(nodeId);
        if (!entry) return;

        if (data.runStatus === RUN_ACTIVE) {
            logger.debug(`Velux node ${nodeId} still moving (session=${data.sessionID})`);
            return;
        }
        if (data.runStatus === RUN_FAILED) {
            logger.warn(
                `Velux node ${nodeId} command failed: ${data.statusReplyText || data.statusReply} (session=${data.sessionID})`,
            );
            return;
        }
        // RUN_COMPLETED
        const level = normaliseShutterLevel(data.parameterValue);
        if (level === undefined) {
            logger.info(
                `Velux node ${nodeId} completed but parameterValue not RELATIVE (valueType=${data.parameterValue && data.parameterValue.valueType})`,
            );
            return;
        }
        entry._pendingTarget = undefined;
        entry._pendingDeadline = 0;
        if (entry.level === level) {
            logger.info(`Velux node ${nodeId} run COMPLETED at level=${level} (unchanged)`);
            return;
        }
        entry.level = level;
        logger.info(`Velux node ${nodeId} run COMPLETED level=${level} (session=${data.sessionID})`);
        this.emit('positionChanged', entry);
    }

    _onSessionFinished(data) {
        if (!data || data.sessionID === undefined) return;
        const session = this._sessions.get(data.sessionID);
        if (!session) return;
        logger.debug(`Velux session ${data.sessionID} finished (node=${session.nodeId})`);
        this._sessions.delete(data.sessionID);
    }

    /**
     * Handler for GW_STATUS_REQUEST_NTF. When we asked with statusType 3
     * (Main info), each actuator replies with:
     *   index: nodeID
     *   runStatus: 0 COMPLETED | 1 FAILED | 2 ACTIVE
     *   currentPosition: real position (RELATIVE when valid)
     *   targetPosition, remainingTime, lastCommandOriginator
     * This is the authoritative "live from the motor" reading we use to
     * detect external changes (remote, rain sensor, timer).
     */
    _onStatusRequestNtf(data) {
        if (!data) return;
        // statusType 3 is the only variant we request; bail on others to stay safe.
        if (data.statusType !== undefined && data.statusType !== 3) return;

        const nodeId = data.index;
        const entry = this.nodes.get(nodeId);
        if (!entry) return;

        if (data.runStatus === RUN_ACTIVE) {
            logger.debug(`Velux node ${nodeId} status-request: motor still active`);
            return;
        }
        if (data.runStatus === RUN_FAILED) {
            logger.warn(
                `Velux node ${nodeId} status-request failed: ${data.statusReplyText || data.statusReply}`,
            );
            return;
        }

        const level = normaliseShutterLevel(data.currentPosition);
        if (level === undefined) {
            logger.debug(
                `Velux node ${nodeId} status-request: position not RELATIVE (valueType=${data.currentPosition && data.currentPosition.valueType})`,
            );
            return;
        }

        // Skip if this update matches our own pending command — the
        // CommandRunStatus handler is authoritative in that window.
        if (entry._pendingTarget !== undefined && entry._pendingDeadline > Date.now()) {
            const delta = Math.abs(level - entry._pendingTarget);
            if (delta < 0.02) {
                entry._pendingTarget = undefined;
                entry._pendingDeadline = 0;
            } else {
                // A poll arriving mid-movement shouldn't overwrite the optimistic target.
                return;
            }
        }

        if (entry.level === level) return;
        entry.level = level;
        logger.info(
            `Velux node ${nodeId} external update level=${level} (live-poll, originator=${data.lastCommandOriginatorTyp || data.lastCommandOriginator})`,
        );
        this.emit('positionChanged', entry);
    }

    /**
     * Drive a Velux node to an absolute position. `level` is 0..1 using the
     * HMIP ShutterLevel convention (1 = fully closed).
     *
     * PriorityLevel 3 = User Level 2 (regular user-initiated command; lower
     * priority than environment/wind/rain sensors). CommandOriginator 1 = USER.
     */
    async setShutterLevel(nodeId, level) {
        if (!this.connected) throw new Error('KLF-200 not connected');
        const clamped = Math.max(0, Math.min(1, level));
        const raw = shutterLevelToRaw(clamped);
        logger.info(`Velux node ${nodeId} -> raw ${raw} (${Math.round(clamped * 100)}%)`);

        let cfm;
        try {
            cfm = await velux.sendCommand({
                api: API.GW_COMMAND_SEND_REQ,
                commandOriginator: 1,
                priorityLevel: 3,
                parameterActive: 0,
                functionalParameterMP: { rawValue: raw },
                indexArrayCount: 1,
                indexArray: [nodeId],
                priorityLevelLock: false,
                lockTime: 0,
            });
        } catch (err) {
            if (err && String(err.message || '').includes('timeout')) {
                this._forceReconnect();
            }
            throw err;
        }

        // Track the session so _onCommandRunStatus can match the NTF back.
        if (cfm && typeof cfm.sessionID === 'number') {
            this._sessions.set(cfm.sessionID, {
                nodeId,
                target: clamped,
                deadline: Date.now() + PENDING_WINDOW_MS,
            });
        }

        // Optimistic update so the HMIP UI reflects the target immediately.
        const entry = this.nodes.get(nodeId);
        if (entry) {
            entry.level = clamped;
            entry._pendingTarget = clamped;
            entry._pendingDeadline = Date.now() + PENDING_WINDOW_MS;
            this.emit('positionChanged', entry);
        }

        // Safety net: if the KLF never sends a Done NTF for this node (some
        // io-homecontrol peers are moody), query the actuator directly after
        // the typical travel time. GW_STATUS_REQUEST_REQ polls over the air
        // and gets the motor's real current position.
        setTimeout(() => {
            this.requestLiveStatus([nodeId]).catch(() => {
                /* already logged elsewhere */
            });
        }, POST_COMMAND_POLL_MS);
    }

    /**
     * Stop movement on a node. The KLF accepts the "CURRENT" raw value
     * (0xD200) as a stop-in-place instruction.
     *
     * Named stopMovement (not stop) because the class's own stop() tears
     * down the KLF connection; two methods with the same name would shadow
     * each other silently.
     */
    async stopMovement(nodeId) {
        if (!this.connected) throw new Error('KLF-200 not connected');
        logger.info(`Velux node ${nodeId} -> STOP`);
        await velux.sendCommand({
            api: API.GW_COMMAND_SEND_REQ,
            commandOriginator: 1,
            priorityLevel: 3,
            parameterActive: 0,
            functionalParameterMP: { rawValue: RAW_STOP },
            indexArrayCount: 1,
            indexArray: [nodeId],
            priorityLevelLock: false,
            lockTime: 0,
        });
    }

    listNodes() {
        return Array.from(this.nodes.values());
    }

    getNode(id) {
        return this.nodes.get(Number(id));
    }
}

module.exports = { VeluxClient };

// Exposed for unit tests; not part of the public API.
module.exports._test = { normaliseShutterLevel, shutterLevelToRaw, formatConnectError, isRefusalError, msUntilNextLocalTime };
