> 🇬🇧 English | [🇩🇪 Deutsch](README.de.md)

<p align="center">
  <img src="icon.svg" alt="hmip-velux-plugin icon" width="128" height="128"/>
</p>

# hmip-velux-plugin

📦 **[Download hmip-velux-plugin-1.1.2.tar.gz](https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200/releases/latest/download/hmip-velux-plugin-1.1.2.tar.gz)** — install via HCUweb → *Developer mode → Plugins → Install from file*.

GitHub: <https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200>

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

## Support

If this plugin is useful to you, please consider a small donation — it helps
me keep the lights on while building more HCU plugins:
[Donate via PayPal](https://www.paypal.com/donate/?hosted_button_id=JPZRATUUHRT5C).

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

You need Docker Desktop (Windows/macOS) or Docker Engine + buildx (Linux).

```powershell
./build.ps1   # Windows
```

```bash
chmod +x build.sh
./build.sh    # macOS / Linux
```

The output is `hmip-velux-plugin-<version>.tar.gz`. The build uses `buildx`
with QEMU emulation, so you can produce ARM64 images on an x86 PC.

## HCU requirements

- Home Control Unit (HCU1) with firmware **1.4.7 or newer**
- Developer mode enabled in HCUweb
- Velux **KLF-200 gateway**, firmware **0.2.0.0.71** or newer

## Feature mapping

| HMIP feature       | Velux mapping                                        |
| ------------------ | ---------------------------------------------------- |
| `shutterLevel`     | `CurrentPositionPct / 100` (HMIP: `1` = closed)      |
| `shutterDirection` | derived from the latest position change              |
| `setShutterLevel`  | `GW_COMMAND_SEND_REQ` with `rawPercent = level * 100`|
| `stop` (control)   | `GW_COMMAND_SEND_REQ` with stop value `0xD200`       |

## Author

Issued by **Fabio Renner**.

### Third-party components

- [`velux-klf200-api`](https://github.com/PLCHome/velux-klf200-api) by PLCHome — protocol implementation for the KLF-200 API (MIT).
- The KLF-200 hardware and io-homecontrol are products of VELUX A/S; this plugin is not affiliated with or endorsed by VELUX.
- Built against the [Homematic IP Connect API 1.0.1](https://github.com/homematicip/connect-api) by eQ-3.

## License

Apache-2.0
