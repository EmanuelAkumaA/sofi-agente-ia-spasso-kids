import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { processLead } from '../lib/agent'
import { redis } from '../lib/redis'
import { aguardaKey } from '../lib/tools'
import { secretOk } from './inbound'

/**
 * Chamado pelo QStash 1 h depois de `aguardar_curriculo`. Se o prazo mais recente venceu e o card
 * ainda está com a Sofi (o currículo não chegou), ela se despede e passa para CURRÍCULO.
 * Se o currículo chegou antes, a passagem já tirou o card da Sofi e o gate faz isto não fazer nada.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  if (!secretOk(String(req.headers['x-webhook-secret'] || ''))) return res.status(401).json({ error: 'unauthorized' })
  const leadId = Number((req.body as { leadId?: unknown })?.leadId)
  if (!leadId) return res.status(400).json({ error: 'leadId' })

  const prazo = Number(await redis.get(aguardaKey(leadId)))
  if (!prazo) return res.status(200).json({ ok: true, ignorado: 'sem espera ativa' })
  if (Date.now() < prazo - 60_000) return res.status(200).json({ ok: true, ignorado: 'prazo renovado' })
  await redis.del(aguardaKey(leadId))

  await processLead(leadId, crypto.randomUUID(), 0, { garantirPassagem: true, instrucao:
    'Passou 1 hora e o currículo não chegou. Finalize agora: use passar_para_vendedora com "Currículo / vaga" '
    + '(resumo em ficha; Currículo enviado: não) e escreva só uma despedida curta, sem pergunta: os dados ficam salvos '
    + 'com a equipe e, se quiser, ainda pode mandar o currículo por aqui.' })
  return res.status(200).json({ ok: true })
}
