import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { secretOk, textoDaMensagem } from './inbound'
import { processLead } from '../lib/agent'
import { appendMessage, clearHistory, getHistory } from '../lib/history'
import { createTestLead } from '../lib/kommo'
import { CRM_MAP } from '../lib/crm-map'
import { CONFIG } from '../lib/config'
import { listExec } from '../lib/execlog'

/**
 * Laboratório sem número conectado (protegido pelo WEBHOOK_SECRET).
 *  POST {acao:'criar'}                       → cria um lead de TESTE no funil da Triagem, com a tag sofi
 *  POST {acao:'falar', leadId, texto}        → o "cliente" fala; a Sofi responde de verdade (grava no Kommo)
 *  POST {acao:'historico', leadId} | {acao:'limpar', leadId} | {acao:'diario'}
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' })
  if (!secretOk(String(req.headers['x-webhook-secret'] || req.query.secret || ''))) return res.status(401).json({ error: 'unauthorized' })
  const b = (req.body || {}) as { acao?: string; leadId?: number; texto?: string; nome?: string }
  const leadId = Number(b.leadId)

  if (b.acao === 'criar') {
    const id = await createTestLead(b.nome || 'TESTE SOFI (Kuma)', CRM_MAP.pipelineId, CRM_MAP.stages.atendendo.id, [CONFIG.gateTag]) // a API não cria na etapa de entrada
    return res.status(200).json({ ok: true, leadId: id })
  }
  if (!leadId && b.acao !== 'diario') return res.status(400).json({ error: 'leadId obrigatório' })
  if (b.acao === 'falar') {
    const texto = await textoDaMensagem(String(b.texto || ''), '', '')
    if (!texto) return res.status(400).json({ error: 'texto vazio' })
    await appendMessage(leadId, { id: `teste:${crypto.randomUUID()}`, dir: 'in', text: texto, ts: Date.now() })
    await processLead(leadId, crypto.randomUUID(), 0)
    const ultima = (await listExec(5)).find(e => e.leadId === leadId)
    return res.status(200).json({ ok: true, execucao: ultima })
  }
  if (b.acao === 'historico') return res.status(200).json({ ok: true, historico: await getHistory(leadId) })
  if (b.acao === 'limpar') { await clearHistory(leadId); return res.status(200).json({ ok: true }) }
  if (b.acao === 'diario') return res.status(200).json({ ok: true, diario: await listExec(30) })
  return res.status(400).json({ error: 'acao desconhecida' })
}
