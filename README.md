<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![npm](https://img.shields.io/npm/v/@jlaramie/androidtv-remote?style=flat-square&color=CB3837)
![MIT](https://img.shields.io/badge/licence-MIT-22C55E?style=flat-square)

**Control Android TV / Google TV devices over the Android TV Remote v2 protocol**

[Features](#-features) • [Quick Start](#-quick-start) • [API Reference](#-api-reference) • [Development](#-development)

</div>

A modern TypeScript/ESM implementation of the Android TV Remote v2 protocol — pair with a device over TLS, then send keys, launch apps, and inject text directly from Node.

## About this fork

`@jlaramie/androidtv-remote` is a fork of [`@kud/androidtv-remote`](https://github.com/kud/androidtv-remote) 0.1.2 by
Erwann Mest (MIT), made for a home server that pairs Google TVs from a web page. It fixes these problems, each with
tests against a fake TLS TV (`test/fake-tv.ts`):

* **Messages over 127 bytes, split reads and several messages in one read stalled the connection.** A varint frame
  reader now handles all three (louis49/androidtv-remote#21).
* **Features were always 622.** The reply is now what we ask for ANDed with what the TV offers.
* **The pairing hash assumed an odd-length exponent.** The RSA modulus and exponent are hashed as unsigned big-endian
  bytes, as the TV does.
* **Pairing had no timeout and one boolean for every outcome.** `startPairing()` resolves when the TV shows its code;
  `session.finish(code)` resolves `paired`, `wrong_code` or `tv_refused`; both time out and take an `AbortSignal`.
* **Two remotes in one process shared their identity and debug flag.** Each now has its own.
* **Reconnects were a fixed 1 s retry that `stop()` could not cancel**, and an `EHOSTDOWN` stopped them for good. They
  back off 1 s doubling to 60 s.
* **Any connection reset meant "unpaired".** Now only a TV that refuses our certificate before configuring a session
  does; a TV rebooting just reconnects.
* **No way to use a stored certificate without the pairing flow.** `createRemote(host, { cert })` opens a remote
  session with `state` and `isOn`; key sends say whether they were sent.

`createAndroidRemote()` keeps working as before.

**Bundling:** the library loads its two `.proto` schemas from its own folder at run time. When you bundle it into one
file, copy `@jlaramie/androidtv-remote/pairingmessage.proto` and `@jlaramie/androidtv-remote/remotemessage.proto`
(both exported) next to the bundle. [CHANGELOG.md](CHANGELOG.md) lists the details.

### Pair from a server, control later

```js
import { createRemote, RemoteKeyCode, startPairing } from "@jlaramie/androidtv-remote"

const session = await startPairing("192.168.1.42", { serviceName: "My app" }) // the TV shows a code
const result = await session.finish(codeTheUserTyped) // "paired" | "wrong_code" | "tv_refused"
if (result === "paired") store(session.certificate) // keep it: the TV pairs with this certificate

const remote = createRemote("192.168.1.42", { cert: storedCertificate })
void remote.start() // keeps the session up until remote.stop()
remote.on("powered", (on) => console.log("TV is", on ? "on" : "off"))
if (remote.state === "ready" && remote.isOn === false) remote.sendPower()
remote.sendKey(RemoteKeyCode.KEYCODE_MEDIA_PAUSE)
```

## 🌟 Features

- 🔑 **First-class pairing** — handles the full certificate-based TLS pairing flow and persists credentials for reconnect
- ⌨️ **Native text input** — `sendText()` uses IME injection to type arbitrary strings, no keycode mapping required
- 📺 **Full key control** — send any Android key via `RemoteKeyCode` constants (navigation, media, DPAD, volume, and more)
- 📡 **State events** — subscribe to `powered`, `volume`, `current_app`, and `unpaired` with typed payloads
- 🪶 **Lean dependencies** — `crypto-js`, `systeminformation`, and `core-js` dropped; relies only on `node-forge` and `protobufjs`
- 🔇 **Silent by default** — all internal logging is suppressed unless `debug: true` is set, so it fits cleanly inside a larger application
- 🏷️ **Typed API** — full TypeScript types exported; `on()`, `once()`, and `emit()` are all narrowed to the event map

## 🚀 Quick Start

```sh
npm install @jlaramie/androidtv-remote
```

### Pair a new device

```js
import { createAndroidRemote } from "@jlaramie/androidtv-remote"

const remote = createAndroidRemote("192.168.1.42")

remote.on("secret", () => {
  // The TV shows a pairing PIN — read it from stdin and submit
  remote.sendCode("123456")
})

remote.on("ready", () => {
  console.log("paired and connected")
  remote.sendPower()
})

await remote.start()

// Persist the certificate so you skip pairing next time
const cert = remote.getCertificate()
```

### Reconnect with a saved certificate

```js
import { createAndroidRemote } from "@jlaramie/androidtv-remote"

const remote = createAndroidRemote("192.168.1.42", {
  cert: { key: savedKey, cert: savedCert },
})

remote.on("ready", () => {
  remote.sendText("Hello, TV!")
})

await remote.start()
```

## 📖 API Reference

### `createAndroidRemote(host, options?)`

Factory function that returns an `AndroidRemote` instance — an `EventEmitter` extended with control methods.

```ts
import { createAndroidRemote } from "@jlaramie/androidtv-remote"

const remote = createAndroidRemote("192.168.1.42", options)
```

#### Options

| Option         | Type                            | Default              | Description                                                   |
| -------------- | ------------------------------- | -------------------- | ------------------------------------------------------------- |
| `cert`         | `{ key: string; cert: string }` | —                    | Previously obtained certificate. Skips pairing when provided. |
| `pairing_port` | `number`                        | `6467`               | TCP port for the pairing handshake.                           |
| `remote_port`  | `number`                        | `6466`               | TCP port for the remote control session.                      |
| `service_name` | `string`                        | `"androidtv-remote"` | Name sent to the TV during pairing.                           |
| `manufacturer` | `string`                        | —                    | Device manufacturer reported during pairing.                  |
| `model`        | `string`                        | —                    | Device model reported during pairing.                         |
| `debug`        | `boolean`                       | `false`              | Enable verbose internal logging.                              |

### Methods

| Method                         | Returns            | Description                                                   |
| ------------------------------ | ------------------ | ------------------------------------------------------------- |
| `start()`                      | `Promise<boolean>` | Connect to the TV. Triggers pairing if no certificate is set. |
| `sendCode(code)`               | `boolean`          | Submit the PIN displayed on the TV during pairing.            |
| `sendKey(keyCode, direction?)` | `void`             | Send a key press. Use `RemoteKeyCode` constants.              |
| `sendPower()`                  | `void`             | Toggle the TV power state.                                    |
| `sendAppLink(link)`            | `void`             | Launch an app via its deep-link URI.                          |
| `sendText(text)`               | `void`             | Inject arbitrary text via IME (no keycode mapping).           |
| `getCertificate()`             | `Certificate`      | Return the current `{ key, cert }` pair for persistence.      |
| `stop()`                       | `void`             | Close all connections.                                        |

### Events

| Event         | Payload                                              | Fired when                                          |
| ------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `secret`      | —                                                    | The TV is showing a pairing PIN. Call `sendCode()`. |
| `ready`       | —                                                    | Connected and ready for commands.                   |
| `powered`     | `boolean`                                            | TV power state changed.                             |
| `volume`      | `{ level: number; maximum: number; muted: boolean }` | Volume state changed.                               |
| `current_app` | `string`                                             | Foreground app changed (package name).              |
| `unpaired`    | —                                                    | The TV rejected or revoked the certificate.         |
| `error`       | `Error`                                              | A protocol-level error occurred.                    |

### `RemoteKeyCode`

An enum of Android key codes. Common entries:

```ts
import { RemoteKeyCode } from "@jlaramie/androidtv-remote"

remote.sendKey(RemoteKeyCode.KEYCODE_HOME)
remote.sendKey(RemoteKeyCode.KEYCODE_BACK)
remote.sendKey(RemoteKeyCode.KEYCODE_DPAD_UP)
remote.sendKey(RemoteKeyCode.KEYCODE_MEDIA_PLAY_PAUSE)
remote.sendKey(RemoteKeyCode.KEYCODE_VOLUME_UP)
```

### `RemoteDirection`

Direction constants for `sendKey()` — defaults to `SHORT` (a normal press). Use `START_LONG` / `END_LONG` to bracket a long press:

```ts
import { RemoteKeyCode, RemoteDirection } from "@jlaramie/androidtv-remote"

remote.sendKey(RemoteKeyCode.KEYCODE_DPAD_UP) // SHORT by default
remote.sendKey(RemoteKeyCode.KEYCODE_DPAD_DOWN, RemoteDirection.START_LONG)
remote.sendKey(RemoteKeyCode.KEYCODE_DPAD_DOWN, RemoteDirection.END_LONG)
```

### `setDebug(enabled)`

Enable or disable verbose logging globally (affects all instances):

```ts
import { setDebug } from "@jlaramie/androidtv-remote"

setDebug(true)
```

## 🔧 Development

```
androidtv-remote/
├── src/
│   ├── index.ts                        # Public API and factory
│   ├── types.ts                        # Shared TypeScript types
│   ├── device-info.ts                  # Device metadata sent during pairing
│   ├── logger.ts                       # Debug-gated logger
│   ├── certificate/
│   │   └── certificate-generator.ts   # TLS cert generation via node-forge
│   ├── pairing/
│   │   ├── pairing-manager.ts         # Pairing session state machine
│   │   ├── pairing-message-manager.ts
│   │   └── pairingmessage.proto
│   └── remote/
│       ├── remote-manager.ts          # Remote control session
│       ├── remote-message-manager.ts  # Key/text encoding
│       └── remotemessage.proto
└── dist/                              # Compiled output (tsup)
```

```sh
git clone https://github.com/kud/androidtv-remote.git
cd androidtv-remote
npm install
npm run build
```

### Scripts

| Script                | Description                            |
| --------------------- | -------------------------------------- |
| `npm run build`       | Compile TypeScript to `dist/` via tsup |
| `npm run build:watch` | Recompile on file changes              |
| `npm run typecheck`   | Type-check without emitting            |
| `npm test`            | Run tests with tsx                     |
| `npm run clean`       | Remove `dist/`                         |

## 🏗 Tech Stack

| Package      | Role                                                |
| ------------ | --------------------------------------------------- |
| `node-forge` | TLS certificate generation and mutual TLS           |
| `protobufjs` | Encode/decode Android TV Remote v2 protocol buffers |
| `tsup`       | Zero-config TypeScript bundler                      |
| `tsx`        | TypeScript test runner                              |

## Credits

Derived from [androidtv-remote](https://github.com/louis49/androidtv-remote) by [louis49](https://github.com/louis49) (MIT). The reverse-engineered Android TV Remote v2 protocol and `.proto` schemas originate from that project. This library is a TypeScript rewrite with a functional API, native text input support, and a leaner dependency footprint.

---

MIT © [kud](https://github.com/kud)
