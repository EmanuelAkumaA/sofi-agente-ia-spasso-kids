import { CONFIG } from './config'
import { chaveTel } from './liberados'
import { redis } from './redis'

/**
 * Client da API v4 do Kommo. Retry em 429/5xx.
 * PATCH de tags SUBSTITUI o conjunto inteiro: use addLeadTags (merge local).
 */
// 🩸 20/11/2026 (Zaya): o Kommo fecha conexão parada e o fetch reaproveita uma morta: "fetch failed",
// cause.code UND_ERR_SOCKET ("other side closed"). Repete só GET e PATCH (POST de nota/tarefa duplicaria).
const CODIGOS_DE_CONEXAO = ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'EAI_AGAIN']
export function falhaDeConexao(e: unknown): boolean {
  const causa = (e as { cause?: { code?: string } })?.cause
  return e instanceof TypeError && /fetch failed/i.test(e.message) && CODIGOS_DE_CONEXAO.includes(String(causa?.code))
}
// Trava de chamadas ao Kommo (padrão Kuma desde 2026-11-28): no máximo 5 por segundo nesta conta.
// O Kommo bloqueia acima de 7/s; em 27/11/2026 uma rajada fez o Kommo bloquear o token da Sofi.
// Contador por segundo no Redis: vale para todas as funções da Vercel ao mesmo tempo. Redis fora = segue sem esperar.
const LIMITE_KOMMO_POR_SEG = Number(process.env.KOMMO_LIMITE_POR_SEG || 5)
export async function aguardarVezKommo(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const chave = `kommo:rl:${Math.floor(Date.now() / 1000)}`
    const n = await redis.incr(chave).catch(() => 0)
    if (n === 1) await redis.expire(chave, 5).catch(() => {})
    if (n <= LIMITE_KOMMO_POR_SEG) return
    await new Promise(r => setTimeout(r, 1000 - (Date.now() % 1000) + Math.floor(Math.random() * 80)))
  }
}

async function fetchKommo(url: string, init: RequestInit = {}): Promise<Response> {
  const metodo = (init.method || 'GET').toUpperCase()
  for (let i = 0; ; i++) {
    await aguardarVezKommo()
    try { return await fetch(url, init) } catch (e) {
      if (i < 2 && (metodo === 'GET' || metodo === 'PATCH') && falhaDeConexao(e)) { await new Promise(r => setTimeout(r, 500 * (i + 1))); continue }
      throw e
    }
  }
}

// 🩸 27/11/2026: rajada de chamadas → 429 → o Kommo bloqueou a API da conta (403 do nginx) e a Sofi parou.
// Freio: ao receber 403 ou 429, ninguém chama o Kommo por 15 min (Redis, vale para todas as funções da Vercel).
const FREIO = 'ak:kommo:freio', FREIO_S = 15 * 60
let freioAte = 0
export class KommoEmFreio extends Error {}
async function conferirFreio(): Promise<void> {
  if (freioAte > Date.now()) throw new KommoEmFreio('Kommo em freio (403/429 recente): chamada não feita')
  const ttl = await redis.ttl(FREIO).catch(() => -2)
  if (ttl > 0) { freioAte = Date.now() + ttl * 1000; throw new KommoEmFreio('Kommo em freio (403/429 recente): chamada não feita') }
}
/** Só para teste (scripts/test-kommo-freio.ts): solta o freio da memória desta instância. */
export function soltarFreioLocal(): void { freioAte = 0 }
async function puxarFreio(status: number, path: string): Promise<void> {
  freioAte = Date.now() + FREIO_S * 1000
  await redis.set(FREIO, JSON.stringify({ status, path, em: new Date().toISOString() }), { ex: FREIO_S, nx: true }).catch(() => {})
}

