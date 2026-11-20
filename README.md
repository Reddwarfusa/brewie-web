# Brewie Web

A self-hosted web interface for the **Brewie** homebrew machine. It replaces the Android
*Brewie Control* app on any browser (phone, tablet, desktop) and runs as a small Docker
container (no external dependencies, ~50 MB image on `node:22-alpine`).

**What it does**

- **Live dashboard**: mash and boil temperatures, heater state, current phase and step,
  step and overall timers, the full step plan, temperature history chart, water volume, pumps and mains.
- **Brew control**: start a recipe (with automatic water inlet and cooling options plus a safety checklist),
  pause, resume, skip to the next step (including the "waiting for you" confirmations), and stop.
- **Recipes**: two-way sync with the machine using the app's own sync protocol. You can browse, search,
  edit, duplicate, import and export `.brewie` recipes. The editor has the app's ingredient, hop, yeast and
  BJCP database and calculates OG/FG/ABV/IBU/colour with the same formulas as the app.
- **Maintenance**: short clean, sanitizing clean, and draining selected tanks.
- **Console**: live protocol log, decoded status fields, and a raw-message sender for experimenting.

## Run it on Unraid

1. Copy this folder to the server (for example `/mnt/user/appdata/brewie-web-src`), then build the image:
   ```sh
   cd /mnt/user/appdata/brewie-web-src
   docker build -t brewie-web:latest .
   ```
2. Either
   - **Template:** copy `unraid/brewie-web.xml` to `/boot/config/plugins/dockerMan/templates-user/`,
     then go to *Docker → Add Container* and pick **brewie-web**. Set *Brewie IP*. Or
   - **Compose (Compose Manager plugin):** edit `BREWIE_HOST` in `docker-compose.yml` and run `docker compose up -d`.
3. Open `http://<unraid-ip>:8080`.

Find the Brewie's IP on the machine under **Settings → WiFi**: tap the active (green) network.
Give the Brewie a fixed DHCP lease on your router so the address doesn't change.

Bridge networking is fine because the container only makes outbound connections to the Brewie
on TCP 8001. The **Find Brewies** button scans the container's own subnet, so it only finds the
machine with `host` or macvlan (`br0`) networking. With bridge networking, enter the IP by hand.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `BREWIE_HOST` | – | Machine IP. You can also set it in the UI; that setting is saved in `/data/settings.json`. |
| `BREWIE_PORT` | `8001` | Machine control port |
| `PORT` | `8080` | Web UI port |
| `DATA_DIR` | `/data` | Recipes (`recipes/*.brewie`), sync state and settings |
| `AUTH_USER` / `AUTH_PASS` | – | Optional HTTP basic auth. **Set these** if the UI is reachable outside your LAN, because the UI can start heaters. |
| `SIMULATOR` | – | `1` runs a built-in fake Brewie for a demo or test. `SIMULATOR_SPEED=30` sets how much faster than real time it runs. |

## Try it without the machine

```sh
npm run demo          # = SIMULATOR=1 node src/server.js  → http://localhost:8080
npm test              # client ↔ simulator integration test
```

## First connection: what to expect

- On connect it pairs (`brewie?` → `hey`), asks for the running program, and syncs recipes the
  same way the phone app does. The machine's recipes appear under **Recipes**.
- Recipes you create or edit are saved locally and then uploaded. If the Brewie is offline,
  they're marked *not on machine yet* and upload on the next connection.
- Deleting a recipe here also deletes it on the machine (the app behaves the same way).
- Use one controller at a time. The phone app and this server can both be connected,
  but sending commands from both at once isn't something I could test.

## Tested against a real Brewie

Verified on a Brewie+ running ReBrewie 4.0.1 (MCU firmware V7):
- pairing and two-way recipe sync (25 recipes pulled and decoded)
- the recipe format, including the Brewie's own OG/IBU/colour/batch/efficiency maths, which reproduces all 25 recipes exactly
- the status-line layout and step plan, checked against the machine's brewing logs
- the machine's side of the protocol, read from its `BrewieApplication`

Good to know:
- **Live readings only appear while a program runs.** An idle Brewie sends nothing, so the gauges stay blank
  until a brew or cleaning starts. That includes programs started on the machine's own touchscreen, which the dashboard picks up automatically.
- Alerts (`E0xx`, `P103` …) are shown with plain-English explanations.
- Not yet exercised on the real machine from this UI: start/pause/next/stop, cleaning and draining. They use
  exactly the messages the machine's code handles. Try a short clean first, standing at the machine.

## Notifications

Settings → **Notifications & alarms**. Sent by the server, so they work with no browser open:

- **ntfy** (recommended): install the ntfy app (iOS/Android), tap *Generate* in Brewie Web to make a private topic
  such as `https://ntfy.sh/brewie-k3j2…`, subscribe to that same topic in the app, then *Send test*.
  Errors arrive at top priority and play an alert sound.
- **Pushover**: app token + user key.
- **Webhook**: any URL that accepts JSON `{source, event, level, title, message, at}`, e.g. a Home Assistant webhook automation.
- Events: errors/emergency stop, stuck drain, "waiting for you", program finished, connection lost during a program.
- With the page open, the browser also shows an alarm banner and beeps until silenced (tap once to allow sound on iPad/iPhone).

The container needs internet access to reach ntfy.sh or Pushover; a self-hosted ntfy on Unraid also works.

## Layout

```
src/qt/qdatastream.js  Qt QDataStream / QVariant codec
src/qt/qbjs.js         Qt binary JSON + qCompress (recipe transport)
src/protocol.js        message types, framing, status-line and brewing decoders
src/client.js          connection, pairing, sync, commands, discovery
src/store.js           local recipe mirror (data/recipes/*.brewie)
src/server.js          HTTP API + server-sent events + static UI
src/simulator.js       fake Brewie for development and demo
public/                single-page UI (vanilla JS) + datas.json (ingredient DB from the app)
PROTOCOL.md            protocol write-up
```

## Raspberry Pi (one-file installer)

`tools/build-pi-installer.sh` builds `dist/brewie-pi-install.sh`, a single script with the app embedded.
Copy it to a Pi 3/4/5 or Zero 2 W running Raspberry Pi OS Lite (64-bit) and run `sudo bash brewie-pi-install.sh`.
It installs Node.js if needed, puts the app in `/opt/brewie-web`, data in `/var/lib/brewie-web`, settings in
`/etc/default/brewie-web`, and runs it as the `brewie-web` systemd service. Re-run a newer installer to update;
`--uninstall` removes it (data kept). `--help` lists the options.
