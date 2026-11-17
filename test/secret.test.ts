import test from "node:test"
import assert from "node:assert/strict"
import { createHash, X509Certificate } from "node:crypto"
import { generateCertificate } from "../src/certificate/certificate-generator.js"
import { pairingSecret, unsignedBytes } from "../src/pairing/secret.js"
import { pairingCode, pairingDigest } from "./fake-tv.js"

test("unsigned big-endian bytes: odd-length hex is padded, leading zero bytes dropped", () => {
  assert.deepEqual(unsignedBytes("0x10001"), Buffer.from([0x01, 0x00, 0x01]))
  assert.deepEqual(unsignedBytes("0x3"), Buffer.from([0x03]))
  assert.deepEqual(unsignedBytes("ABC"), Buffer.from([0x0a, 0xbc]))
  assert.deepEqual(unsignedBytes("0000FF"), Buffer.from([0xff]))
  assert.deepEqual(unsignedBytes("0x0"), Buffer.from([0x00]))
})

// Node's TLS objects give the modulus and exponent as hex; JWK gives the same numbers as unsigned base64url. The
// secret must match the reference (the fake TV's digest) for real keys.
const asNodeKey = (pem: string) => {
  const jwk = new X509Certificate(pem).publicKey.export({ format: "jwk" }) as { n: string; e: string }
  const hex = (v: string) => Buffer.from(v, "base64url").toString("hex").toUpperCase()
  return { modulus: hex(jwk.n), exponent: `0x${hex(jwk.e).replace(/^0+/, "")}` }
}

test("the secret matches the reference digest for real RSA keys, and the code's first byte is checked", () => {
  const client = generateCertificate("c", "US", "ST", "L", "O", "OU")
  const server = generateCertificate("s", "US", "ST", "L", "O", "OU")
  const code = pairingCode(client.cert, server.cert, "1A2B")
  const secret = pairingSecret(asNodeKey(client.cert), asNodeKey(server.cert), code)
  assert.deepEqual(secret, pairingDigest(client.cert, server.cert, "1A2B"))
  assert.deepEqual(pairingSecret(asNodeKey(client.cert), asNodeKey(server.cert), code.toLowerCase()), secret)
  const wrongCheck = ((Number.parseInt(code.slice(0, 2), 16) + 1) % 256).toString(16).padStart(2, "0") + "1A2B"
  assert.equal(pairingSecret(asNodeKey(client.cert), asNodeKey(server.cert), wrongCheck), undefined)
  assert.equal(pairingSecret(asNodeKey(client.cert), asNodeKey(server.cert), "12345"), undefined)
  assert.equal(pairingSecret(asNodeKey(client.cert), asNodeKey(server.cert), "GGGGGG"), undefined)
})

test("fixed vector: small keys hash their minimal bytes (an even-length exponent no longer breaks)", () => {
  const client = { modulus: "00C3", exponent: "0x0101" } // leading zero byte, even-length exponent
  const server = { modulus: "D5", exponent: "0x3" } // odd-length exponent
  const digest = createHash("sha256")
    .update(Buffer.from([0xc3]))
    .update(Buffer.from([0x01, 0x01]))
    .update(Buffer.from([0xd5]))
    .update(Buffer.from([0x03]))
    .update(Buffer.from([0xbe, 0xef]))
    .digest()
  const code = digest.subarray(0, 1).toString("hex") + "beef"
  assert.deepEqual(pairingSecret(client, server, code), digest)
})
