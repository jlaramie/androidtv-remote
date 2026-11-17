import { createHash } from "node:crypto"

/** An RSA public key as Node's TLS certificate objects give it: hex modulus and `0x`-prefixed hex exponent. */
interface RsaKey {
  modulus: string
  exponent: string
}

/**
 * A hex number as unsigned big-endian bytes, without leading zero bytes: what the TV hashes (polo's
 * `removeLeadingNullBytes(BigInteger.toByteArray())`). Handles odd-length hex, which `"0" + exponent` only did by luck.
 */
const unsignedBytes = (hex: string): Buffer => {
  let h = hex.replace(/^0x/i, "")
  if (h.length % 2 === 1) h = `0${h}`
  const bytes = Buffer.from(h, "hex")
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  return bytes.subarray(start)
}

const CODE = /^[0-9a-f]{6}$/i

/**
 * The pairing secret for the 6-character code the TV shows: SHA-256 over the client key, the TV's key and the code's
 * last four hex digits. The code's first byte must equal the digest's first byte, or the code is wrong (checked here,
 * before anything is sent). Returns undefined for a wrong or malformed code.
 */
const pairingSecret = (client: RsaKey, server: RsaKey, code: string): Buffer | undefined => {
  if (!CODE.test(code)) return undefined
  const digest = createHash("sha256")
    .update(unsignedBytes(client.modulus))
    .update(unsignedBytes(client.exponent))
    .update(unsignedBytes(server.modulus))
    .update(unsignedBytes(server.exponent))
    .update(Buffer.from(code.slice(2), "hex"))
    .digest()
  return digest[0] === Number.parseInt(code.slice(0, 2), 16) ? digest : undefined
}

export { pairingSecret, unsignedBytes }
export type { RsaKey }
