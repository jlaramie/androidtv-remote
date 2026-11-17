import test, { after } from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { generateCertificate } from "../src/certificate/certificate-generator.js"
import { createRemoteManager } from "../src/remote/remote-manager.js"
import { DEFAULT_FEATURES, Feature } from "../src/remote/remote-message-manager.js"
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
