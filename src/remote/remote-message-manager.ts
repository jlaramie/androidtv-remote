import protobuf from "protobufjs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { deviceInfo } from "../device-info.js"
import { log } from "../logger.js"

const directory = dirname(fileURLToPath(import.meta.url))
const root = protobuf.loadSync(join(directory, "remotemessage.proto"))
const RemoteMessage = root.lookupType("remote.RemoteMessage")

const RemoteKeyCode = root.lookupEnum("remote.RemoteKeyCode").values
const RemoteDirection = root.lookupEnum("remote.RemoteDirection").values

const create = (payload: Record<string, unknown>): Uint8Array => {
  if (!payload.remotePingResponse) {
    log.debug("Create Remote " + JSON.stringify(payload))
  }
  const errMsg = RemoteMessage.verify(payload)
  if (errMsg) throw new Error(errMsg)
  const message = RemoteMessage.create(payload)
  const array = RemoteMessage.encodeDelimited(message).finish()
  if (!payload.remotePingResponse) {
    log.debug("Sending " + JSON.stringify(message.toJSON()))
  }
  return array
}

/** Remote-channel features, as bits of RemoteConfigure.code1 / RemoteSetActive.active. */
const Feature = {
  PING: 1 << 0,
  KEY: 1 << 1,
  IME: 1 << 2,
  VOICE: 1 << 3,
  POWER: 1 << 5,
  VOLUME: 1 << 6,
  APP_LINK: 1 << 9,
} as const

/** What this library asks for by default: keys, text input, voice, power, volume and app links (upstream's 622). */
const DEFAULT_FEATURES =
  Feature.KEY | Feature.IME | Feature.VOICE | Feature.POWER | Feature.VOLUME | Feature.APP_LINK

const createRemoteConfigure = (features: number = DEFAULT_FEATURES): Uint8Array =>
  create({
    remoteConfigure: {
      code1: features,
      deviceInfo: {
        model: deviceInfo.model,
        vendor: deviceInfo.manufacturer,
        unknown1: 1,
        unknown2: "1",
        packageName: "androidtv-remote",
        appVersion: "1.0.0",
      },
    },
  })

const createRemoteSetActive = (active: number): Uint8Array =>
  create({ remoteSetActive: { active } })

const createRemotePingResponse = (val1: number): Uint8Array =>
  create({ remotePingResponse: { val1 } })

const createRemoteKeyInject = (
  direction: number,
  keyCode: number,
): Uint8Array => create({ remoteKeyInject: { keyCode, direction } })

const createRemoteImeBatchEdit = (
  imeCounter: number,
  fieldCounter: number,
  text: string,
): Uint8Array => {
  const cursor = text.length
  return create({
    remoteImeBatchEdit: {
      imeCounter,
      fieldCounter,
      editInfo: [
        {
          insert: 1,
          textFieldStatus: { start: cursor, end: cursor, value: text },
        },
      ],
    },
  })
}

const createRemoteAppLinkLaunchRequest = (appLink: string): Uint8Array =>
  create({ remoteAppLinkLaunchRequest: { appLink } })

/** Decodes one message's bytes, without its length prefix (see framing.ts). */
const parse = (payload: Buffer): protobuf.Message => RemoteMessage.decode(payload)

export {
  Feature,
  DEFAULT_FEATURES,
  RemoteKeyCode,
  RemoteDirection,
  createRemoteConfigure,
  createRemoteSetActive,
  createRemotePingResponse,
  createRemoteKeyInject,
  createRemoteImeBatchEdit,
  createRemoteAppLinkLaunchRequest,
  parse,
}
