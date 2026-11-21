import { CONFIG } from './config'
import { getLeadPhone, sleep, type KommoLead } from './kommo'
import { rememberSent } from './history'
import { numeroLiberado } from './liberados'

/**
 * Saída da Sofi. TRANSPORT=dry: não envia nada (testes sem número conectado).
 * TRANSPORT=uazapi: envia cada balão pela instância conectada ao número da Spasso.
 */
export interface SendResult { ok: boolean; dry: boolean; erro?: string }

export async function sendReply(lead: KommoLead, parts: string[]): Promise<SendResult> {
  for (const p of parts) await rememberSent(lead.id, p)
  if (CONFIG.transport === 'dry') return { ok: true, dry: true }
  if (!CONFIG.uazapiBaseUrl || !CONFIG.uazapiToken) return { ok: false, dry: false, erro: 'uazapi não configurada' }
  const phone = await getLeadPhone(lead)
  if (!phone) return { ok: false, dry: false, erro: 'lead sem telefone' }
  if (!(await numeroLiberado(phone))) return { ok: false, dry: false, erro: 'número fora da lista de teste (trava de rampagem)' }
  for (const text of parts) {
    const res = await fetch(`${CONFIG.uazapiBaseUrl}/send/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: CONFIG.uazapiToken },
      body: JSON.stringify({ number: phone, text, delay: Math.min(4000, 800 + text.length * 25) }),
    })
    if (!res.ok) return { ok: false, dry: false, erro: `uazapi ${res.status}: ${(await res.text()).slice(0, 200)}` }
    await sleep(600)
  }
  return { ok: true, dry: false }
}