async function kommo<T>(method: string, path: string, body?: unknown, retries = 2): Promise<T> {
  await conferirFreio()
  for (let attempt = 0; ; attempt++) {
    const res = await fetchKommo(`${CONFIG.kommoDomain}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${CONFIG.kommoToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (res.ok) return (text ? JSON.parse(text) : {}) as T
    // 429: uma nova tentativa só; se repetir, freio. 403 com página do nginx = bloqueio: freio na hora.
    if (res.status === 429 && attempt < 1) { await sleep(2000); continue }
    if (res.status === 429 || (res.status === 403 && /nginx|forbidden/i.test(text))) await puxarFreio(res.status, path)
    else if (res.status >= 500 && attempt < retries) { await sleep(1000 * (attempt + 1)); continue }
    throw new Error(`Kommo ${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export interface KommoFieldValue {
  field_id: number
  values: Array<{ value?: unknown; enum_id?: number }>
}

export interface KommoLead {
  id: number
  name?: string
  status_id: number
  pipeline_id: number
  responsible_user_id?: number
  custom_fields_values?: KommoFieldValue[] | null
  _embedded?: {
    tags?: Array<{ id: number; name: string }>
    contacts?: Array<{ id: number; is_main?: boolean }>
  }
}

export async function getLead(leadId: number): Promise<KommoLead> {
  return kommo<KommoLead>('GET', `/api/v4/leads/${leadId}?with=contacts`)
}

export async function patchLead(leadId: number, patch: Record<string, unknown>): Promise<void> {
  await kommo('PATCH', `/api/v4/leads/${leadId}`, patch)
}

export function tagNames(lead: KommoLead): string[] {
  return (lead._embedded?.tags || []).map(t => t.name.toLowerCase())
}

export async function addLeadTags(leadId: number, names: string[]): Promise<void> {
  const lead = await getLead(leadId)
  const current = (lead._embedded?.tags || []).map(t => t.name)
  const lower = new Set(current.map(t => t.toLowerCase()))
  const merged = [...current, ...names.filter(n => !lower.has(n.toLowerCase()))]
  await patchLead(leadId, { _embedded: { tags: merged.map(name => ({ name })) } })
}

export async function addLeadNote(leadId: number, text: string): Promise<void> {
  await kommo('POST', `/api/v4/leads/${leadId}/notes`, [{ note_type: 'common', params: { text } }])
}

export async function createTask(p: { leadId: number; text: string; completeTill: number; responsibleUserId?: number }): Promise<void> {
  await kommo('POST', '/api/v4/tasks', [{
    task_type_id: 1, // contato
    text: p.text,
    complete_till: p.completeTill,
    entity_id: p.leadId,
    entity_type: 'leads',
    ...(p.responsibleUserId ? { responsible_user_id: p.responsibleUserId } : {}),
  }])
}

interface KommoContact {
  id: number
  name?: string
  custom_fields_values?: Array<{ field_code?: string; values: Array<{ value?: unknown }> }> | null
}

async function mainContact(lead: KommoLead): Promise<KommoContact | null> {
  const c = (lead._embedded?.contacts || []).find(x => x.is_main) || lead._embedded?.contacts?.[0]
  if (!c) return null
  try { return await kommo<KommoContact>('GET', `/api/v4/contacts/${c.id}`) } catch { return null }
}

export async function getContactName(lead: KommoLead): Promise<string | null> {
  return (await mainContact(lead))?.name || null
}

/** Telefone do contato principal, só dígitos. */
export async function getLeadPhone(lead: KommoLead): Promise<string | null> {
  const c = await mainContact(lead)
  for (const f of c?.custom_fields_values || []) {
    if (f.field_code === 'PHONE') {
      const v = String(f.values?.[0]?.value || '').replace(/\D+/g, '')
      if (v) return v
    }
  }
  return null
}

export async function getPipelines(): Promise<Array<{ id: number; name: string; statuses: Array<{ id: number; name: string }> }>> {
  const r = await kommo<{ _embedded?: { pipelines?: Array<{ id: number; name: string; _embedded?: { statuses?: Array<{ id: number; name: string }> } }> } }>('GET', '/api/v4/leads/pipelines')
  return (r._embedded?.pipelines || []).map(p => ({ id: p.id, name: p.name, statuses: p._embedded?.statuses || [] }))
}

export async function getLeadFields(): Promise<Array<{ id: number; name: string; type: string; enums?: Array<{ id: number; value: string }> }>> {
  const r = await kommo<{ _embedded?: { custom_fields?: Array<{ id: number; name: string; type: string; enums?: Array<{ id: number; value: string }> }> } }>('GET', '/api/v4/leads/custom_fields?limit=250')
  return r._embedded?.custom_fields || []
}

/** Lead aberto mais recente deste telefone nos funis indicados (confere o telefone dígito a dígito). */
export async function findOpenLeadByPhone(phone: string, pipelineIds: number[]): Promise<KommoLead | null> {
  const d = phone.replace(/\D/g, '')
  const r = await kommo<{ _embedded?: { contacts?: Array<KommoContact & { _embedded?: { leads?: Array<{ id: number }> } }> } } | ''>(
    'GET', `/api/v4/contacts?query=${encodeURIComponent(d.slice(-8))}&with=leads&limit=10`)
  const contatos = (r && typeof r === 'object' ? r._embedded?.contacts : []) || []
  const ids = contatos
    .filter(c => (c.custom_fields_values || []).filter(f => f.field_code === 'PHONE').some(f => f.values.some(v => chaveTel(String(v.value || '').replace(/\D/g, '')) === chaveTel(d))))
    .flatMap(c => (c._embedded?.leads || []).map(l => l.id))
  // 🩸 27/11/2026: era um getLead por card do contato (cliente antigo = dezenas de chamadas por mensagem).
  // Agora os cards vêm num pedido só, filtrados pelos funis pedidos.
  const leads = await leadsPorId([...new Set(ids)].sort((a, b) => b - a).slice(0, 50), pipelineIds)
  return leads.filter(l => l.status_id !== 142 && l.status_id !== 143).sort((a, b) => b.id - a.id)[0] || null
}

/** Vários leads de uma vez (até 50), só dos funis dados. */
export async function leadsPorId(ids: number[], pipelineIds: number[]): Promise<KommoLead[]> {
  if (!ids.length) return []
  // Só filter[id] (já usado e testado no Kommo); os funis são filtrados aqui. Não dá para testar outra forma com a API bloqueada.
  const filtro = ids.map(i => `filter[id][]=${i}`).join('&')
  const r = await kommo<{ _embedded?: { leads?: KommoLead[] } } | ''>('GET', `/api/v4/leads?${filtro}&with=contacts&limit=50`)
  return ((r && typeof r === 'object' ? r._embedded?.leads : []) || []).filter(l => pipelineIds.includes(l.pipeline_id))
}

/** Lead + contato com telefone, num POST só. */
export async function createLeadWithContact(p: { name: string; phone: string; pipelineId: number; statusId: number; tags: string[]; responsibleUserId?: number }): Promise<number> {
  const d = await kommo<Array<{ id: number }>>('POST', '/api/v4/leads/complex', [{
    name: p.name, pipeline_id: p.pipelineId, status_id: p.statusId,
    ...(p.responsibleUserId ? { responsible_user_id: p.responsibleUserId } : {}),
    _embedded: {
      tags: p.tags.map(name => ({ name })),
      contacts: [{ name: p.name, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: `+${p.phone}`, enum_code: 'MOB' }] }] }],
    },
  }])
  const id = d?.[0]?.id
  if (!id) throw new Error('leads/complex não devolveu id')
  return id
}

