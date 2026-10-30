import type { components } from '@/contract/api'
import { plainText, record } from './snapshot'

export type Message = components['schemas']['MessageView']
export type MessagePage = components['schemas']['MessagePageView']
export type PostedMessage = components['schemas']['PostedMessage']
export type ChatEvent =
  components['schemas']['ChatPacket'] | components['schemas']['ChatDeletedPacket']
export type DeletedMessage = components['schemas']['DeletedMessageView']
export type ChatEntry = Message | DeletedMessage

export const compareIds = (left: string, right: string): number =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0

function decimal(value: unknown, zero = false): value is string {
  return (
    typeof value === 'string' &&
    (zero ? /^(0|[1-9][0-9]{0,18})$/u : /^[1-9][0-9]{0,18}$/u).test(value) &&
    BigInt(value) <= 9223372036854775807n
  )
}
const epoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const time = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= -62135596800000 &&
  value <= 253402300799999

export function isMessage(value: unknown): value is Message {
  if (
    !record(value) ||
    !decimal(value.id) ||
    !decimal(value.changeId) ||
    !time(value.createdAt) ||
    (value.deletedAt !== null && !time(value.deletedAt)) ||
    (value.kind !== 'user' && value.kind !== 'system')
  )
    return false
  if (value.kind === 'system') {
    if (value.authorId !== null || value.authorName !== null) return false
  } else if (typeof value.authorId !== 'string' || !/^[\w-]{12}$/u.test(value.authorId))
    return false
  if (value.deletedAt !== null) return value.text === null && value.authorName === null
  return (
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    plainText(value.text, 1000, 4000) &&
    (value.kind === 'system' ||
      (typeof value.authorName === 'string' &&
        value.authorName.length > 0 &&
        plainText(value.authorName, 40, 80) &&
        !/[\n\t]/u.test(value.authorName)))
  )
}

export function readMessagePage(value: unknown): MessagePage | null {
  if (
    !record(value) ||
    !epoch(value.epoch) ||
    !decimal(value.asOfCursor, true) ||
    !Array.isArray(value.messages) ||
    value.messages.length > 50 ||
    !value.messages.every(isMessage) ||
    new Set(value.messages.map((item: Message) => item.id)).size !== value.messages.length ||
    (value.nextBefore !== null && !decimal(value.nextBefore)) ||
    (value.nextAfter !== null && !decimal(value.nextAfter, true)) ||
    typeof value.hasMore !== 'boolean'
  )
    return null
  const cursor = value.asOfCursor
  if (value.messages.some((item: Message) => compareIds(item.changeId, cursor) > 0)) return null
  return {
    epoch: value.epoch,
    messages: value.messages,
    asOfCursor: cursor,
    nextBefore: value.nextBefore,
    nextAfter: value.nextAfter,
    hasMore: value.hasMore,
  }
}

export function readPostedMessage(value: unknown): PostedMessage | null {
  return record(value) &&
    epoch(value.epoch) &&
    decimal(value.asOfCursor, true) &&
    isMessage(value.message) &&
    compareIds(value.message.changeId, value.asOfCursor) <= 0
    ? { epoch: value.epoch, asOfCursor: value.asOfCursor, message: value.message }
    : null
}

function isDeleted(value: unknown): value is DeletedMessage {
  return record(value) && decimal(value.id) && decimal(value.changeId) && time(value.deletedAt)
}

export function readChatEvent(value: unknown, roundId: string): ChatEvent | null {
  if (
    !/^[\w-]{22}$/u.test(roundId) ||
    !record(value) ||
    value.roundId !== roundId ||
    !epoch(value.epoch)
  )
    return null
  if (value.topic === 'chat' && isMessage(value.message) && value.message.deletedAt === null)
    return { topic: 'chat', roundId, epoch: value.epoch, message: value.message }
  if (
    value.topic === 'chat_deleted' &&
    Array.isArray(value.deleted) &&
    value.deleted.length > 0 &&
    value.deleted.length <= 50 &&
    value.deleted.every(isDeleted) &&
    new Set(value.deleted.map((item: DeletedMessage) => item.id)).size === value.deleted.length
  )
    return { topic: 'chat_deleted', roundId, epoch: value.epoch, deleted: value.deleted }
  return null
}

export function mergeChat(entries: Map<string, ChatEntry>, incoming: readonly ChatEntry[]): number {
  let added = 0
  for (const item of incoming) {
    const previous = entries.get(item.id)
    if (previous !== undefined && compareIds(previous.changeId, item.changeId) >= 0) continue
    if (previous === undefined && item.deletedAt === null) added += 1
    entries.set(item.id, item)
  }
  return added
}

export function visibleMessages(entries: ReadonlyMap<string, ChatEntry>): Message[] {
  return [...entries.values()]
    .filter((item): item is Message => 'kind' in item && item.deletedAt === null)
    .toSorted((left, right) => compareIds(left.id, right.id))
}

export function normalizeText(text: string): string {
  // Match Python str.strip(), preserving U+FEFF.
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(
      /^[\t\n \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/gu,
      '',
    )
}
