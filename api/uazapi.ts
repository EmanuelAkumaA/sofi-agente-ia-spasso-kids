import type { VercelRequest, VercelResponse } from '@vercel/node'
import { waitUntil } from '@vercel/functions'
import crypto from 'crypto'
import { CONFIG } from '../lib/config'
import { CRM_MAP } from '../lib/crm-map'
import { processLead } from '../lib/agent'
import { appendMessage, isEchoOfSent, seenMessage } from '../lib/history'
import { createLeadWithContact, findOpenLeadByPhone } from '../lib/kommo'
import { numeroLiberado } from '../lib/liberados'
import { secretOk, textoDaMensagem } from './inbound'
import { logExec } from '../lib/execlog'

/**
 * Entrada pela uazapi (evento "messages"). Em teste, chega por repasse do Ítalo SDR, que só
 * desvia para cá os números da lista de teste. Aqui a lista é conferida de novo (fail-closed).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'sofi-uazapi' })
  if (!secretOk(String(req.headers['x-webhook-secret'] || req.query.secret || ''))) return res.status(401).json({ error: 'unauthorized' })
  const m = lerEvento(req.body)
  if (!m || m.grupo || !m.tel || !m.id || m.deMim) return res.status(200).json({ ok: true, ignorado: true })
  if (!numeroLiberado(m.tel)) return res.status(200).json({ ok: true, ignorado: 'número fora da lista' })
  waitUntil(ingerir(m).catch(e => console.error('[uazapi]', e)))
  return res.status(200).json({ ok: true })
}

interface Recebida { id: string; tel: string; texto: string; tipo: string; deMim: boolean; grupo: boolean; nome: string }

function lerEvento(corpo: any): Recebida | null {
  const m = corpo?.message ?? corpo?.messages?.[0] ?? corpo
  if (!m || typeof m !== 'object') return null
  const chat = String(m.chatid ?? m.sender ?? '')
  const grupo = chat.endsWith('@g.us') || m.isGroup === true
  const conteudo = typeof m.content === 'object' && m.content ? m.content : {}
  const texto = String(m.text ?? conteudo.text ?? m.caption ?? conteudo.caption ?? (typeof m.content === 'string' ? m.content : '') ?? '').trim()
  const t = String(m.messageType ?? m.mediaType ?? m.type ?? '').toLowerCase()
  return {
    id: String(m.messageid ?? m.id ?? ''),
    tel: grupo ? '' : chat.replace(/@.*/, '').replace(/\D/g, '') || String(m.sender_pn ?? '').replace(/\D/g, ''),
    texto,
    tipo: t.includes('audio') || t.includes('ptt') ? 'voice' : t.includes('image') ? 'picture' : t.includes('document') ? 'file' : '',
    deMim: m.fromMe === true || m.fromMe === 'true',
    grupo,
    nome: String(m.senderName ?? m.pushName ?? ''),
  }
}

async function urlDaMidia(id: string): Promise<string> {
  try {
    const r = await fetch(`${CONFIG.uazapiBaseUrl}/message/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', token: CONFIG.uazapiToken },
      body: JSON.stringify({ id, return_base64: false, generate_mp3: true }),
    })
    const j = await r.json() as { fileURL?: string; url?: string }
    return j.fileURL || j.url || ''
  } catch { return '' }
}

async function ingerir(m: Recebida): Promise<void> {
  if (await seenMessage(`uazapi:${m.id}`)) return
  let lead = await findOpenLeadByPhone(m.tel, CRM_MAP.pipelineId)
  if (!lead) {
    const id = await createLeadWithContact({ name: `TESTE SOFI - ${m.nome || m.tel.slice(-4)}`, phone: m.tel, pipelineId: CRM_MAP.pipelineId, statusId: CRM_MAP.stages.atendendo.id, tags: [CONFIG.gateTag] })
    await logExec({ ts: new Date().toISOString(), leadId: id, resultado: 'pulou', detalhe: 'card de teste criado para o número liberado', duracaoMs: 0, tools: [] })
    lead = { id, status_id: CRM_MAP.stages.atendendo.id, pipeline_id: CRM_MAP.pipelineId }
  }
  const link = m.tipo ? await urlDaMidia(m.id) : ''
  const texto = await textoDaMensagem(m.texto, m.tipo, link)
  if (!texto || await isEchoOfSent(lead.id, texto)) return
  await appendMessage(lead.id, { id: `uazapi:${m.id}`, dir: 'in', text: texto, ts: Date.now() })
  await processLead(lead.id, crypto.randomUUID())
}
