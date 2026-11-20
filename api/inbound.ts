import type { VercelRequest, VercelResponse } from '@vercel/node'
import { waitUntil } from '@vercel/functions'
import crypto from 'crypto'
import { CONFIG } from '../lib/config'
import { gateDoLead, processLead } from '../lib/agent'
import { appendMessage, isEchoOfSent, seenMessage } from '../lib/history'
import { addLeadNote, addLeadTags, getLead } from '../lib/kommo'
import { ehAutorresposta } from '../lib/autorresposta'
import { describeDocument, describeImage } from '../lib/media'
import { transcribeUrl } from '../lib/stt'
import { logExec } from '../lib/execlog'

/**
 * Webhook add_message do Kommo (form-urlencoded: message[add][0][...]).
 * Entra a mensagem do cliente (Coex → Kommo). Mensagem "outgoing" que não é
 * eco da Sofi = alguém da equipe respondeu (celular ou Kommo): a Sofi sai.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'sofi-spasso', transport: CONFIG.transport })
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  if (!secretOk(String(req.headers['x-webhook-secret'] || req.query.secret || ''))) return res.status(401).json({ error: 'unauthorized' })

  const parsed = parseKommoWebhook(req.body)
  if (!parsed) return res.status(200).json({ ok: false, reason: 'evento não reconhecido' })
  if (parsed.accountId && parsed.accountId !== CONFIG.kommoAccountId) return res.status(200).json({ ok: false, reason: 'outra conta' })
  waitUntil(ingest(parsed.msgs))
  return res.status(200).json({ ok: true })
}

export function secretOk(provided: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(CONFIG.webhookSecret).digest()
  return crypto.timingSafeEqual(a, b)
}

interface InboundMsg { id: string; leadId: number; text: string; attachType: string; attachLink: string; direction: string }

function pick(body: Record<string, unknown>, flat: string, nested: Array<string | number>): string {
  const v = body[flat]
  if (v !== undefined && v !== null) return String(v)
  let cur: unknown = body
  for (const k of nested) {
    if (cur === null || typeof cur !== 'object') return ''
    cur = (cur as Record<string, unknown>)[String(k)]
  }
  return cur === undefined || cur === null ? '' : String(cur)
}

function parseKommoWebhook(raw: unknown): { accountId: string; msgs: InboundMsg[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const msgs: InboundMsg[] = []
  for (let i = 0; i < 10; i++) {
    const g = (k: string, path: Array<string | number>) => pick(body, `message[add][${i}]${k}`, ['message', 'add', i, ...path])
    const id = g('[id]', ['id']), entity = g('[entity_id]', ['entity_id']), text = g('[text]', ['text'])
    if (!id && !entity && !text) break
    const leadId = Number(entity)
    if (!leadId) continue
    msgs.push({
      id: id || `${leadId}:${Date.now()}:${i}`, leadId, text,
      attachType: g('[attachment][type]', ['attachment', 'type']),
      attachLink: g('[attachment][link]', ['attachment', 'link']),
      direction: g('[type]', ['type']).toLowerCase(),
    })
  }
  return msgs.length ? { accountId: pick(body, 'account[id]', ['account', 'id']), msgs } : null
}

/** Áudio, imagem e PDF viram TEXTO uma vez, na entrada. */
export async function textoDaMensagem(text: string, attachType: string, attachLink: string): Promise<string> {
  const legenda = text ? ` (legenda: ${text})` : ''
  if (attachType === 'voice' || attachType === 'audio') {
    const t = attachLink ? await transcribeUrl(attachLink) : null
    return t ? `[áudio do lead]: ${t}` : '[áudio recebido sem transcrição]'
  }
  if (attachType === 'picture') {
    const d = attachLink ? await describeImage(attachLink) : null
    return d ? `[imagem do lead]: ${d}${legenda}` : `[imagem recebida — NÃO foi possível ler o conteúdo]${legenda}`
  }
  if (attachType === 'file') {
    const d = attachLink ? await describeDocument(attachLink) : null
    return d ? `[documento do lead]: ${d}${legenda}` : `[documento recebido — NÃO foi possível ler o conteúdo]${legenda}`
  }
  return text.trim()
}

async function ingest(msgs: InboundMsg[]): Promise<void> {
  const responder = new Set<number>()
  for (const m of msgs) {
    try {
      // Gate ANTES do dedup: mensagem barrada continua recuperável num retry.
      const lead = await getLead(m.leadId)
      if (!gateDoLead(lead).ok) continue
      if (await seenMessage(`kommo:${m.id}`)) continue

      const text = await textoDaMensagem(m.text || '', m.attachType, m.attachLink)
      if (!text) continue

      if (m.direction === 'outgoing') {
        if (await isEchoOfSent(m.leadId, text)) continue // a própria Sofi
        // Alguém da equipe respondeu: registra e a Sofi sai de cena.
        await appendMessage(m.leadId, { id: `kommo:${m.id}`, dir: 'out', text: `[equipe]: ${text}`, ts: Date.now() })
        await addLeadTags(m.leadId, [CONFIG.humanTag])
        await addLeadNote(m.leadId, '🤖 Sofi saiu: alguém da equipe respondeu este cliente.')
        await logExec({ ts: new Date().toISOString(), leadId: m.leadId, resultado: 'pulou', detalhe: 'a equipe respondeu: Sofi desligada neste card', duracaoMs: 0, tools: [] })
        continue
      }
      if (ehAutorresposta(text)) continue

      await appendMessage(m.leadId, { id: `kommo:${m.id}`, dir: 'in', text, ts: Date.now() })
      responder.add(m.leadId)
    } catch (e) {
      console.error(`[inbound] msg ${m.id}:`, e)
    }
  }
  await Promise.all([...responder].map(id => processLead(id, crypto.randomUUID())))
}
