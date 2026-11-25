import type { VercelRequest, VercelResponse } from '@vercel/node'
import { waitUntil } from '@vercel/functions'
import crypto from 'crypto'
import { CONFIG } from '../lib/config'
import { CRM_MAP, FUNIS_DO_ATENDIMENTO, VENDEDORAS, ehVendedora } from '../lib/crm-map'
import { gateDoLead, processLead } from '../lib/agent'
import { appendMessage, isEchoOfSent, seenMessage } from '../lib/history'
import { addLeadNote, addLeadTags, createLeadWithContact, findOpenLeadByPhone, patchLead, sleep, type KommoLead } from '../lib/kommo'
import { numeroLiberado } from '../lib/liberados'
import { gravarInstancia, gravarLid } from '../lib/transport'
import { secretOk, textoDaMensagem } from './inbound'
import { logExec } from '../lib/execlog'

/**
 * Entrada pela uazapi (evento "messages"). Cada instância chama com ?inst=naomy|edi
 * (sem inst = "kuma": o repasse de teste do Ítalo SDR). A lista de números é conferida
 * aqui de novo (fail-closed). Mensagem enviada pelo próprio celular da vendedora
 * (fromMe, não veio da API) = ela assumiu: a Sofi sai daquele card.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'sofi-uazapi' })
  if (!secretOk(String(req.headers['x-webhook-secret'] || req.query.secret || ''))) return res.status(401).json({ error: 'unauthorized' })
  const inst = String(req.query.inst || 'kuma').toLowerCase()
  if (!CONFIG.instancias[inst]) return res.status(400).json({ error: 'instância desconhecida' })
  const m = lerEvento(req.body)
  if (!m || m.grupo || !m.tel || !m.id) return res.status(200).json({ ok: true, ignorado: true })
  if (m.deMim && m.pelaApi) return res.status(200).json({ ok: true, ignorado: 'enviada pela Sofi' })
  const daLista = await numeroLiberado(m.tel)
  if (!daLista && !CONFIG.atendeTriagem) return res.status(200).json({ ok: true, ignorado: 'número fora da lista' })
  waitUntil((m.deMim ? equipeRespondeu(m) : ingerir(m, inst, daLista)).catch(e => console.error('[uazapi]', e)))
  return res.status(200).json({ ok: true })
}

interface Recebida { id: string; tel: string; lid: string; texto: string; tipo: string; deMim: boolean; pelaApi: boolean; grupo: boolean; nome: string }

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
    lid: String(m.sender ?? '').endsWith('@lid') ? String(m.sender) : '',
    deMim: m.fromMe === true || m.fromMe === 'true',
    pelaApi: m.wasSentByApi === true || m.wasSentByApi === 'true',
    grupo,
    nome: String(m.senderName ?? m.pushName ?? ''),
  }
}

async function urlDaMidia(id: string, inst: string): Promise<string> {
  const u = CONFIG.instancias[inst]
  try {
    const r = await fetch(`${u.url}/message/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', token: u.token },
      body: JSON.stringify({ id, return_base64: false, generate_mp3: true }),
    })
    const j = await r.json() as { fileURL?: string; url?: string }
    return j.fileURL || j.url || ''
  } catch { return '' }
}

/**
 * Lead real (fora da lista): o round robin do Kommo decide. Espera o card aparecer na Triagem
 * com a tag `sofi` (3 tentativas de 6 s). Não apareceu = é do robô/vendedora: a Sofi não entra.
 */
const TENTATIVAS = 3, ESPERA_MS = 6000
async function cardDaSofi(tel: string): Promise<KommoLead | null> {
  for (let i = 0; i < TENTATIVAS; i++) {
    const lead = await findOpenLeadByPhone(tel, [CRM_MAP.pipelineId])
    if (lead && gateDoLead(lead).ok) return lead
    if (i < TENTATIVAS - 1) await sleep(ESPERA_MS)
  }
  return null
}

async function ingerir(m: Recebida, inst: string, daLista: boolean): Promise<void> {
  if (await seenMessage(`uazapi:${m.id}`)) return
  let lead = daLista ? await findOpenLeadByPhone(m.tel, FUNIS_DO_ATENDIMENTO) : await cardDaSofi(m.tel)
  if (!lead && !daLista) return
  if (!lead) {
    const id = await createLeadWithContact({
      name: `TESTE SOFI - ${m.nome || m.tel.slice(-4)}`, phone: m.tel, pipelineId: CRM_MAP.pipelineId, statusId: CRM_MAP.stages.atendendo.id,
      tags: [CONFIG.gateTag], responsibleUserId: ehVendedora(inst) ? VENDEDORAS[inst].userId : undefined,
    })
    await logExec({ ts: new Date().toISOString(), leadId: id, resultado: 'pulou', detalhe: `card de teste criado (número ${inst})`, duracaoMs: 0, tools: [] })
    lead = { id, status_id: CRM_MAP.stages.atendendo.id, pipeline_id: CRM_MAP.pipelineId }
  }
  // Já está no funil de uma vendedora: é dela, a Sofi não entra.
  if (lead.pipeline_id !== CRM_MAP.pipelineId) return
  // respondeu depois de um follow (ou do SEM RESPOSTA): o card volta para SOFI ATENDENDO
  const S = CRM_MAP.stages
  if (([S.follow1.id, S.follow2.id, S.follow3.id, S.semResposta.id] as number[]).includes(lead.status_id)) await patchLead(lead.id, { status_id: S.atendendo.id })
  await gravarInstancia(lead.id, inst)
  if (m.lid && !m.deMim) await gravarLid(lead.id, m.lid)
  const link = m.tipo ? await urlDaMidia(m.id, inst) : ''
  const texto = await textoDaMensagem(m.texto, m.tipo, link)
  if (!texto || await isEchoOfSent(lead.id, texto)) return
  await appendMessage(lead.id, { id: `uazapi:${m.id}`, dir: 'in', text: texto, ts: Date.now() })
  await processLead(lead.id, crypto.randomUUID())
}

/** A vendedora escreveu pelo celular para um cliente que a Sofi está atendendo: a Sofi sai. */
async function equipeRespondeu(m: Recebida): Promise<void> {
  if (await seenMessage(`uazapi:${m.id}`)) return
  const lead = await findOpenLeadByPhone(m.tel, [CRM_MAP.pipelineId])
  if (!lead || !gateDoLead(lead).ok) return
  if (m.texto && await isEchoOfSent(lead.id, m.texto)) return // a própria Sofi (sem a marca da API)
  await appendMessage(lead.id, { id: `uazapi:${m.id}`, dir: 'out', text: `[equipe]: ${m.texto || '(mídia)'}`, ts: Date.now() })
  await addLeadTags(lead.id, [CONFIG.humanTag])
  await addLeadNote(lead.id, '🤖 Sofi saiu: a vendedora respondeu este cliente pelo celular.')
  await logExec({ ts: new Date().toISOString(), leadId: lead.id, resultado: 'pulou', detalhe: 'a vendedora respondeu pelo celular: Sofi desligada neste card', duracaoMs: 0, tools: [] })
}
