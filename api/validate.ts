import type { VercelRequest, VercelResponse } from '@vercel/node'
import { secretOk } from './inbound'
import { CRM_MAP } from '../lib/crm-map'
import { getLeadFields, getPipelines } from '../lib/kommo'

/** Confere o mapa do CRM contra o Kommo vivo (IDs de funil, etapas, campos e opções). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!secretOk(String(req.headers['x-webhook-secret'] || req.query.secret || ''))) return res.status(401).json({ error: 'unauthorized' })
  const problemas: string[] = []
  const pipes = await getPipelines()
  const p = pipes.find(x => x.id === CRM_MAP.pipelineId)
  if (!p) problemas.push(`funil ${CRM_MAP.pipelineId} não existe`)
  for (const [k, s] of Object.entries(CRM_MAP.stages)) {
    if (p && !p.statuses.some(x => x.id === s.id)) problemas.push(`etapa ${k} (${s.id}) não existe`)
  }
  const fields = await getLeadFields()
  for (const [k, f] of Object.entries(CRM_MAP.fields)) {
    const vivo = fields.find(x => x.id === f.id)
    if (!vivo) { problemas.push(`campo ${k} (${f.id}) não existe`); continue }
    const enums = (f as { enums?: Record<string, number> }).enums
    for (const [nome, id] of Object.entries(enums || {})) {
      if (!vivo.enums?.some(e => e.id === id)) problemas.push(`opção "${nome}" (${id}) do campo ${k} não existe`)
    }
  }
  return res.status(problemas.length ? 500 : 200).json({ ok: !problemas.length, problemas })
}
