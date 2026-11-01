# Broadcast Monitor

One page that tells you, at a glance from across the room, whether the broadcast
is OK. A big bar across the top is **green** when everything is fine, **yellow**
for something to look at, and **red** when viewers are affected. Phone alerts go
out through Pushcut, SMS or any webhook.

| Watches | How |
|---|---|
| **vMix** streaming, program/preview, recording, fade to black | vMix HTTP API (`:8088/api`), polled 4× a second |
| **YouTube** — is it receiving the feed, and are you actually **LIVE** (not still in preview)? Stream health, viewers | YouTube Data API v3 |
| **Audio** — clipping, or too quiet for too long (configurable) | vMix's own meters, per bus or per input |
| **Scorebot** (Sportzcast ScoreConnect III) — computer online (ping), feed connected, data flowing, right sport selected | Ping + its MQTT broker, directly. Works **without OSE** |
| **OpenStatsEngine** (optional) — running, active game, receiving the feed | OSE's `/api/monitor` |
| **NDI** sources present on the network, NDI inputs in vMix | mDNS discovery, the way NDI itself finds sources |

No dependencies, no build step, no `npm install`. Node 18+ is all it needs.

---

## Install and run

### The app (easiest)

Download the latest from
[Releases](https://github.com/DueHack12/master-broadcast-monitor/releases/latest).
Nothing else to install, not even Node.

- **Windows:** `BroadcastMonitor-<version>-windows-x64.exe`. Double-click it. The
  first time, Windows SmartScreen says it's from an unknown publisher, because
  the app isn't code-signed: click **More info → Run anyway**.
- **Mac:** unzip `BroadcastMonitor-<version>-macos.zip`, then right-click
  **Broadcast Monitor → Open** the first time.
- **Linux:** `BroadcastMonitor-<version>-linux-x64.tar.gz`.

A console window opens showing the dashboard addresses. On first launch your
browser opens the **Settings** page; fill in the gear you use and press Save.
After that it opens the dashboard. **Closing that window stops the monitor.**
Double-clicking the app again while it's running just opens the dashboard.

Settings are stored in **`Documents\Broadcast Monitor\config.json`**, created on first
start, with the `data` folder beside it. The path is printed in the console and
shown at the bottom of the dashboard. If a `config.json` sits next to the
`.exe`, that one is used instead, so a folder on a USB stick carries its own
settings. Replacing the `.exe` with a newer version keeps your settings.

Options work the same as from source: `BroadcastMonitor.exe --port 9000`,
`--config <file>`, `--data <folder>`, `--no-open`.

### From source

You need [Node.js 18+](https://nodejs.org). There are no npm dependencies.

```bash
git clone https://github.com/DueHack12/master-broadcast-monitor.git
cd master-broadcast-monitor
node server.js
```

On Windows, double-click `start-windows.bat`; on a Mac, `start-mac.command`.
Both check for Node and offer to update a git checkout when they start. From
source, `config.json` and `data/` live in the checkout.

### Either way

```
  Local    : http://localhost:8090
  Network  : http://192.168.1.42:8090
```

Open the **Network** address on any screen on the broadcast network.

### Settings

Press **Settings** (top right of the dashboard) to set the vMix and ScoreConnect
addresses, audio thresholds, NDI sources, YouTube and phone alerts. Changes
apply as soon as you press Save, with no restart. The status bar stays across the
top of the Settings page, so an alarm is never missed while you edit.

- Passwords and keys (the Google client secret, Pushcut and webhook URLs, Twilio
  token, MQTT password) can be entered or replaced, but are never shown back,
  since anyone on the network can open the page.
- Everything is stored in `config.json`, which you can also edit by hand. Saving
  from the Settings page keeps anything you've added there yourself, and a few
  rarer options, such as [alert overrides](#alert-ids), are only in the file. A
  typo in the file is reported on the dashboard, and the last good settings stay in use.

> Port 8090 is clear of vMix (8088, 8099), OpenStatsEngine (8080) and
> ScoreConnect's MQTT (1883). Use `--port 9000` for another.

### Try it without any gear

```bash
npm run demo
```

This starts a simulator (a fake vMix, YouTube, ScoreConnect, OSE and NDI senders)
and wires the monitor to it. Open **http://localhost:8090** for the dashboard
and **http://localhost:18000** for buttons that break things on purpose:
*Streaming, NOT live*, *Audio clipping*, *Scorebot on wrong sport*,
*vMix offline* and more. Demo mode uses `config.demo.json` and its own `data-demo/` folder.

---

## What turns the bar red or yellow

"On air" means vMix is streaming **or** the YouTube broadcast is live.

| Bar | When |
|---|---|
| 🔴 | vMix is not responding |
| 🔴 | vMix is streaming but YouTube isn't receiving it (after `ingestGraceSec`, default 45 s; 15 s if already live) |
| 🔴 | YouTube is receiving the feed but the broadcast is **not LIVE** — still in preview/ready. *Press Go Live.* |
| 🔴 | YouTube is LIVE but vMix is not streaming |
| 🔴 | Program (master) audio is **muted** while on air |
| 🟡 | Waiting for YouTube to pick up a stream that just started |
| 🟡 | Audio clipping, or below the low threshold for too long (on air only) |
| 🟡 | YouTube reports stream health *bad*, or a configuration error |
| 🟡 | Scorebot: computer not answering ping, feed down, no data, wrong sport |
| 🟡 | OSE not receiving the feed while the board is fine; OSE game on the wrong sport |
| 🟡 | An expected NDI source is missing |
| 🟡 | YouTube not connected / API unreachable |
| 🟢 | None of the above. The bar says *LIVE on YouTube for 1h 02m · 412 watching* or *Standby — not streaming* |

Every alert has an id (listed [below](#alert-ids)), and you can change any
alert's level, or switch it off, in `alerts.overrides`.

If the dashboard loses contact with the server, the bar turns grey and says
**Monitor offline**, so a dead monitor never looks like a healthy show.

### Sound

Press **Sound** (top right) to get an alarm in the browser: a repeating two-tone
beep for red, and a single soft beep when a new yellow issue appears. **Silence
alarm** mutes the current red issues until a new one appears. Browsers only allow
sound after a click, so after a page reload, click anywhere to re-arm it.

---

## Setup, piece by piece

### vMix

vMix → Settings → **Web Controller** → enable it (port 8088). Then set
`vmix.host` to the vMix machine's IP, or leave `127.0.0.1` if the monitor runs on
the vMix machine.

vMix can stream to three destinations. `vmix.youtubeChannels` says which ones go
to YouTube (default: any of them).

### YouTube

YouTube needs a free Google Cloud API client. This is a one-time job of about 10 minutes:

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a
   project (e.g. "Broadcast Monitor").
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **Google Auth Platform** (or *APIs & Services → OAuth consent screen*):
   - **Branding:** app name *Broadcast Monitor* (Google rejects names containing
     "YouTube" or "Google"), your email as support email. Leave the **logo
     empty**, because a logo forces Google's full review. Homepage
     `https://duehack12.github.io/master-broadcast-monitor/`, privacy policy
     `https://duehack12.github.io/master-broadcast-monitor/privacy.html`,
     authorized domain `duehack12.github.io`. These pages are in `docs/`, served by
     GitHub Pages (repo Settings → Pages → *Deploy from a branch* → `main`, `/docs`).
   - **Audience:** External, then **Publish app**. While an app is in
     *Testing*, Google expires its sign-ins after 7 days. Publishing a personal
     app doesn't need Google's review; you'll see a "Google hasn't verified this
     app" screen when you sign in. Click **Advanced → Go to Broadcast Monitor**.
   - **Data access:** add the scope `.../auth/youtube.readonly`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   application type **Desktop app**.
5. In **Settings → YouTube**, set the client type to *Desktop app*, paste the
   client ID and secret, and press Save.
6. On the dashboard, press **Sign in & choose channel**. Google opens in a new
   tab: pick the Google account, then **the channel**. Brand Account channels
   are listed there too. You come back to the dashboard, and the YouTube card
   shows which channel is connected. **Switch channel** on the card repeats this
   at any time.
   - Google can only send you back to the computer Broadcast Monitor runs on.
     If you sign in from another device, the Google tab ends on a "can't
     connect" page. That's expected: copy that page's full address and paste
     it into the box on the YouTube card.

**Signing in with a code instead.** Choose **TVs and Limited Input devices** as
the client type (in Google Cloud and in Settings). The card then shows a short
code to enter at google.com/device on any phone. This picks a Google account but
not a channel, so it only suits accounts with a single channel.

The sign-in is saved in `data/youtube-token.json` (keep it private; it's in
`.gitignore`).

**Which broadcast?** The monitor picks the most advanced one: live, then preview,
then ready, preferring the one whose stream key is actually receiving. To force
one, set `youtube.broadcastId` (the video ID from the Studio URL).

**Quota.** Each check costs 2–3 of the 10,000 free daily units. The monitor checks
every 15 s while on air and every 3 minutes otherwise. A 3-hour show plus a full day
of idling uses about 6,000 units.

### Audio

```json
"audio": {
  "onlyWhenOnAir": true,
  "clip": { "thresholdDb": -1, "windowSec": 10, "minHits": 3 },
  "low":  { "thresholdDb": -50, "durationSec": 10 },
  "sources": [
    { "label": "Program (Master)", "bus": "master", "mutedLevel": "crit" },
    { "label": "Commentary", "input": "Mic 1", "low": { "durationSec": 20 } }
  ]
}
```

- **Too low**: the peak stays under `low.thresholdDb` continuously for
  `low.durationSec`. Any louder moment resets the timer.
- **Clipping**: the peak reaches `clip.thresholdDb` at least `minHits` times
  within `windowSec`. One stray peak is ignored; audio that keeps hitting the
  ceiling is not.
- Sources are a vMix bus (`master`, `A`–`G`) or an input (by title, partial
  title, or number). Each source can override `clip` / `low`.
- The quiet timer restarts when you go on air, so a silent pre-show doesn't trip
  it in the first seconds of the stream.

Meters are vMix's `meterF1`/`meterF2` peak values converted to dBFS. Compare the
dashboard against vMix's own meters the first time and adjust thresholds to taste.

### Scorebot (Sportzcast ScoreConnect III)

This works on its own, so OSE doesn't need to be running.

```json
"scorebot": {
  "host": "127.0.0.1",
  "ping": { "enabled": true, "intervalSec": 5, "failuresBeforeDown": 2 },
  "mqtt": { "port": 1883, "topic": "bot/0/json" },
  "silentAfterSec": 5
}
```

- `host` is the computer running ScoreConnect: its IP, or `127.0.0.1` /
  `localhost` if it's this machine. It is pinged every few seconds. If this
  machine has no `ping` command, it checks the MQTT port instead and labels the
  row *Host (TCP)*.
- The monitor subscribes to ScoreConnect's MQTT broker, the same feed OSE uses.
  Brokers allow several subscribers, so the two don't interfere.
- **No data** for `silentAfterSec` seconds while connected means the board or
  ScoreLink has stopped sending. That is the failure that hides, because the
  connection stays up. Set it to `0` for a board that only sends on changes.
- **Today's sport** is picked on the Scorebot card:
  - *Auto* follows the active game in OSE when OSE is running.
  - Pick a sport to pin it.
  - *Scorebot not in use* silences all scorebot alerts for events without one.
- **The board's sport** comes from the feed's `VendorSportId`. Only **23 =
  soccer** has been confirmed on a real ScoreConnect so far. For any other sport,
  the card shows the ID it sees and a button: *Sport ID 7 is Football*. Click it
  once per sport while that sport is on the board, and it's remembered (in
  `data/settings.json`). Without a known ID, the card guesses from the field names
  (football sends Down/ToGo, baseball sends Balls/Strikes…) but never raises an
  alarm on a guess.

### OpenStatsEngine (optional)

```json
"ose": { "url": "http://127.0.0.1:8080", "required": false }
```

Reads the same `/api/monitor` endpoint as OSE's own Feed Monitor page. When OSE
isn't running, the card just says so, because not every event uses it. Set
`required: true` to make that an alert.

The monitor is careful about blame. If the scorebot itself is down, only the
Scorebot card alerts. The OSE alert means *the board is sending, but OSE isn't
getting it*: its feed is disconnected or pointed at the wrong topic.

### NDI

```json
"ndi": { "expected": ["Camera 1", "Camera 2", "vMix - Output 1"] }
```

Sources are found by mDNS, the way NDI Studio Monitor finds them. Matching is
case-insensitive and partial: `"Camera 1"` matches `CAM-PC (Camera 1)`. The card
also lists every other source it sees, and the NDI inputs loaded in vMix.

If the monitor machine has several network cards, set `ndi.interfaces` to the
broadcast-network IP (e.g. `["10.10.0.20"]`). Setups that use an **NDI Discovery
Server** instead of mDNS won't show sources here.

---

## Phone alerts

```json
"notify": {
  "onlyWhenOnAir": true,
  "persistSec": 5,
  "repeatAfterMin": 5,
  "recovery": true,
  "pushcut": { "enabled": true, "url": "https://api.pushcut.io/XXXX/notifications/Broadcast", "minLevel": "warn", "timeSensitiveLevel": "crit" },
  "twilio":  { "enabled": false, "accountSid": "", "authToken": "", "from": "+1555…", "to": ["+1555…"], "minLevel": "crit" },
  "webhook": { "enabled": false, "url": "", "minLevel": "warn" }
}
```

- An issue must last `persistSec` before anyone is alerted, which stops flapping.
- Each issue is sent once. If it's still going, a reminder goes out every
  `repeatAfterMin` minutes (0 = never). When everything clears, you get an "All clear".
- With `onlyWhenOnAir`, nothing is sent while you're not streaming or live, so
  the monitor stays quiet overnight.
- **Test alert** (top right of the dashboard) sends a test through every enabled channel.

**Pushcut (easiest for iPhone).** In the Pushcut app: Notifications → **+** →
name it (e.g. *Broadcast*) → open it → **Webhook** → copy the URL into
**Settings → Phone alerts → Pushcut**. Red alerts are sent as *Time Sensitive* so
they break through Focus modes. Fill in **Settings → General → Dashboard
address**, which suggests one for you, and tapping a notification opens the dashboard.

**SMS (Twilio).** Fill in the account SID, auth token, your Twilio number (or a
Messaging Service SID starting `MG`) and the numbers to text. US carriers require
Twilio numbers to be registered before they deliver texts: A2P 10DLC for regular
numbers, verification for toll-free numbers. That takes days, so start with Pushcut.

**Webhook.** POSTs JSON with `text`, `title`, `message`, `level` and `issues`.
The `text` field means it works as-is with Slack and Mattermost incoming
webhooks, and with Discord if you add `/slack` to the end of the webhook URL.
Home Assistant, n8n and similar receive the full JSON.

**Apple Shortcuts / polling.** `GET /api/status` returns a compact
`{ level, ok, headline, detail, onAir, issues }`. A Shortcut or another
monitoring system can poll it. `GET /api/state` is the full dashboard snapshot,
and `GET /events` is the live Server-Sent Events stream the page uses.

---

## Alert ids

Use these in `alerts.overrides` to change a level (`crit`, `warn`, `info`, `off`).
Wildcards work, and the most specific pattern wins.

```json
"alerts": { "overrides": { "scorebot.*": "crit", "audio.commentary.low": "off" } }
```

| Id | Default |
|---|---|
| `vmix.offline` | crit |
| `vmix.ftb` (faded to black while on air) | warn |
| `youtube.waiting` | warn |
| `youtube.no_ingest` | crit |
| `youtube.not_live` | crit |
| `youtube.live_no_vmix` | crit |
| `youtube.health`, `youtube.config.*` | warn |
| `youtube.auth`, `youtube.api` | warn |
| `youtube.setup` | info (warn while streaming) |
| `audio.<source>.clip`, `audio.<source>.low`, `audio.<source>.missing` | warn |
| `audio.<source>.muted` | the source's `mutedLevel` (default warn) |
| `scorebot.host_down`, `scorebot.mqtt_down`, `scorebot.silent`, `scorebot.wrong_sport` | warn |
| `ose.offline` (only with `required: true`), `ose.feed_down`, `ose.feed_stalled`, `ose.wrong_sport` | warn |
| `ndi.missing.<name>` | warn |
| `system.config` | warn |

`<source>` is the audio source's label in lower case, with anything that isn't a
letter or digit turned into `_`: *Program (Master)* → `program_master`.

---

## Adding something new to monitor

Every check is one file in `src/monitors/`. The dashboard draws cards from what
each monitor describes, so a new monitor needs no front-end changes.

1. Copy the shape of an existing one, e.g. `src/monitors/ose.js`: a class
   extending `Monitor` with `start()`, `stop()`, `issues(ctx)` and `view(ctx)`.
   `base.js` documents the card format (rows, lists, notices, buttons, a select).
2. Add it to the list in `src/monitors/index.js`.
3. Give it a config block: `"mything": { "enabled": true, ... }` (defaults go in
   `src/config.js`).
4. To make its options editable on the Settings page, add a section to
   `public/settings-schema.js`. The page and the server's validation both come from it.

`ctx.monitors` gives access to the others (e.g. `ctx.monitors.vmix.state.data`),
so a new check can build on data already being collected.

---

## Files

```
server.js                start here
config.example.json      copied to config.json on first run
src/app.js               evaluates every rule → one list of issues → snapshot
src/rules.js             vMix → YouTube → LIVE stream-chain rules
src/notify.js            Pushcut / Twilio / webhook
src/monitors/*.js        one per thing watched
src/lib/*.js             vMix XML, MQTT, mDNS, ping, audio detection, sports
public/                  the dashboard and Settings page (plain HTML/CSS/JS)
public/settings-schema.js  Settings fields + validation, shared by page and server
tools/simulator.js       fake equipment for testing and demos
build/package.mjs        builds the .exe / .app / Linux binary
data/                    YouTube sign-in, dashboard settings, events.jsonl log
```

## Releasing a new version

Bump `"version"` in `package.json` and push to `main`. The GitHub Actions
workflow runs the tests, builds the Windows `.exe`, the macOS `.app` and a Linux
binary, smoke-tests the packaged app, and publishes a release with all three
attached. Release notes come from `docs/releases/v<version>.md` if it exists.

To build locally: `npm run build` (this machine's platform) or
`node build/package.mjs win linux`. The Windows `.exe` can be built on any OS;
the Mac app needs a Mac.

## Tests

```bash
npm test
```

Covers vMix XML parsing, the audio clip/low rules, every stream-chain case, the
notifier's anti-spam logic, mDNS packet parsing, ping output on all three OSes,
sport detection, and an end-to-end run of the real app against the simulator
from standby → preview → live → failures → YouTube sign-in.

## Notes and limits

- No login: it is meant for a closed broadcast network. Anyone who can open the
  page can change settings and *Today's sport*, connect or disconnect YouTube, and
  send a test alert. Saved passwords and keys are never shown back, but they can be replaced.
- vMix's API doesn't report RTMP bitrate or dropped frames, so stream health
  comes from YouTube's side (`healthStatus` and configuration issues).
- YouTube data is up to `pollOnAirSec` (15 s) old, which is why the
  "not receiving" alarm has a grace period after the stream starts.
- Only Sportzcast `VendorSportId` 23 (soccer) is known so far. Teach it the
  others from the Scorebot card as you meet them.
