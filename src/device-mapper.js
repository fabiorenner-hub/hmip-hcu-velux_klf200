'use strict';

/**
 * Maps Velux KLF-200 nodes to Homematic IP Connect API structures.
 *
 * Sources:
 *   - Connect API 1.0.1 §6.5.1 Device schema:
 *       { deviceId, deviceType, features, firmwareVersion?, friendlyName?, modelType? }
 *   - §6.6.5 DeviceType: WINDOW_COVERING requires ShutterLevel feature.
 *   - §6.7.29 ShutterLevel:
 *       { type: 'shutterLevel', shutterLevel: 0.0..1.0 }
 *       Special values: 1.005 = "last value", 1.01 = "ignore".
 *   - §6.3.10 StatusEvent body: { deviceId, features } — no deviceType.
 *   - §6.3.11 StatusResponse body: { success, devices: Set<Device> }.
 *
 * deviceId format:
 *   The HCU stores deviceId as an opaque string but the iOS app validates
 *   it as a UUID when syncing — non-UUID identifiers cause the app to hang
 *   on "Verbindung wird hergestellt" and crash the room-assignment wizard.
 *   We derive a stable UUID-v4 shaped value from SHA-256 of
 *   `${pluginId}:velux:${nodeId}` so it is deterministic across restarts
 *   and also usable for the reverse lookup during CONTROL_REQUEST.
 */

const crypto = require('crypto');
const { pluginId } = require('./config');

const uuidToNodeId = new Map();

function computeUuid(nodeId) {
    const h = crypto
        .createHash('sha256')
        .update(`${pluginId}:velux:${nodeId}`)
        .digest('hex');
    return (
        h.slice(0, 8) +
        '-' +
        h.slice(8, 12) +
        '-' +
        '4' + h.slice(13, 16) +
        '-' +
        'a' + h.slice(17, 20) +
        '-' +
        h.slice(20, 32)
    );
}

function deviceIdFor(nodeId) {
    const uuid = computeUuid(nodeId);
    uuidToNodeId.set(uuid, Number(nodeId));
    return uuid;
}

function parseDeviceId(deviceId) {
    if (!deviceId) return null;
    const n = uuidToNodeId.get(deviceId);
    return Number.isFinite(n) ? n : null;
}

/**
 * Build the ShutterLevel feature object.
 * Uses 1.01 (ignore value) when the level is truly unknown so the HMIP app
 * does not render a misleading 0% / 100%. A concrete 0..1 value is emitted
 * when we have a real reading.
 */
function buildFeatures(node) {
    const level = node.level;
    const hasLevel =
        typeof level === 'number' && !Number.isNaN(level);
    const shutterLevel = hasLevel
        ? Math.max(0, Math.min(1, level))
        : 1.01; // "ignore" sentinel per §6.7.29

    const features = [
        { type: 'shutterLevel', shutterLevel },
    ];
    if (node.lastDirection) {
        features.push({
            type: 'shutterDirection',
            shutterDirection: node.lastDirection, // DARKER | LIGHTER
        });
    }
    return features;
}

function toDevice(node) {
    return {
        deviceId: deviceIdFor(node.id),
        deviceType: 'WINDOW_COVERING',
        firmwareVersion: '1.1.3',
        modelType: 'Velux io-homecontrol',
        friendlyName: node.name || `Velux ${node.id}`,
        features: buildFeatures(node),
    };
}

/**
 * Shape used for STATUS_RESPONSE — validated as a full Device (needs
 * deviceType etc.).
 */
function toStatus(node) {
    return {
        deviceId: deviceIdFor(node.id),
        deviceType: 'WINDOW_COVERING',
        features: buildFeatures(node),
    };
}

/**
 * Shape used for STATUS_EVENT (§6.3.10) — deviceId + features only.
 */
function toStatusEvent(node) {
    return {
        deviceId: deviceIdFor(node.id),
        features: buildFeatures(node),
    };
}

module.exports = {
    deviceIdFor,
    parseDeviceId,
    toDevice,
    toStatus,
    toStatusEvent,
};
