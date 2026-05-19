> [🇬🇧 English](README.md) | 🇩🇪 Deutsch

<p align="center">
  <img src="icon.svg" alt="hmip-velux-plugin Symbolbild" width="128" height="128"/>
</p>

# hmip-velux-plugin

📦 **[hmip-velux-plugin-1.1.4.tar.gz herunterladen](https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200/releases/latest/download/hmip-velux-plugin-1.1.4.tar.gz)** — Installation in HCUweb über *Entwicklermodus → Plugins → Aus Datei installieren*.

GitHub: <https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200>

Homematic IP HCU Plugin, das Velux-Geräte (Rollläden, Markisen, Fenster) über
ein **KLF-200 Gateway** in die Homematic IP App bringt.

```
HMIP App  <- cloud ->  HCU  <- wss:9001 ->  hmip-velux-plugin  <- TLS:51200 ->  KLF-200  <- io-homecontrol ->  Velux
```

Jeder vom KLF-200 gefundene Knoten wird der HCU als `WINDOW_COVERING`-Device
mit `ShutterLevel`-Feature gemeldet. Befehle aus der App
(`setShutterLevel`, `stop`) werden auf `GW_COMMAND_SEND_REQ` an das KLF-200
übersetzt, Positions-Notifications vom KLF-200 landen als `STATUS_EVENT` bei
der HCU.

## Spenden

Wenn dir dieses Plugin hilft, freue ich mich über eine kleine Spende — sie
hält bei mir die Lichter an, während ich weitere HCU-Plugins baue:
[Spenden via PayPal](https://www.paypal.com/donate/?hosted_button_id=JPZRATUUHRT5C).

## Auf der HCU installieren

Die HCU nimmt ein ARM64-Container-Image als `.tar.gz` entgegen.

1. Aktuelle `hmip-velux-plugin-<version>.tar.gz` aus den
   [Releases](https://github.com/fabiorenner-hub/hmip-hcu-velux_klf200/releases) holen.
2. In HCUweb *Einstellungen → Entwicklermodus → Plugins → Aus Datei installieren*
   öffnen und die Datei hochladen.
3. Plugin-Kachel öffnen → *Konfiguration* und ausfüllen:
   - **KLF-200 Hostname oder IP** (z. B. `192.168.1.50`)
   - **KLF-200 WLAN-Passwort** (steht auf der Rückseite des Gateways –
     *nicht* das Web-Konfigurations-Passwort)
   - **Node IDs** (optional; leer = alle verbundenen Velux-Geräte übernehmen)
4. Speichern. Nach wenigen Sekunden tauchen die Velux-Geräte im
   HMIP-App-Posteingang als Rollläden auf.

## Selbst bauen

Du brauchst Docker Desktop (Windows/macOS) oder Docker Engine + buildx (Linux).

```powershell
./build.ps1   # Windows
```

```bash
chmod +x build.sh
./build.sh    # macOS / Linux
```

Heraus kommt `hmip-velux-plugin-<version>.tar.gz`.

## Voraussetzungen auf der HCU

- Home Control Unit (HCU1) mit Firmware **1.4.7 oder neuer**
- Entwicklermodus in HCUweb aktiviert
- Velux **KLF-200 Gateway**, Firmware **0.2.0.0.71** oder neuer

## Feature-Mapping

| HMIP Feature       | Velux Mapping                                        |
| ------------------ | ---------------------------------------------------- |
| `shutterLevel`     | `CurrentPositionPct / 100` (HMIP: `1` = geschlossen) |
| `shutterDirection` | aus der letzten Positionsänderung abgeleitet         |
| `setShutterLevel`  | `GW_COMMAND_SEND_REQ` mit `rawPercent = level * 100` |
| `stop` (Control)   | `GW_COMMAND_SEND_REQ` mit Stopp-Wert `0xD200`        |

## Herausgeber

Herausgegeben von **Fabio Renner**.

### Verwendete Drittanbieter

- [`velux-klf200-api`](https://github.com/PLCHome/velux-klf200-api) von PLCHome — Protokoll-Implementierung für die KLF-200-API (MIT).
- Die KLF-200-Hardware und io-homecontrol sind Produkte der VELUX A/S; dieses Plugin ist mit VELUX nicht verbunden und wird nicht von VELUX unterstützt.
- Gebaut gegen die [Homematic IP Connect API 1.0.1](https://github.com/homematicip/connect-api) von eQ-3.

## Lizenz

Apache-2.0
