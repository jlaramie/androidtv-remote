// A fake Android TV for tests: TLS servers speaking the pairing (6467) and remote (6466) protocols on loopback, with a
// self-signed certificate. Nothing here talks to a real TV.
import tls from "node:tls"
import { X509Certificate, createHash } from "node:crypto"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import protobuf from "protobufjs"
import { generateCertificate } from "../src/certificate/certificate-generator.js"
import { createFrameReader } from "../src/framing.js"
import type { Certificate } from "../src/types.js"

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src")
const remoteRoot = protobuf.loadSync(join(src, "remote", "remotemessage.proto"))
const RemoteMessage = remoteRoot.lookupType("remote.RemoteMessage")
const pairingRoot = protobuf.loadSync(join(src, "pairing", "pairingmessage.proto"))
const PairingMessage = pairingRoot.lookupType("pairing.PairingMessage")

let tvCert: Certificate | undefined
/** One TV certificate per test run (RSA key generation in node-forge is slow). */
const tvCertificate = (): Certificate => {
  tvCert ??= generateCertificate("fake-tv", "US", "ST", "L", "O", "OU")
  return tvCert
}

const encode = (type: protobuf.Type, payload: object): Buffer =>
  Buffer.from(type.encodeDelimited(type.create(payload)).finish())

type Json = Record<string, any>

export interface FakeRemoteTv {
  port: number
  /** Every message the client sent, as JSON. */
  received: Json[]
  sockets: tls.TLSSocket[]
  /** Sends a RemoteMessage to every connected client. */
  send(payload: object): void
  close(): Promise<void>
}

export async function fakeRemoteTv(
  o: { code1?: number; started?: boolean; refuseCertificate?: boolean } = {},
): Promise<FakeRemoteTv> {
  const received: Json[] = []
  const sockets: tls.TLSSocket[] = []
  const cert = tvCertificate()
  const server = tls.createServer(
    { key: cert.key, cert: cert.cert, requestCert: true, rejectUnauthorized: false },
    (sock) => {
      if (o.refuseCertificate) {
        // What a TV does with a certificate it does not know: it drops the connection at once.
        sock.resetAndDestroy()
        return
      }
      sockets.push(sock)
      const reader = createFrameReader((p) => {
        const m = RemoteMessage.decode(p).toJSON() as Json
        received.push(m)
        if (m.remoteConfigure) sock.write(encode(RemoteMessage, { remoteSetActive: {} }))
        else if (m.remoteSetActive)
          sock.write(encode(RemoteMessage, { remoteStart: { started: o.started ?? true } }))
        else if (m.remoteKeyInject?.keyCode === "KEYCODE_POWER")
          sock.write(encode(RemoteMessage, { remoteStart: { started: !(o.started ?? true) } }))
      })
      sock.on("data", (d) => reader.push(d))
      sock.on("error", () => {})
      sock.write(
        encode(RemoteMessage, {
          remoteConfigure: { code1: o.code1 ?? 639, deviceInfo: { model: "Fake TV", vendor: "Test" } },
        }),
      )
    },
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    port: (server.address() as AddressInfo).port,
    received,
    sockets,
    send: (payload) => {
      for (const s of sockets) if (!s.destroyed) s.write(encode(RemoteMessage, payload))
    },
    close: async () => {
      for (const s of sockets) s.destroy()
      server.close()
      await once(server, "close")
    },
  }
}

/** SHA-256 over both RSA keys (unsigned big-endian modulus, then exponent) and the code's last four hex digits. */
export function pairingDigest(clientCertPem: string, serverCertPem: string, tail: string): Buffer {
  // JWK n and e are exactly the unsigned big-endian bytes, without padding: an independent reference for the client.
  const jwk = (pem: string) => new X509Certificate(pem).publicKey.export({ format: "jwk" }) as { n: string; e: string }
  const c = jwk(clientCertPem)
  const s = jwk(serverCertPem)
  const b = (v: string) => Buffer.from(v, "base64url")
  return createHash("sha256")
    .update(b(c.n))
    .update(b(c.e))
    .update(b(s.n))
    .update(b(s.e))
    .update(Buffer.from(tail, "hex"))
    .digest()
}

/** The 6-character code a TV would show for this client certificate (its first byte checks the rest). */
export function pairingCode(clientCertPem: string, serverCertPem: string, tail = "B2C3"): string {
  return pairingDigest(clientCertPem, serverCertPem, tail).subarray(0, 1).toString("hex").toUpperCase() + tail
}

export interface FakePairingTv {
  port: number
  certificate: Certificate
  received: Json[]
  /** The code the TV "shows" once the client is configured. */
  code(): string | undefined
  close(): Promise<void>
}

/** A pairing server: request → option → configuration → secret, checking the secret against the shown code. */
export async function fakePairingTv(o: { refuse?: boolean; tail?: string } = {}): Promise<FakePairingTv> {
  const received: Json[] = []
  const cert = tvCertificate()
  let shown: string | undefined
  const sockets: tls.TLSSocket[] = []
  const reply = (sock: tls.TLSSocket, payload: object, status = 200) =>
    sock.write(encode(PairingMessage, { ...payload, status, protocolVersion: 2 }))
  const server = tls.createServer(
    { key: cert.key, cert: cert.cert, requestCert: true, rejectUnauthorized: false },
    (sock) => {
      sockets.push(sock)
      sock.on("error", () => {})
      const reader = createFrameReader((p) => {
        const m = PairingMessage.decode(p).toJSON() as Json
        received.push(m)
        if (m.pairingRequest) {
          if (o.refuse) return reply(sock, {}, 400)
          return reply(sock, { pairingRequestAck: { serverName: "Fake TV" } })
        }
        if (m.pairingOption) return reply(sock, { pairingOption: m.pairingOption })
        if (m.pairingConfiguration) {
          const peer = sock.getPeerX509Certificate()
          shown = pairingCode(peer?.toString() ?? "", cert.cert, o.tail)
          return reply(sock, { pairingConfigurationAck: {} })
        }
        if (m.pairingSecret) {
          const secret = Buffer.from(m.pairingSecret.secret ?? "", "base64")
          const peer = sock.getPeerX509Certificate()
          const want = pairingDigest(peer?.toString() ?? "", cert.cert, (shown ?? "").slice(2))
          if (!secret.equals(want)) return reply(sock, {}, 402)
          reply(sock, { pairingSecretAck: { secret: secret.toString("base64") } })
          sock.end()
        }
      })
      sock.on("data", (d) => reader.push(d))
    },
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    port: (server.address() as AddressInfo).port,
    certificate: cert,
    received,
    code: () => shown,
    close: async () => {
      for (const s of sockets) s.destroy()
      server.close()
      await once(server, "close")
    },
  }
}
