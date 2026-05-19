# HCU plugin image. Must be linux/arm64 and carry the metadata label.
FROM --platform=linux/arm64 ghcr.io/homematicip/alpine-node-simple:0.0.1

WORKDIR /app

# Copy manifests first so Docker caches the npm layer.
COPY package.json .npmrc ./
# If a package-lock.json exists, copy it too (optional, wildcard won't fail).
COPY package-lock.jso[n] ./

# --omit=dev keeps the image slim; --no-audit/--no-fund cut noisy npm traffic
# that sometimes fails behind corporate proxies.
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error

# Plugin sources.
COPY src ./src

# /data is created by the HCU for installed plugins and persists across
# container updates. The plugin writes its editable config there.
VOLUME ["/data"]

ENV NODE_ENV=production \
    HMIP_PLUGIN_ID=de.homematicip.plugin.velux \
    LOG_LEVEL=info

ENTRYPOINT ["node", "src/index.js"]

# HCU metadata label (Connect API 4.1). Must be a single-line JSON string.
LABEL de.eq3.hmip.plugin.metadata="{\"pluginId\":\"de.homematicip.plugin.velux\",\"issuer\":\"Fabio Renner\",\"version\":\"1.1.0\",\"hcuMinVersion\":\"1.4.7\",\"scope\":\"LOCAL\",\"friendlyName\":{\"de\":\"Velux (KLF-200)\",\"en\":\"Velux (KLF-200)\"},\"description\":{\"de\":\"Bindet Velux io-homecontrol Geraete via KLF-200 Gateway in Homematic IP ein. GitHub: https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200 - Spenden via PayPal: https://www.paypal.com/donate/?hosted_button_id=JPZRATUUHRT5C\",\"en\":\"Bridges Velux io-homecontrol devices via KLF-200 gateway into Homematic IP. GitHub: https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200 - Donate via PayPal: https://www.paypal.com/donate/?hosted_button_id=JPZRATUUHRT5C\"},\"settings\":[],\"changelog\":\"1.1.0 - Plugin icon, GitHub link and PayPal donation hint added to plugin metadata, README and HCU description.\\n1.0.3 - Fix: Daily-maintenance config field is rendered as a text input (OFF/RECONNECT/REBOOT) instead of an empty dropdown.\\n1.0.2 - Daily maintenance is now selectable: OFF, RECONNECT (soft) or REBOOT (hardware power-cycle of the KLF-200). 90s reboot cooldown so the reconnect loop stays quiet while the gateway boots.\\n1.0.1 - Configurable keep-alive interval and daily KLF-200 reset (default 03:00 local). Cleaner connect-error logs and ECONNREFUSED back-off.\\n1.0.0 - Initial public release.\",\"logsEnabled\":true}"
