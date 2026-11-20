import { redis } from './redis'

/**
 * Histórico da conversa no Redis: o Kommo não devolve o transcript pela API.
 * Últimas 60 mensagens por lead, TTL de 90 dias.
 */
export interface ChatMsg {
  id: string
  dir: 'in' | 'out'
  text: string
  ts: number
}

const MAX_MSGS = 60
const TTL_S = 90 * 86400
const convKey = (leadId: number) => `ak:conv:${leadId}`

export async function appendMessage(leadId: number, msg: ChatMsg): Promise<void> {
  const key = convKey(leadId)
  await redis.rpush(key, JSON.stringify(msg))
  await redis.ltrim(key, -MAX_MSGS, -1)
  await redis.expire(key, TTL_S)
}

export async function getHistory(leadId: number): Promise<ChatMsg[]> {
  const raw = await redis.lrange<string | ChatMsg>(convKey(leadId), 0, -1)
  const out: ChatMsg[] = []
  for (const r of raw) {
    try { out.push(typeof r === 'string' ? (JSON.parse(r) as ChatMsg) : r) } catch { /* ignora corrompida */ }
  }
  return out
}

export async function clearHistory(leadId: number): Promise<void> {
  await redis.del(convKey(leadId))
}

/** true se esta mensagem já foi registrada (retry de webhook). */
export async function seenMessage(msgId: string): Promise<boolean> {
  if (!msgId) return false
  const set = await redis.set(`ak:seen:${msgId}`, '1', { nx: true, ex: 7 * 86400 })
  return set !== 'OK'
}

// Anti-eco: a resposta da Sofi enviada pela uazapi volta pelo webhook do Kommo
// como mensagem "outgoing". Guardamos o hash do que saiu para reconhecer.
function hash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return String(h)
}

export async function rememberSent(leadId: number, text: string): Promise<void> {
  await redis.sadd(`ak:sent:${leadId}`, hash(text.trim()))
  await redis.expire(`ak:sent:${leadId}`, 3600)
}

export async function isEchoOfSent(leadId: number, text: string): Promise<boolean> {
  return (await redis.sismember(`ak:sent:${leadId}`, hash(text.trim()))) === 1
}
