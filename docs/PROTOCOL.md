# Luma / TVT NVMS-9000 NVR — Reverse-Engineered Protocol

This document captures everything currently understood about the NVR's client-side
protocol, derived from HAR + Charles captures of the web UI interacting with a
unit at `192.168.1.100`.

The long-term goal is a native client (initial target: iOS via React Native / Expo)
that can log in, enumerate cameras, play live video, and play recorded footage.

---

## 1. Device identification

| Field | Value |
|---|---|
| Vendor platform | Shenzhen TVT Digital — **NVMS-9000** |
| Branding | Luma (OEM; same firmware ships as LTS, Laview, Q-See, etc.) |
| Firmware observed | `1.4.6.76250(N7S.U1.16L82G)` |
| Transport | HTTP (XML-RPC style) + WebSocket (JSON control, binary media) |
| Default port | `80` (HTTP and WS on same port) |
| Capacity observed | 16 channels (11 populated) |

The browser-side player is almost certainly derived from
[sonysuqin/WasmVideoPlayer](https://github.com/sonysuqin/WasmVideoPlayer): the
NVR ships a custom-patched `libffmpeg.wasm` that demuxes a proprietary
**`SHFL`** container inside a WebSocket-delivered stream.

---

## 2. HTTP API (XML)

All HTTP API calls are `POST` with:

- `Content-Type: application/x-www-form-urlencoded; charset=UTF-8` (despite the
  body being XML)
- After login, `Cookie: sessionId=<uuid-no-braces>`
- `Referer: http://<nvr>/`

Request body shape:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<request version="1.0" systemType="NVMS-9000" clientType="WEB">
  <token>null</token>        <!-- or the token from /reqLogin -->
  <content> … </content>     <!-- command-specific -->
</request>
```

Response body shape:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="<endpoint>">
  <status>success</status>   <!-- or "failed" -->
  <content> … </content>
  <types> … </types>         <!-- enums referenced inside <content> -->
</response>
```

### 2.1 Pre-login endpoints (no session required)

| Endpoint | Purpose |
|---|---|
| `/getSupportLangList` | Supported languages (`0x0409` = en-US) |
| `/getLangContent` | Translated UI strings for selected language |
| `/queryActivationStatus` | Device activation flag |
| `/queryShowPrivacyView` | Whether to show the privacy banner |
| `/reqLogin` | **Step 1 of login** — returns nonce/token/sessionId |

### 2.2 Authenticated endpoints used

Enumeration (pre-playback):

| Endpoint | Purpose |
|---|---|
| `/queryBasicCfg` | Video system (NTSC/PAL), language list, password policy, etc. |
| `/querySystemCaps` | Device capabilities (chlMaxCount, playbackMaxWin, bandwidth) |
| `/queryPasswordSecurity` | Password policy |
| `/queryOvrcConnStatus` | OvrC cloud status |
| `/queryDiskStatus` | Disk health |
| `/queryAuthGroup` | Auth group details |
| `/queryNodeList` | Channel/sensor/alarmOut node tree |
| `/queryOnlineChlList` | Which channels are currently online |
| `/queryNodeEncodeInfo` | Per-channel encoding parameters |
| `/queryCameraLensCtrlParam` | Lens/PTZ info |
| `/queryManualRecord` | Manual-record state |
| `/queryRecStatus` | Active recording status |
| `/queryTimeCfg` | NVR timezone, NTP server, DST rules |
| `/queryPosList` | POS integrations |

Recording lookup:

| Endpoint | Purpose |
|---|---|
| `/queryChlsExistRec` | Which channels have any recordings (id + name) |
| `/queryChlGroupList` | Channel groups |
| `/queryDatesExistRec` | Which dates within a range contain recordings (with overall startTime/endTime/duration) |
| `/queryChlRecLog` | Per-channel list of recording segments: `recType`, `startTime`, `endTime`, `size` |

`recType` enum observed:
`MOTION`, `SCHEDULE`, `SENSOR`, `MANUAL`, `INTELLIGENT`, `POS`, `NORMALALL`,
`FACEDETECTION`, `FACEMATCH`, `VEHICLE`, `TRIPWIRE`, `INVADE`, `AOIENTRY`,
`AOILEAVE`, `ITEMCARE`, `CROWDDENSITY`, `EXCEPTION`.

All channel IDs are brace-wrapped GUIDs, e.g.
`{00000001-0000-0000-0000-000000000000}` ... `{0000000B-0000-0000-0000-000000000000}`.

Times in `queryChlRecLog` are strings in the NVR's local timezone with a
`timeZone="UTC"` attribute on the enclosing `<recList>` (in our capture it
*said* UTC but values looked local-EST — verify before trusting).

---

## 3. Authentication flow

Full sequence derived from `login.js` (located at `/js/app//login.js` on the
device, minified; de-obfuscated here) and `CommonFunctions.js`.

### 3.1 Step 1 — `POST /reqLogin`

Request (no credentials yet):

```xml
<request version="1.0" systemType="NVMS-9000" clientType="WEB">
  <token>null</token>
</request>
```

Response:

```xml
<content>
  <sessionId>{7A5D5717-A202-457A-B70C-D523B18D4F93}</sessionId>
  <nonce>{F67500CA-19EC-4B63-8B3E-4E53A0C15914}</nonce>
  <token>{7094BDCD-5DF5-471A-9DE5-A4BBB21AA723}</token>
  <softwareVersion><![CDATA[1.4.6.76250(N7S.U1.16L82G)]]></softwareVersion>
</content>
```

Client behavior:
- **Strip braces** from `sessionId` → use the bare UUID as `Cookie: sessionId=`.
- **Keep braces on `nonce`** — the hash below uses the full `{...}` form verbatim.
- Store `token` for step 2.

### 3.2 Step 2 — compute password hash

From `CommonFunctions.encryptSha512`:

```js
function encryptSha512(pwd) {
    var password = SparkMD5.hash(pwd);          // MD5-hex of plaintext, UPPERCASE
    var nonce = $.webSession("nonce");           // "{UUID}" with braces
    return sha512(password + "#" + nonce);       // SHA-512 hex (lowercase)
}
```

**Important:** `SparkMD5.hash()` returns **uppercase** hex (it calls `.toUpperCase()`
internally). The SHA-512 input therefore uses uppercase MD5, not lowercase.

Formula:

```
passwordField = SHA512_hex( UPPER(MD5_hex(plainPassword)) + "#" + nonceWithBraces )
```

Output is 128 hex characters (= 64 bytes = SHA-512 output).

### 3.3 Step 3 — `POST /doLogin`

Request (with cookie `sessionId=<from step 1, braces stripped>`):

```xml
<request version="1.0" systemType="NVMS-9000" clientType="WEB">
  <token>{7094BDCD-5DF5-471A-9DE5-A4BBB21AA723}</token>
  <content>
    <userName><![CDATA[admin]]></userName>
    <password><![CDATA[24b1d0d4...7d4f]]></password>   <!-- 128 hex chars -->
  </content>
</request>
```

Response (truncated):

```xml
<content>
  <userId>{AE7D03B6-55BE-4BCC-B54D-DBC7EF517174}</userId>
  <authEffective>true</authEffective>
  <modifyPassword>true</modifyPassword>
  <webLogin>true</webLogin>
  <userType>normal</userType>
  <authGroupId>{F395BCC6-C545-466A-A2D8-0C5805FDF8B7}</authGroupId>
  <sessionKey>HQuyn+fY/cd7052/ZToZyh4aBcAOUmiM5hKCg9mJKV8=</sessionKey>
  <securityVer>1</securityVer>
  <passwordExpired>false</passwordExpired>
  <systemAuth>
    <localChlMgr>true</localChlMgr>
    <remoteChlMgr>true</remoteChlMgr>
    <diskMgr>true</diskMgr>
    <talk>true</talk>
    <rec>true</rec>
    <remoteLogin>true</remoteLogin>
    …
  </systemAuth>
  <sessionId>{CB1C41F5-D2FE-4E5C-9AB4-74112A2B0FC3}</sessionId>   <!-- NOT USED by web client -->
</content>
```

### 3.4 Step 4 — decrypt `sessionKey`

From `CommonFunctions.decrypt`:

- AES-**256**-ECB, **ZeroPadding**, 16-byte blocks.
- Key bytes = **UTF-8 of the 32-char MD5-hex string** of the plaintext password
  (i.e., the ASCII bytes of the hex digits — 32 bytes → AES-256).
- Ciphertext = base64-decode of `<sessionKey>`.

Python equivalent (verified shape matches capture):

```python
import hashlib, base64
from Crypto.Cipher import AES

def password_field(plain, nonce_with_braces):
    md5 = hashlib.md5(plain.encode()).hexdigest().upper()  # SparkMD5 returns uppercase
    return hashlib.sha512(f"{md5}#{nonce_with_braces}".encode()).hexdigest()

def decrypt_session_key(b64_ct, plain_password):
    md5_hex = hashlib.md5(plain_password.encode()).hexdigest()  # 32 ASCII chars
    key = md5_hex.encode()                                       # 32 bytes = AES-256
    ct = base64.b64decode(b64_ct)
    pt = AES.new(key, AES.MODE_ECB).decrypt(ct)
    return pt.rstrip(b"\x00")                                    # ZeroPadding
```

### 3.5 Session bookkeeping

- **The cookie `sessionId` used for all subsequent HTTP + WS calls is the one
  from `/reqLogin`**, not the new one returned by `/doLogin`. The web client
  ignores the second `<sessionId>` in the `/doLogin` response.
- `auInfo_N9K` in sessionStorage is a client-only obfuscated copy of
  `username:` XOR'd with a random `unmask` value. Not sent to server — ignore.
- The decrypted `sessionKey` is used to AES-wrap payloads on certain
  configuration endpoints (password change, etc.). **Not required for
  enumeration, live view, or playback** — only useful once we implement config
  features.
- Session expiry / keepalive behavior is not yet characterized — see §6.

---

## 4. WebSocket transport

### 4.1 Connection

```
ws://<nvr>/requestWebsocketConnection?sessionID=<cookie-sessionId>
```

- Reuses the HTTP cookie's `sessionId` as a **query parameter** (case: lower
  `sessionID` in the URL but lower `sessionId` as the cookie name).
