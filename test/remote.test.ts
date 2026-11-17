import test, { after } from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { generateCertificate } from "../src/certificate/certificate-generator.js"
import { createRemoteManager } from "../src/remote/remote-manager.js"
import { DEFAULT_FEATURES, Feature } from "../src/remote/remote-message-manager.js"
import { createLogger } from "../src/logger.js"
import { fakeRemoteTv } from "./fake-tv.js"

const client = generateCertificate("test-client", "US", "ST", "L", "O", "OU")
const cleanups: (() => unknown)[] = []
after(async () => {
  for (const c of cleanups.reverse()) await c()
})

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

test("features: the reply is what we want AND what the TV offers, in configure and set-active", async () => {
  const tvOffers = Feature.PING | Feature.KEY | Feature.POWER | Feature.VOLUME // no IME, voice or app links
  const tv = await fakeRemoteTv({ code1: tvOffers })
  cleanups.push(() => tv.close())
  const remote = createRemoteManager("127.0.0.1", tv.port, client)
  cleanups.push(() => remote.stop())
  const ready = once(remote, "ready")
  await remote.start()
  await ready
  await until(() => tv.received.some((m) => m.remoteSetActive))
  const configure = tv.received.find((m) => m.remoteConfigure)
  const active = tv.received.find((m) => m.remoteSetActive)
  const expected = DEFAULT_FEATURES & tvOffers
  assert.equal(expected, Feature.KEY | Feature.POWER | Feature.VOLUME)
  assert.equal(configure?.remoteConfigure.code1, expected)
  assert.equal(active?.remoteSetActive.active, expected)
})

test("instances: two remotes in one process keep their own identity and debug setting", async () => {
  const tvA = await fakeRemoteTv()
  const tvB = await fakeRemoteTv()
  cleanups.push(() => tvA.close(), () => tvB.close())
  const lines: string[] = []
  const original = console.debug
  console.debug = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
  cleanups.push(() => (console.debug = original))
  const a = createRemoteManager("127.0.0.1", tvA.port, client, {
    deviceInfo: { manufacturer: "Maker A", model: "Model A" },
    log: createLogger(true),
  })
  const b = createRemoteManager("127.0.0.1", tvB.port, client, {
    deviceInfo: { manufacturer: "Maker B", model: "Model B" },
    log: createLogger(false),
  })
  cleanups.push(() => a.stop(), () => b.stop())
  await Promise.all([a.start(), b.start()])
  await until(() => tvA.received.some((m) => m.remoteConfigure) && tvB.received.some((m) => m.remoteConfigure))
  assert.equal(tvA.received.find((m) => m.remoteConfigure)?.remoteConfigure.deviceInfo.model, "Model A")
  assert.equal(tvB.received.find((m) => m.remoteConfigure)?.remoteConfigure.deviceInfo.vendor, "Maker B")
  assert.ok(lines.length > 0, "remote A (debug) logs")
  // With A stopped, a whole handshake by a remote whose debug is off logs nothing.
  a.stop()
  lines.length = 0
  const c = createRemoteManager("127.0.0.1", tvB.port, client, { log: createLogger(false) })
  cleanups.push(() => c.stop())
  await c.start()
  await until(() => tvB.received.filter((m) => m.remoteSetActive).length >= 2)
  assert.deepEqual(lines, [])
})

test("reconnect: a dropped session comes back after a back-off, which resets once connected; stop() cancels it", async () => {
  const tv = await fakeRemoteTv()
  cleanups.push(() => tv.close())
  const remote = createRemoteManager("127.0.0.1", tv.port, client, { backoffMs: [50, 400] })
  cleanups.push(() => remote.stop())
  const states: string[] = []
  remote.on("state", (s) => states.push(s))
  await remote.start()
  await until(() => remote.state === "ready")
  await until(() => remote.isOn === true)

  // Clean close by the TV: the first retry waits 50 ms.
  tv.sockets[0]?.end()
  await until(() => tv.sockets.length === 2 && remote.state === "ready")
  assert.deepEqual(states.slice(0, 4), ["ready", "backoff", "connecting", "ready"])

  // Connected again, so the next drop starts over at 50 ms rather than 400 ms.
  const t0 = Date.now()
  tv.sockets[1]?.end()
  await until(() => tv.sockets.length === 3 && remote.state === "ready")
  assert.ok(Date.now() - t0 < 350, `reconnected after ${Date.now() - t0} ms`)

  // A pending reconnect is cancelled by stop().
  tv.sockets[2]?.end()
  await until(() => remote.state === "backoff")
  remote.stop()
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(tv.sockets.length, 3)
  assert.equal(remote.state, "stopped")
  assert.equal(remote.sendPower(), false)
})

test("keys: sent only while ready; the TV's power report is kept", async () => {
  const tv = await fakeRemoteTv({ started: false })
  cleanups.push(() => tv.close())
  const remote = createRemoteManager("127.0.0.1", tv.port, client)
  cleanups.push(() => remote.stop())
  assert.equal(remote.sendKey(85), false)
  await remote.start()
  await until(() => remote.isOn === false)
  assert.equal(remote.sendPower(), true)
  await until(() => tv.received.some((m) => m.remoteKeyInject?.keyCode === "KEYCODE_POWER"))
  await until(() => remote.isOn === true)
})
