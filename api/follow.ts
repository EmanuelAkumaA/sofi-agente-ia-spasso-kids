import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { CRM_MAP } from '../lib/crm-map'
import { gateDoLead, processLead } from '../lib/agent'
import { getHistory } from '../lib/history'
import { addLeadNote, listLeadsPorEtapa, patchLead } from '../lib/kommo'
import { dentroDoHorario } from '../lib/horario'
import { pausaGeral } from '../lib/liberados'
import { redis } from '../lib/redis'
import { aguardaKey } from '../lib/tools'
import { instrucaoDoToque, planoFollow, type EstadoFollow } from '../lib/follow'
import { logExec } from '../lib/execlog'
import { secretOk } from './inbound'

/**
 * Varredura do follow-up da Triagem (QStash a cada 20 min). Só em horário comercial.
 * Envia de verdade só com FOLLOW_SEND=1; sem isso (ou com ?dry=1) só devolve o plano.
 * FOLLOW_DESDE (ISO) congela o backlog: conversa parada antes disso não recebe follow.
 */
const S = CRM_MAP.stages
const ETAPA_DO_TOQUE: Record<number, number> = { 1: S.follow1.id, 2: S.follow2.id, 3: S.follow3.id }
const MAX_ENVIOS = 5 // por rodada: anti-spam do número e cabe no tempo da função
const ORCAMENTO_MS = 90_000
const estadoKey = (leadId: number) => `sofi:follow:${leadId}`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!secretOk(String(req.headers['x-webhook-secret'] || req.query.secret || ''))) return res.status(401).json({ error: 'unauthorized' })
  const dry = req.query.dry === '1' || process.env.FOLLOW_SEND !== '1'
  const desde = Date.parse(process.env.FOLLOW_DESDE || '')
  if (!desde) return res.status(200).json({ ok: false, erro: 'FOLLOW_DESDE não configurado' })
  if (!dentroDoHorario() && req.query.dry !== '1') return res.status(200).json({ ok: true, pulado: 'fora do horário comercial' })
  if (await pausaGeral()) return res.status(200).json({ ok: true, pulado: 'pausa geral' })

  const t0 = Date.now()
  const leads = await listLeadsPorEtapa(CRM_MAP.pipelineId, [S.entrada.id, S.atendendo.id, S.follow1.id, S.follow2.id, S.follow3.id])
  const plano: Array<Record<string, unknown>> = []
  let envios = 0

  for (const lead of leads) {
    if (Date.now() - t0 > ORCAMENTO_MS) { plano.push({ cortado: 'tempo da rodada' }); break }
    if (!gateDoLead(lead).ok) continue
    if (await redis.get(aguardaKey(lead.id))) { plano.push({ leadId: lead.id, acao: 'nada', motivo: 'esperando o currículo' }); continue }
    const estado = await redis.get<EstadoFollow>(estadoKey(lead.id))
    const p = planoFollow(await getHistory(lead.id), estado, Date.now(), desde)
    plano.push({ leadId: lead.id, ...p })
    if (dry || p.acao === 'nada') continue

    if (p.acao === 'enviar') {
      if (envios >= MAX_ENVIOS) continue
      const saiu = await processLead(lead.id, crypto.randomUUID(), 0, { instrucao: instrucaoDoToque(p.toque), semEmoji: true, modoFollow: true })
      if (!saiu) continue
      envios++
      await redis.set(estadoKey(lead.id), { ancora: p.ancora, enviados: p.toque }, { ex: 30 * 86400 })
      await patchLead(lead.id, { status_id: ETAPA_DO_TOQUE[p.toque] })
    } else {
      await patchLead(lead.id, { status_id: S.semResposta.id })
      await addLeadNote(lead.id, '🤖 Sofi: sem resposta depois dos 3 follow-ups (3 h, 24 h e 72 h). Card movido para SEM RESPOSTA.')
      await logExec({ ts: new Date().toISOString(), leadId: lead.id, resultado: 'pulou', detalhe: 'follow esgotou: SEM RESPOSTA', duracaoMs: 0, tools: [] })
      await redis.del(estadoKey(lead.id))
    }
  }
  return res.status(200).json({ ok: true, dry, leads: leads.length, envios, plano })
}
