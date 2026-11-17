# Changelog

All notable changes to this project are documented here.

---

## v0.2.0-rc.0 (@jlaramie/androidtv-remote)

First release of the fork, published as `@jlaramie/androidtv-remote`.

### Fixes

- Framing: varint length prefixes are read properly, across and within TCP reads, so messages over 127 bytes, split
  reads and coalesced reads no longer stall a connection (louis49/androidtv-remote#21).
- Remote: features are negotiated with the TV (ours ANDed with its `RemoteConfigure.code1`) instead of always 622.
- Pairing: the secret hashes the RSA modulus and exponent as unsigned big-endian bytes, so any exponent works.
- Device info and debug logging are per instance.
- Remote: reconnects back off from 1 s to 60 s, reset once connected, and `stop()` cancels a pending one. A TV that
  went off the network is retried instead of given up on.
- Remote: "unpaired" now means the TV refused our certificate before configuring a session; a reset after that (a
  reboot) reconnects.

### Features

- `startPairing(host, options)` and `PairingSession.finish(code)` / `cancel()`, with timeouts, abort signals and
  explicit results (`paired`, `wrong_code`, `tv_refused`; `PairingError` reasons `unreachable`, `refused`, `timeout`,
  `cancelled`).
- `createRemote(host, { cert })`: a remote session for an already paired TV, with `state`, `isOn` and a `state` event.
- `generateCertificate` is exported.

### Changes

- `sendPower`, `sendKey`, `sendAppLink` and `sendText` return whether anything was sent (false while not ready).
- `createAndroidRemote`'s `sendCode()` returns true once the code is sent; `start()` then resolves with the outcome.

---

## v0.1.2 - 2026-07-10

### Fixes

- Google TV pairing and remote connections are now pinned to IPv4, fixing intermittent `EHOSTUNREACH` failures where a resolved hostname could yield a scopeless IPv6 link-local address that routed to loopback instead of the device. ([030f16d](https://github.com/kud/androidtv-remote/commit/030f16d5cafba269d2a33700f64af1b3e26097b5))
- Pairing now retries transient connect failures (`EHOSTUNREACH`, `EHOSTDOWN`, `ETIMEDOUT`, `ECONNREFUSED`, `ECONNRESET`) a few times before giving up, so a TV dozing in Wi-Fi power-save mode gets a chance to wake up instead of failing the pairing attempt outright. ([030f16d](https://github.com/kud/androidtv-remote/commit/030f16d5cafba269d2a33700f64af1b3e26097b5))
- Fixed the npm publish workflow's OIDC trusted-publisher pattern so releases publish correctly. ([749c968](https://github.com/kud/androidtv-remote/commit/749c9687bdec732cbd1caea833b2d4e412bcf89b))

### Documentation

- Rewrote the docs index as proper orientation content instead of a README copy, and added the kud.io docs landing page. ([ba79679](https://github.com/kud/androidtv-remote/commit/ba79679e8b70c2cd5b6b6cf57bf208b0d6c49bf2))
