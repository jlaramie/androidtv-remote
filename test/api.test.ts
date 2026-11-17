import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createRemote, RemoteKeyCode, startPairing } from "../src/index.js"
import { fakePairingTv, fakeRemoteTv } from "./fake-tv.js"

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

test("public API: pair with a new certificate, then control the TV with it", async () => {
  const pairingTv = await fakePairingTv()
  const remoteTv = await fakeRemoteTv({ started: false })
  cleanups.push(() => pairingTv.close(), () => remoteTv.close())

  const session = await startPairing("127.0.0.1", { port: pairingTv.port, serviceName: "Alexa Chromecast" })
  assert.match(session.certificate.cert, /BEGIN CERTIFICATE/)
  assert.equal(await session.finish(pairingTv.code() as string), "paired")

  const remote = createRemote("127.0.0.1", { cert: session.certificate, port: remoteTv.port, model: "Home client" })
  cleanups.push(() => remote.stop())
  void remote.start()
  await until(() => remote.state === "ready" && remote.isOn === false)
  assert.equal(remote.sendKey(RemoteKeyCode.KEYCODE_MEDIA_PAUSE as number), true)
  await until(() => remoteTv.received.some((m) => m.remoteKeyInject?.keyCode === "KEYCODE_MEDIA_PAUSE"))
  assert.equal(remoteTv.received.find((m) => m.remoteConfigure)?.remoteConfigure.deviceInfo.model, "Home client")
})