/** Cria lead de TESTE (sem contato) no funil da Sofi, já com a tag de liberação. */
export async function createTestLead(name: string, pipelineId: number, statusId: number, tags: string[]): Promise<number> {
  const d = await kommo<{ _embedded?: { leads?: Array<{ id: number }> } }>('POST', '/api/v4/leads', [{
    name, pipeline_id: pipelineId, status_id: statusId, _embedded: { tags: tags.map(name => ({ name })) },
  }])
  const id = d._embedded?.leads?.[0]?.id
  if (!id) throw new Error('criação do lead de teste não devolveu id')
  return id
}

/** Leads abertos nas etapas indicadas (até 5 páginas de 250). O Kommo responde 204 quando não há nenhum. */
export async function listLeadsPorEtapa(pipelineId: number, statusIds: number[]): Promise<KommoLead[]> {
  const filtro = statusIds.map((s, i) => `filter[statuses][${i}][pipeline_id]=${pipelineId}&filter[statuses][${i}][status_id]=${s}`).join('&')
  const out: KommoLead[] = []
  for (let page = 1; page <= 5; page++) {
    const r = await kommo<{ _embedded?: { leads?: KommoLead[] } } | ''>('GET', `/api/v4/leads?${filtro}&limit=250&page=${page}`)
    const leads = (r && typeof r === 'object' ? r._embedded?.leads : []) || []
    out.push(...leads)
    if (leads.length < 250) break
  }
  return out
}
