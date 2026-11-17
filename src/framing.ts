// Length-delimited protobuf framing for both protocol channels. Every message on the wire is a base-128 varint
// length followed by that many bytes. A TCP read can carry part of a message, exactly one, or several, and a length
// above 127 takes two varint bytes — the old "first byte equals the remaining length" check stalled on all of those
// (louis49/androidtv-remote#21).

/** The largest message accepted; anything bigger is a broken or hostile peer. */
const MAX_FRAME_BYTES = 1 << 20

/** A varint at the start of `buf`: its value and how many bytes it took, or undefined when it is not complete yet. */
const readVarint = (buf: Buffer): { value: number; bytes: number } | undefined => {
  let value = 0
  for (let i = 0; i < Math.min(buf.length, 5); i++) {
    const byte = buf[i] as number
    value += (byte & 0x7f) * 2 ** (7 * i)
    if ((byte & 0x80) === 0) return { value, bytes: i + 1 }
  }
  if (buf.length >= 5) throw new Error("Invalid message length prefix")
  return undefined
}

/** Collects bytes from a socket and calls `onFrame` with each complete message's bytes, in order. */
const createFrameReader = (onFrame: (payload: Buffer) => void) => {
  let pending = Buffer.alloc(0)
  return {
    /** Adds a read. Throws on a malformed or oversized length; the caller should then drop the connection. */
    push(data: Buffer | string): void {
      const bytes = Buffer.from(data)
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes])
      for (;;) {
        const header = readVarint(pending)
        if (!header) return
        if (header.value > MAX_FRAME_BYTES) throw new Error("Message too large")
        const end = header.bytes + header.value
        if (pending.length < end) return
        const payload = pending.subarray(header.bytes, end)
        pending = pending.subarray(end)
        onFrame(payload)
      }
    },
    reset(): void {
      pending = Buffer.alloc(0)
    },
  }
}

export { createFrameReader, readVarint, MAX_FRAME_BYTES }