- **One WebSocket per concurrent logical stream.** The server **enforces** this —
  sending a second `preview/open` on the same WS returns error code `536871004`.
  Each camera, each playback, each subscription requires its own WS connection.
- **Per-session cap is 6 concurrent WebSockets**, shared across preview and
  playback. The 7th upgrade attempt on a session returns HTTP 400 during the
  WebSocket upgrade handshake (observed close code 1006, reason "Received bad
  response code from server: 400"). Verified empirically — see
  `src/nvr/__tests__/integration/01-session-cap.ts` and
  `04-live-playback-mix.ts`. See §4.7 for the multi-camera pattern.
- **New logins do NOT invalidate old session sessionIds for new WS upgrades.**
  After login B completes, a fresh WS upgrade on session A still succeeds
  (tested at 0/100/500/2000ms post-B-login). Existing WSes on session A also
  continue delivering frames. The rolling-invalidation behavior only appears
  to affect HTTP tokens, not the WS sessionId as a connection identifier.
  Verified in `02-login-invalidation.ts`.
- **No post-login settle window.** A WS upgrade attempted immediately after
  login completes (`t=0ms`) succeeds reliably. Verified in
  `05-post-login-settle.ts`.
- Roles observed across captures:
  1. `/device/state_info/subscribe` — channel + alarm state (one shared WS)
  2. `/device/real_image/subscribe` — AI metadata (plate / boundary) per
     channel (one shared WS carrying metadata for all requested channels)
  3. `/device/preview/*` — live view (one WS per camera)
  4. `/device/playback/*` — recorded playback (one WS per task)
- Server immediately sends a `/device/create_connection#response` JSON frame
  after Upgrade to confirm the session was accepted.

### 4.2 Frame format

#### Text frames (control)

UTF-8 JSON, one object per frame, this shape in both directions:

```json
{
  "url": "/device/<area>/<verb>",
  "basic": {
    "ver": "1.0",
    "time": 1776134888429,       // unix ms (client) / unix s (server)
    "id": 1,                     // correlation ID
    "nonce": 872327437           // random uint32
  },
  "data": { … }                  // command-specific
}
```

Server response mirrors the URL with a `#response` suffix and augments `basic`:

```json
{
  "basic": { "ver":"1.0", "id":1, "time":..., "code":0, "msg":"success" },
  "url":   "/device/playback/open#response",
  "data":  { "task_id":"{…}" }
}
```

`code:0` = success. Other codes not yet observed — see §6.

#### Binary frames (media)

```
offset  size  meaning
 0      4     0x00000000                    (frame-type marker, always zero so far)
 4      4     hdrlen (little-endian uint32)
 8      hdrlen   UTF-8 JSON header (same "basic"/"url"/"data" shape as text)
 8+hdrlen  …   media payload (SHFL-wrapped — see §5)
```

The JSON header always has `url: "/device/preview/data"` or
`"/device/playback/data"` and `data.task_id` tagging which stream the payload
belongs to. For playback, `data.playback_stream_data` carries
`"<byteOffset>,<length>"` locating this chunk within the server-side stream.

### 4.3 Live view commands

| Direction | URL | `data` |
|---|---|---|
| C→S | `/device/preview/open` | `{task_id, channel_id, stream_index, audio}` |
| S→C | `/device/preview/open#response` | `{task_id}` |
| C→S | `/device/preview/audio/close` | `{task_id}` |
| S→C | `/device/preview/data` (BIN) | `{task_id, code}` + SHFL payload |
| C→S | `/device/preview/close` | `{task_id}` |

- `task_id` is a **client-generated brace-wrapped GUID**, reused across all
  frames for that logical stream. Server echoes it back (uppercased) in
  responses.
- `stream_index`: `1` = main, `2` = sub. Web UI uses sub for grid, main for
  single-pane.
- `audio`: boolean. If false, the client also sends `audio/close` immediately
  after open.

### 4.4 Playback commands

| Direction | URL | `data` |
|---|---|---|
| C→S | `/device/playback/open` | `{task_id, channel_id, start_time, end_time, stream_index, type_mask[]}` |
| S→C | `/device/playback/open#response` | `{task_id}` |
| C→S | `/device/playback/audio/close` | `{task_id}` |
| C→S | `/device/playback/all_frame` | `{task_id, frame_time: "YYYY-MM-DD HH:MM:SS:mmm"}` |
| S→C | `/device/playback/all_frame#response` | `{task_id}` |
| C→S | `/device/playback/refresh_play_index` | `{task_id, play_frame_index: <int>}` |
| S→C | `/device/playback/data` (BIN) | `{task_id, playback_stream_data: "<off>,<len>"}` + SHFL payload |
| C→S | `/device/playback/close` | `{task_id}` |
| S→C | `/device/playback/close#response` | `{task_id}` |

Notable fields:

- `start_time` / `end_time`: **Unix seconds (UTC)**. Range covers the window
  the user is interested in; the server streams the covered footage.
- `type_mask`: array of strings filtering which record types to include. Full
  set observed:
  `["manual","sensor","avd","smart_pass_line","tripwire","perimeter",
   "smart_aoi_entry","smart_aoi_leave","motion","pos","schedule",
   "intelligent", …]`. (Many of these are AI events; `schedule` + `motion`
  are the ones most users will care about.)
- `refresh_play_index`: sent every ~8 decoded frames, monotonically increasing
  (8, 16, 24, …). Acts as a flow-control ACK — **required** to keep the server
  pushing frames; if you stall, the server throttles/pauses.
- `all_frame`: seek to an absolute timestamp with millisecond precision within
  the open task. Use instead of reopening when the new time is within the
  task's `start_time`/`end_time` window.
- `key_frame`: switch the task into keyframe-only delivery mode. Used by the
  web client and app at playback speeds > 4x where per-frame delivery would
  exceed available bandwidth. Payload: `{task_id, frame_time}` (same
  timestamp format as `all_frame`).

#### Keyframe-mode flow control

Verified empirically in probes 09 and 10 (`src/nvr/__tests__/integration/`):

- **The server releases exactly 3 keyframes per `refresh_play_index` ACK**
  in keyframe-only mode, across a 250–1000 ms ACK-gap sweep (stable).
- Each ACK must carry a `play_frame_index` the server recognises — use
  the `seq` field from the most recent SHFL frame (see §5.2).
- Effective playback rate is linear in the ACK gap:
  `effective_rate = (framesPerAck × GOP_seconds) / ACK_gap_seconds = 3 × GOP / gap`
- Unthrottled ACKs (gap ≈ 0) produce effective rates of 60–130x —
  massively exceeding any reasonable display rate. The client must pace
  ACKs to the target speed in keyframe mode.
- All-frame mode uses different dynamics: server delivers every frame at
  roughly real-time (~1.3x wall) regardless of ACK rate; client pacing is
  via PTS-lead-based pause (see `playback-connection.ts`).

#### Playback `stream_index` values

Different from live (§4.3); the playback path supports an additional index
for the original-bitrate recording:

| Value | Stream | Codec | Notes |
|:-:|---|---|---|
| `0` | Original recording | 4K H.265 (this NVR's cameras) | Highest quality. Used for HQ single-cam at 1× only — 2×+ falls back to `1` because the NVR can't sustain 4K keyframe delivery over WiFi at faster speeds. |
| `1` | Transcoded main | 704×480 H.264 | Server-side transcode of the recording for the wasm player. Used by single-cam at non-HQ or any speed > 1×. |
| `2` | Sub stream | 704×480 H.264 | Camera-recorded sub stream. Used for grid tiles. |

Probe 30 observed that on this NVR/firmware, `stream_index=1` and
`stream_index=2` emit **byte-identical bitstreams** for the same channel +
time range — the "transcoded main" appears to be the same recording as
the sub stream rather than a distinct re-encode. Other firmware versions
may diverge.

#### WebSocket lifecycle around `playback/close`

When the only active task on a WS is closed via `playback/close`, the
server cleanly closes the WS itself (`code=1000`). A `playback/open` for
a fresh `task_id` sent immediately after the close (mirroring the app's
restart pattern) lands too late on a session with no other tasks in
flight — the WS is already gone. The app's restart-on-existing-WS works
in production because there are usually other live or playback tasks
keeping the WS alive; an isolated reopen on the same WS needs a fresh
`requestWebsocketConnection` upgrade.

### 4.5 Other subscription commands

| URL | `data` | Notes |
|---|---|---|
| `/device/state_info/subscribe` | `{channel_state_info: bool, alarm_state_info: bool}` | Server then sends `/device/state_info/subscribe/data` BIN frames |
| `/device/state_info/unsubscribe` | `{}` | |
| `/device/real_image/subscribe` | `[{channel_id, vehicle_plate:{info,detect_pic,scene_pic}, boundary:{info,detect_pic,scene_pic}}, …]` | AI metadata push; not needed for basic playback |
| `/device/real_image/unsubscribe` | `{}` | |

### 4.6 Keepalive

- Standard WebSocket PING → PONG is used; both sides send them. The client
  responds to server PING with PONG.
- No application-layer heartbeat JSON observed for the WS. For playback,
  `refresh_play_index` serves as the implicit heartbeat.

### 4.7 Multi-camera view

Verified from `captures/multicam.chlsj` (user entered a 2×3 live-view grid of
five cameras).

**The server does not multiplex streams.** Each camera in a grid gets its own
WebSocket connection. In the capture, seven concurrent WSes were open:

| WS role | URL | Count | Notes |
|---|---|---|---|
| State subscription | `/device/state_info/subscribe` | 1 | Shared; channel + alarm events for all cameras |
| AI metadata subscription | `/device/real_image/subscribe` | 1 | Shared; `data` is an **array** of per-channel subscriptions, so one WS carries metadata for every channel the user cares about |
| Live preview | `/device/preview/open` | 5 | One per visible camera; each with a unique `task_id` and `channel_id` |

All connections reuse the same `sessionID` query-parameter, and the server's
`systemCaps` advertises `previewMaxWin: 16` / `playbackMaxWin: 16` — the NVR
is explicitly designed for up to 16 concurrent stream tasks.

#### Main-stream vs sub-stream toggle

- The grid view uses **`stream_index: 2`** (sub stream) on all five preview
  WSes — low-res, low-bitrate (typically 320×240 @ 256–512 kbps per camera).
  Suitable for thumbnails-in-a-grid.
- Single-camera focus uses **`stream_index: 1`** (main stream) — full
  resolution (704×480 in our unit's config).
- When the user taps a grid cell to go full-screen, the web client closes the
  grid's sub-stream WS for that camera and opens a new main-stream WS. Other
  grid cells are untouched.
- `queryNodeEncodeInfo` returns each channel's per-stream encode parameters
  so the client knows what resolution/bitrate to expect.

#### Implications for the iOS app

1. **One `URLSessionWebSocketTask` per visible stream.** Manage a pool keyed
   by `(channelId, mode)` with `mode ∈ {live-main, live-sub, playback}`.
2. **Grid always uses sub stream.** 16 × ~512 kbps ≈ 8 Mbps — fine on LAN.
3. **Swap streams on focus.** When the user zooms into a single cell, close
   that cell's sub-stream WS and open a main-stream one. This is why our
   native view's API should treat "attach to stream" as a mutable property
   rather than a construction-time argument.
4. **Subscriptions are shared, not per-camera.** When opening multiple
   previews, do **not** open a new `state_info` / `real_image` WS per
   camera — just update the single shared subscription's `data` array and
   send `/device/real_image/subscribe` again (idempotent in practice; the
   server overwrites the prior subscription set).
5. **Connection count matters for reconnection logic.** If the LAN blips and
   all N WSes disconnect simultaneously, reconnect with a small
   stagger/jitter to avoid hammering the NVR. Target reconnect rate: roughly
   1 WS per 50–100 ms.
6. **The "dashboard" pattern maps cleanly.** Rendering `N` `<NvrVideoView />`
   components in a `FlatList`/`FlashList` grid, each bound to its own
   dedicated WS, mirrors what the web client does — no JS-side fan-out or
   demultiplexing is needed.

#### Client-side pool sketch (for the iOS implementation)

```
NVRClient
 ├── http          // URLSession + cookie jar
 ├── streams: [StreamKey: StreamConnection]
 │      StreamKey = (channelId, mode, optional taskId)
 │      StreamConnection = {
 │          ws: URLSessionWebSocketTask,
 │          taskId: UUID,           // client-generated
 │          codec: H264|H265?,      // learned on first keyframe
 │          sink: (NALBytes) -> Void
 │      }
 └── subscriptions // one each: state_info, real_image (shared across views)
```

On `NVRClient.attach(channelId, mode, sink)`:

1. If a matching `StreamConnection` already exists and is healthy, redirect
   its `sink` and return. (Useful when a grid re-orders.)
2. Otherwise open a new WS, send the appropriate `/device/*/open`, and wire
   binary frames → SHFL demux → `sink`.

On `NVRClient.detach(channelId, mode)`:

- Send `/device/*/close`, close the WS, remove from the pool.

On `NVRClient.focus(channelId)`:

- `detach(channelId, .liveSub)` + `attach(channelId, .liveMain, …)`.

The `<NvrVideoView />` component accepts `(channelId, mode)` as props and
talks to the shared `NVRClient` singleton — it doesn't own the WS itself.
This keeps the native view purely a renderer.

---

## 5. Media container — `SHFL` (SOLVED)

Every binary media payload is a SHFL-wrapped H.264 frame. Reversed from
`ParseTVTPackageHeader` (function 638 in `libffmpeg.wasm`) and verified
byte-for-byte against the WASM player's own output.

### 5.1 Layout

```
+----------------------------------+  offset 0
|     StreamHeader (44 bytes)      |
+----------------------------------+  offset 44
|     FrameHeader (24 bytes)       |
+----------------------------------+  offset 68
|  ExtInfo (byExtInfoLen bytes)    |  present on keyframes (44 B observed)
+----------------------------------+  offset 68 + byExtInfoLen
|  Payload (dwRealFrameLen bytes)  |  Annex-B NAL units, ready to decode
+----------------------------------+
|  Tail (variable, optional)       |  watermark signature on keyframes (62 B)
+----------------------------------+
```

### 5.2 StreamHeader (44 bytes)

| Offset | Size | Name | Notes |
|:-:|:-:|---|---|
| `+0` | 4 | `swFlag` (u32 LE) | `0x4C484853` = ASCII `"SHFL"` little-endian |
| `+4` | 3 | `version` | Observed constant `03 01 07` |
| `+7` | 1 | `byIsKeyFrame` | `0` or `1` |
| `+8` | 16 | reserved / flags | Mostly zero; may carry stream-type bits we haven't classified |
| `+24` | 4 | `bodySize` (u32 LE) | Total chunk length minus 44 (= FrameHeader + ext + payload + tail) |
| `+28` | 8 | `timestamp64_a` | Appears to be Windows FILETIME-style 64-bit tick; not yet mapped to Unix ms — the WASM exposes it via `getRealTimestamp(tsLow, tsHigh) = tsHigh*1e8 + tsLow` which yields Unix ms, so some divide/modulo conversion happens internally |
| `+36` | 4 | `seq` (u32 LE) | Monotonically increasing frame counter within the task (resets per `/device/playback/open`) |
| `+40` | 4 | reserved | zero |

### 5.3 FrameHeader (24 bytes) @ offset 44

| Offset | Size | Name | Notes |
|:-:|:-:|---|---|
| `+0` | 1 | `byFrameType` | `0` for ongoing video; `4` is the **resync IDR emitted as the first frame of every fresh `playback/open` task** (and after restarts) — verified by probe 30. Treat both `0` and `4` as "video frame"; the value is informational. |
| `+1` | 1 | `byExtInfoLen` | `0` for P-frames, `44` for keyframes in captures |
| `+2` | 2 | reserved | |
| `+4` | 4 | `dwRealFrameLen` (u32 LE) | **Length of the Annex-B NAL payload** |
| `+8` | 8 | `timestamp64_b` | Another 64-bit timestamp (likely per-frame PTS) |
| `+16` | 8 | `timestamp64_c` | Likely DTS or capture time |

### 5.4 ExtInfo (byExtInfoLen bytes)

Only present when `byExtInfoLen > 0` (observed: keyframes only, 44 bytes).
Content not decoded yet. **Not required** to recover the video bitstream —
the actual H.264 SPS/PPS NAL units live in the Payload, not here. Likely
carries stream-reset metadata or codec parameter hints.

### 5.5 Payload (dwRealFrameLen bytes)

**Already Annex-B framed.** Just pass to your H.264 decoder.

- Keyframes (`byIsKeyFrame=1`, `byExtInfoLen=44`): Payload contains
  SPS (NAL type 7) + PPS (NAL type 8) + IDR (NAL type 5), each preceded
  by a 4-byte `00 00 00 01` start code.
- P-frames (`byIsKeyFrame=0`, `byExtInfoLen=0`): Payload contains a single
  P-slice (NAL type 1) with a 4-byte start code.

### 5.6 Tail

On keyframes the chunk has **62 bytes after the Payload**:

```
[2B ?][01 01 01 00][34 00 00 00][52 bytes signature]
```

The prefix `34 00 00 00` decodes to `0x34 = 52` (size of the final block
in little-endian). This is the per-keyframe "watermark" — `decoder.js`
surfaces it as `watermarkLen` in `_decodeFrame`'s output struct. It's not
part of the H.264 bitstream and can be ignored for playback.

On P-frames the tail is usually empty; a few captured frames had a 3-byte
tail that didn't affect decoding.

### 5.7 Validation (from `ParseTVTPackageHeader`)

The parser rejects a chunk with non-zero return code if:

1. `dwDataLen < 44` — insufficient bytes for StreamHeader (error log
   references `STREAM_HEADER_INFO`), returns `8`.
2. `*(u32)pData != 0x4C484853` — swFlag mismatch, returns `7`.
3. `dwDataLen < 68` — insufficient for FrameHeader, returns `8`.
4. `68 + byExtInfoLen + dwRealFrameLen > dwDataLen` — payload overruns,
   returns `8`.
5. `68 + byExtInfoLen > dwDataLen` (in strict mode) — ext overruns,
   returns `8`.

Success returns `0`. An additional code `kErrorCode_Parse_FrameType_POS`
(12) is used for POS-text overlays embedded in the stream and is handled
specially by the JS glue (`handlePosBuf`).

### 5.8 Minimal demuxer

A minimal Python demuxer is just:

```python
byExt = chunk[45]
dwLen = struct.unpack_from('<I', chunk, 44+4)[0]
annex_b_payload = chunk[68+byExt : 68+byExt+dwLen]
```

Concatenating `annex_b_payload` across all chunks of a task yields a
byte-identical H.264 bitstream to what the NVR's own WASM remuxer produces.
The TypeScript implementation in `src/nvr/shfl.ts` is the canonical version
used by the app.

---

## 6. Known gaps / TODO

### 6.1 Blocking gaps (must-solve before video renders)

~~SHFL demux.~~ **Solved.** See §5.

### 6.2 Nice-to-have gaps (MVP can ship without, but want them soon)

2. **Trick play.** Pause, FF/rewind, variable speed, frame-step — not in the
   capture. Record another session exercising those buttons to learn the WS
   commands. Likely candidates: `/device/playback/pause`,
   `/device/playback/resume`, `/device/playback/speed`,
   `/device/playback/step_forward`.
3. **Audio.** Live audio was disabled (`audio/close` sent immediately). Need
   to (a) capture a session with audio on, (b) identify the audio codec
   (likely G.711 µ-law or AAC based on NVR conventions), (c) confirm whether
   it's multiplexed inside SHFL or delivered on a parallel stream.
4. **Error codes.** Only `code:0` seen. Trigger a bad `channel_id`, expired
   session, overlapping `task_id`, out-of-range `start_time`, etc., to map
   the error space. Likely non-zero `code` + human `msg`.
5. **Session expiry + renewal.** No `/logout`, `/keepAlive`, or automatic
   re-login observed. Leave the UI idle for 10+ minutes with Charles running
   to capture the idle-timeout / refresh path. (The `<expiration>` field in
   `queryPasswordSecurity` hints at a password-age policy, not a session
   timeout.)
6. **Time zone semantics.** `queryChlRecLog` tags its `<recList>` with
   `timeZone="UTC"` but the string times in our capture looked like local
   (EST). Need to confirm which the server actually emits and which the WS
   `start_time`/`end_time` expects. (Current assumption: WS uses Unix
   seconds UTC, XML timestamps are local wall-clock with a timezone
   attribute.)
7. **Multi-stream behavior under load.** Verify whether the NVR throttles
   when multiple WS playback tasks run concurrently (e.g., preview + 2
   playbacks).

### 6.3 Out-of-scope for the initial app

- PTZ control.
- Snapshot / single-frame capture.
- Backup / download (.mp4 export via `recordBuilder.js`).
- Config writes (password change, network config, etc.) — would require the
  decrypted `sessionKey` and AES-wrapped XML payloads.
- OvrC cloud traversal (we're targeting LAN only).

---

## 7. Minimal implementation recipe (for reference)

Once SHFL is solved, an iOS-native playback client is roughly:

1. `POST /reqLogin` → parse `sessionId`, `nonce`, `token`.
2. Compute `passwordField = SHA512( UPPER(MD5(pw)) + "#" + nonce )` (braces kept, MD5 uppercase).
3. `POST /doLogin` with cookie `sessionId=<bare-uuid>`, body carrying
   `token` + `passwordField`. On success, keep the cookie.
4. (Optional) decrypt `sessionKey` for future config endpoints.
5. Enumerate cameras: `queryChlsExistRec` (+ `queryNodeList` for names if
   desired).
6. Enumerate recordings for the selected camera:
   - `queryDatesExistRec` → populate calendar.
   - `queryChlRecLog` → populate timeline segments.
7. Open `ws://<nvr>/requestWebsocketConnection?sessionID=<bare-uuid>`.
8. Await `/device/create_connection#response`.
9. Send `/device/playback/open` with a client-generated `task_id`,
   `channel_id`, `start_time`, `end_time`, `stream_index:1`, `type_mask`.
10. Send `/device/playback/audio/close` (until audio is reverse-engineered).
11. For each incoming binary frame:
    - Parse 4-byte zero marker + 4-byte hdrlen.
    - Parse JSON header, verify `task_id`.
    - Strip `SHFL` header from payload; demux to H.264/H.265 NALs.
    - Feed to `AVSampleBufferDisplayLayer` (iOS) / `MediaCodec` (Android).
12. Every ~8 frames send `/device/playback/refresh_play_index` with an
    incrementing index.
13. For seek: send `/device/playback/all_frame` with
    `"YYYY-MM-DD HH:MM:SS:mmm"` (confirm timezone).
14. On stop: `/device/playback/close`.

---

## 8. File map (reference implementations on the device)

These files — all GET'able from the NVR and captured in the HAR — contain the
authoritative client-side logic. Worth keeping local copies:

| Path on device | Purpose |
|---|---|
| `/js/app/login.js` | Login page orchestration (`reqLogin` + `doLogin`) |
| `/js/lib/CommonFunctions.js` | `EncryptSha512`, `Decrypt`, `Encrypt`, `SetAuthInfo` |
| `/js/lib/sha512.js` | SHA-512 implementation |
| `/js/lib/spark-md5.js` | MD5 |
| `/js/lib/aes.js` + `/js/lib/cipher-core-min.js` + `/js/lib/mode-ecb-min.js` + `/js/lib/pad-zeropadding.js` | CryptoJS AES-ECB-ZeroPadding |
| `/js/lib/Communication.js` | XML request envelope helpers |
| `/js/lib/websocket.base.js` | WS connection manager |
| `/js/lib/websocket.cmd.js` | Text-frame command dispatcher |
| `/js/lib/websocket.recordBackup.js` | Backup/download task handling |
| `/js/lib/websocket.plugin.js` | Plugin bootstrap |
| `/js/lib/WasmPlayer/wasm-player.js` | Top-level player |
| `/js/lib/WasmPlayer/TVTPlayer.js` | TVT-branded wrapper |
| `/js/lib/WasmPlayer/PlaybackTimeline.js` | Timeline UI |
| `/js/lib/WasmPlayer/decoder.js` | JS glue for the WASM decoder — **read for SHFL hints** |
| `/js/lib/WasmPlayer/recordBuilder.js` | SHFL → MP4 remuxer — **best doc of SHFL semantics** |
| `/js/lib/WasmPlayer/downloader.js` | WS transport glue |
| `/js/lib/WasmPlayer/libffmpeg.js` | JS loader for the WASM |
| `/js/lib/WasmPlayer/libffmpeg.wasm` | FFmpeg build with SHFL demuxer — **authoritative source** |
| `/js/lib/WasmPlayer/webgl.js` | WebGL renderer (YUV → RGB) |
| `/js/lib/WasmPlayer/pcm-player.js` | Audio playback |
| `/js/lib/WasmPlayer/voice-ctrl.js` | Talk-back |
| `/js/app/RecWasm/recWasm.js` | Recording-playback page controller |

---

## 9. Note on Charles captures

If you grab your own captures from the web client with Charles Proxy:
WS traffic is stored as the **raw WebSocket framed bytes** (masked for
client→server, unmasked for server→client) base64'd into
`request.body.encoded` and `response.body.encoded` of the
`ws://…/requestWebsocketConnection?...` entry. Unmask client frames with
the standard RFC 6455 algorithm before reading JSON.
