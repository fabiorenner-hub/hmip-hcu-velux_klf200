> 🇬🇧 English | [🇩🇪 Deutsch](README.de.md)

# hmip-velux-plugin

📦 **[Download hmip-velux-plugin-1.0.2.tar.gz](https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200/releases/latest/download/hmip-velux-plugin-1.0.2.tar.gz)** — install via HCUweb → *Developer mode → Plugins → Install from file*.

Homematic IP HCU plugin that bridges Velux io-homecontrol devices (shutters,
awnings, windows) into the HMIP app via a **KLF-200 gateway**.

```
HMIP App  <- cloud ->  HCU  <- wss:9001 ->  hmip-velux-plugin  <- TLS:51200 ->  KLF-200  <- io-homecontrol ->  Velux
```

Each node found by the KLF-200 is reported to the HCU as a `WINDOW_COVERING`
device with a `ShutterLevel` feature. Commands from the app
(`setShutterLevel`, `stop`) are translated to `GW_COMMAND_SEND_REQ` against
the KLF-200, position notifications from the KLF-200 are forwarded as
`STATUS_EVENT` to the HCU.

## Install on your HCU

The HCU accepts an **ARM64 container image** as a `.tar.gz`.

1. Grab the latest release from
   [Releases](https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200/releases)
   and download the `hmip-velux-plugin-<version>.tar.gz` asset.
2. In HCUweb open *Settings → Developer mode → Plugins → Install from file*
   and upload the file.
3. Open the plugin tile → *Configuration* and fill in:
   - **KLF-200 hostname or IP** (e.g. `192.168.1.50`)
   - **KLF-200 WLAN password** (the password printed on the back of the
     gateway, **not** the web-config password)
   - **Node IDs** (optional; leave empty to import every connected device)
4. Save. After a few seconds the Velux devices appear in the HMIP app's
   inbox and can be assigned to rooms.

## Build the install file yourself

You need:

- **Docker Desktop** (Windows/macOS) or **Docker Engine + buildx** (Linux)

Then in `hmip-velux-plugin/`:

**Windows (PowerShell)**

```powershell
./build.ps1
```

**macOS / Linux**

```bash
chmod +x build.sh
./build.sh
```

The output is `hmip-velux-plugin-<version>.tar.gz`. The build uses `buildx`
with QEMU emulation, so you can produce ARM64 images on an x86 PC. Cross
build under emulation typically takes 2–5 minutes.

## HCU requirements

1. Home Control Unit (HCU1) with **firmware 1.4.7 or newer**
2. Developer mode enabled in HCUweb
3. Velux **KLF-200 gateway**, firmware **0.2.0.0.71** or newer (older
   versions still speak the legacy LAN protocol and are not supported)

## Develop without rebuilding the image

You can run the plugin directly on your machine:

1. In HCUweb (Developer mode) enable *Connect API WebSocket*
2. Generate an auth token for plugin id `de.homematicip.plugin.velux`
3. Create `.env` or export the variables:

   ```env
   HMIP_HCU_HOST=hcu1-XXXX.local
   HMIP_HCU_AUTH_TOKEN=<your-token>
   VELUX_HOST=192.168.1.50
   VELUX_PASSWORD=<wlan-password>
   LOG_LEVEL=debug
   ```

4. `npm install && npm run dev`

The plugin tile in HCUweb should switch to *READY*.

## Feature mapping

| HMIP feature       | Velux mapping                                        |
| ------------------ | ---------------------------------------------------- |
| `shutterLevel`     | `CurrentPositionPct / 100` (HMIP: `1` = closed)      |
| `shutterDirection` | derived from the latest position change              |
| `setShutterLevel`  | `GW_COMMAND_SEND_REQ` with `rawPercent = level * 100`|
| `stop` (control)   | `GW_COMMAND_SEND_REQ` with stop value `0xD200`       |

Slats (`slatsLevel`) and battery/maintenance status can be added analogously
in `device-mapper`.

## Known limitations

- `velux-klf200-api` returns a broken timestamp in
  `GW_NODE_STATE_POSITION_CHANGED_NTF` — irrelevant for us, we only need
  `NodeID` and `CurrentPositionPct`.
- The KLF-200 closes idle TLS connections after ~15 min. The client polls
  every 5 min with `GW_GET_VERSION_REQ` to keep it alive.
- With `GW_HOUSE_STATUS_MONITOR` enabled the gateway can become unreachable
  after an abrupt disconnect (see Velux issue tracker). A power-cycle of the
  KLF-200 recovers it.

## License

Apache-2.0
