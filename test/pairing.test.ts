import test, { after } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { createHash, X509Certificate } from "node:crypto"
import { generateCertificate } from "../src/certificate/certificate-generator.js"
import { PairingError, startPairing } from "../src/pairing/pairing-manager.js"
import { fakePairingTv } from "./fake-tv.js"

const client = generateCertificate("test-client", "US", "ST", "L", "O", "OU")
const cleanups: (() => unknown)[] = []
after(async () => {
  for (const c of cleanups.reverse()) await c()
})

const tv = async (o: Parameters<typeof fakePairingTv>[0] = {}) => {
  const t = await fakePairingTv(o)
  cleanups.push(() => t.close())
  return t
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e,
  )

test("pairing: the session opens when the TV shows its code; the right code pairs", async () => {
  const t = await tv()
  const session = await startPairing("127.0.0.1", { cert: client, port: t.port, serviceName: "Test", clientName: "unit" })
  assert.deepEqual(session.certificate, client)
  assert.equal(t.received[0]?.pairingRequest.serviceName, "Test")
  assert.equal(t.received[0]?.pairingRequest.clientName, "unit")
  const code = t.code()
  assert.match(code ?? "", /^[0-9A-F]{6}$/)
  assert.equal(await session.finish(code as string), "paired")
  assert.equal(await session.finish(code as string), "tv_refused") // one code per session
})

test("pairing: a code whose check byte is wrong is refused before anything is sent", async () => {
  const t = await tv()
  const session = await startPairing("127.0.0.1", { cert: client, port: t.port })
  const code = t.code() as string
  const wrong = ((Number.parseInt(code.slice(0, 2), 16) + 1) % 256).toString(16).padStart(2, "0") + code.slice(2)
  assert.equal(await session.finish(wrong), "wrong_code")
  assert.equal(t.received.filter((m) => m.pairingSecret).length, 0)
})

test("pairing: a secret the TV rejects (status 402) is wrong_code", async () => {
  // The TV shows a code for a different tail than the one we type, but with a matching check byte: the TV decides.
  const t = await tv({ tail: "0000" })
  const session = await startPairing("127.0.0.1", { cert: client, port: t.port })
  const shown = t.code() as string
  // Find another tail whose digest shares the check byte, so the local check passes and only the TV can refuse.
  const jwk = (pem: string) => new X509Certificate(pem).publicKey.export({ format: "jwk" }) as { n: string; e: string }
  const b = (v: string) => Buffer.from(v, "base64url")
  const c = jwk(client.cert)
  const s = jwk(t.certificate.cert)
  let other = ""
  for (let i = 1; i < 0x10000 && !other; i++) {
    const tail = i.toString(16).padStart(4, "0").toUpperCase()
    const d = createHash("sha256").update(b(c.n)).update(b(c.e)).update(b(s.n)).update(b(s.e)).update(Buffer.from(tail, "hex")).digest()
    if (d[0] === Number.parseInt(shown.slice(0, 2), 16) && tail !== shown.slice(2)) other = shown.slice(0, 2) + tail
  }
  assert.equal(await session.finish(other), "wrong_code")
  assert.equal(t.received.filter((m) => m.pairingSecret).length, 1)
})

test("pairing: a TV that refuses the request rejects with reason refused", async () => {
  const t = await tv({ refuse: true })
  const e = await rejection(startPairing("127.0.0.1", { cert: client, port: t.port }))
  assert.ok(e instanceof PairingError)
  assert.equal((e as PairingError).reason, "refused")
})

test("pairing: nothing listening is unreachable; a TV that never answers times out", async () => {
  const closed = net.createServer()
  closed.listen(0, "127.0.0.1")
  await once(closed, "listening")
  const port = (closed.address() as AddressInfo).port
  closed.close()
  await once(closed, "close")
  const unreachable = await rejection(startPairing("127.0.0.1", { cert: client, port, timeoutMs: 15_000 }))
  assert.equal((unreachable as PairingError).reason, "unreachable")

  const silent = net.createServer(() => {}) // accepts TCP, never speaks TLS
  silent.listen(0, "127.0.0.1")
  await once(silent, "listening")
  cleanups.push(() => silent.close())
  const started = Date.now()
  const timeout = await rejection(
    startPairing("127.0.0.1", { cert: client, port: (silent.address() as AddressInfo).port, timeoutMs: 300 }),
  )
  assert.equal((timeout as PairingError).reason, "timeout")
  assert.ok(Date.now() - started < 2000)
})

test("pairing: a cancelled signal stops the attempt", async () => {
  const t = await tv()
  const ac = new AbortController()
  ac.abort()
  const e = await rejection(startPairing("127.0.0.1", { cert: client, port: t.port, signal: ac.signal }))
  assert.equal((e as PairingError).reason, "cancelled")
})
