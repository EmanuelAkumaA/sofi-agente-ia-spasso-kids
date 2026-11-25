import { CONFIG } from './config'
import { getLeadPhone, sleep, type KommoLead } from './kommo'
import { rememberSent } from './history'
import { podeAtender } from './liberados'
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
// Identificador privado do WhatsApp (@lid) de quem escreveu: a uazapi às vezes diz "not on WhatsApp" para o
// número de um contato que só aparece por @lid (bug de 25/11/2026). Aí o envio tenta de novo por ele.
const lidKey = (leadId: number) => `sofi:lid:${leadId}`
export async function gravarLid(leadId: number, lid: string): Promise<void> {
  if (lid.endsWith('@lid')) await redis.set(lidKey(leadId), lid, { ex: 90 * 86400 })
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
  if (!(await podeAtender(phone))) return { ok: false, dry: false, erro: 'número fora da lista de teste (trava de rampagem)' }
  let destino = phone
  const enviar = (number: string, text: string) => fetch(`${u.url}/send/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: u.token },
    body: JSON.stringify({ number, text, delay: Math.min(4000, 800 + text.length * 25) }),
  })
  for (const text of parts) {
    let res = await enviar(destino, text)
    let erro = res.ok ? '' : (await res.text()).slice(0, 200)
    if (!res.ok && /not on whatsapp/i.test(erro)) {
      const lid = await redis.get<string>(lidKey(lead.id)).catch(() => null)
      if (lid) {
        res = await enviar(lid, text)
        if (res.ok) destino = lid
        else erro = `${erro} | pelo @lid: ${(await res.text()).slice(0, 150)}`
      }
    }
    if (!res.ok) return { ok: false, dry: false, erro: `uazapi ${inst} ${res.status}: ${erro}` }
    await sleep(600)
  }
  return { ok: true, dry: false }
}
