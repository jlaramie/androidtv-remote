import test from "node:test"
import assert from "node:assert/strict"
import { createFrameReader, readVarint } from "../src/framing.js"
import * as remote from "../src/remote/remote-message-manager.js"

// Real wire messages: length-delimited RemoteMessages as the TV sends them.
const ping = (val1: number) => Buffer.from(remote.createRemotePingResponse(val1))
// An app link longer than 127 bytes needs a two-byte length prefix.
const longLink = Buffer.from(remote.createRemoteAppLinkLaunchRequest("https://example.test/" + "x".repeat(200)))

const collect = () => {
  const frames: Buffer[] = []
  const reader = createFrameReader((p) => frames.push(Buffer.from(p)))
  return { frames, reader }
}

const payloadOf = (delimited: Buffer) => delimited.subarray(readVarint(delimited)?.bytes ?? 0)

test("a message split across reads is delivered once, when complete", () => {
  const { frames, reader } = collect()
  const msg = ping(7)
  for (const byte of msg) reader.push(Buffer.from([byte]))
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0], payloadOf(msg))
})

test("several messages in one read are all delivered, in order", () => {
  const { frames, reader } = collect()
  reader.push(Buffer.concat([ping(1), ping(2), ping(3)]))
  assert.deepEqual(
    frames.map((f) => (remote.parse(f).toJSON() as { remotePingResponse: { val1: number } }).remotePingResponse.val1),
    [1, 2, 3],
  )
})

test("a message over 127 bytes (two-byte length) is read whole", () => {
  assert.ok(longLink.length > 130)
  assert.equal(readVarint(longLink)?.bytes, 2)
  const { frames, reader } = collect()
  reader.push(longLink.subarray(0, 1))
  reader.push(Buffer.concat([longLink.subarray(1), ping(9).subarray(0, 2)]))
  assert.equal(frames.length, 1)
  const link = remote.parse(frames[0] as Buffer).toJSON() as { remoteAppLinkLaunchRequest: { appLink: string } }
  assert.ok(link.remoteAppLinkLaunchRequest.appLink.endsWith("x".repeat(200)))
  reader.push(ping(9).subarray(2))
  assert.equal(frames.length, 2)
})

test("a malformed or oversized length is an error, not a stall", () => {
  assert.throws(() => collect().reader.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01])))
  assert.throws(() => collect().reader.push(Buffer.from([0x80, 0x80, 0x80, 0x01])), /too large/)
})
