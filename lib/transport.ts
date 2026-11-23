import { CONFIG } from './config'
import { getLeadPhone, sleep, type KommoLead } from './kommo'
import { rememberSent } from './history'
import { numeroLiberado } from './liberados'
import { redis } from './redis'

/**
 * Saída da Sofi. TRANSPORT=dry: não envia nada (testes sem número conectado).
 * TRANSPORT=uazapi: envia cada balão pela MESMA instância por onde o cliente chegou
 * (Naomy, Edi ou, no teste antigo, a da Kuma).
 */
export interface SendResult { ok: boolean; dry: boolean; erro?: string }

const instKey = (leadId: number) => `sofi:inst:${leadId}`
export async function gravarInstancia(leadId: number, inst: string): Promise<void> {
  await redis.set(instKey(leadId), inst, { ex: 90 * 86400 })
}
/** Por qual número o lead chegou. Sem registro = "kuma" (o teste antigo). */
export async function instanciaDoLead(leadId: number): Promise<string> {
  try { return (await redis.get<string>(instKey(leadId))) || 'kuma' } catch { return 'kuma' }
}

export async function sendReply(lead: KommoLead, parts: string[]): Promise<SendResult> {
  for (const p of parts) await rememberSent(lead.id, p)
  if (CONFIG.transport === 'dry') return { ok: true, dry: true }
  const inst = await instanciaDoLead(lead.id)
  const u = CONFIG.instancias[inst]
  if (!u?.url || !u.token) return { ok: false, dry: false, erro: `uazapi não configurada (${inst})` }
  const phone = await getLeadPhone(lead)
  if (!phone) return { ok: false, dry: false, erro: 'lead sem telefone' }
  if (!(await numeroLiberado(phone))) return { ok: false, dry: false, erro: 'número fora da lista de teste (trava de rampagem)' }
  for (const text of parts) {
    const res = await fetch(`${u.url}/send/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: u.token },
      body: JSON.stringify({ number: phone, text, delay: Math.min(4000, 800 + text.length * 25) }),
    })
    if (!res.ok) return { ok: false, dry: false, erro: `uazapi ${inst} ${res.status}: ${(await res.text()).slice(0, 200)}` }
    await sleep(600)
  }
  return { ok: true, dry: false }
}
