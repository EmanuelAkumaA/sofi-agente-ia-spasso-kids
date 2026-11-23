import { CONFIG } from './config'
import { chaveTel } from './liberados'

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
async function fetchKommo(url: string, init: RequestInit = {}): Promise<Response> {
  const metodo = (init.method || 'GET').toUpperCase()
  for (let i = 0; ; i++) {
    try { return await fetch(url, init) } catch (e) {
      if (i < 2 && (metodo === 'GET' || metodo === 'PATCH') && falhaDeConexao(e)) { await new Promise(r => setTimeout(r, 500 * (i + 1))); continue }
      throw e
    }
  }
}

async function kommo<T>(method: string, path: string, body?: unknown, retries = 3): Promise<T> {
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
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(res.status === 429 ? 2000 * 2 ** attempt : 1000 * (attempt + 1))
      continue
    }
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
  let melhor: KommoLead | null = null
  for (const c of contatos) {
    const fones = (c.custom_fields_values || []).filter(f => f.field_code === 'PHONE').flatMap(f => f.values.map(v => String(v.value || '').replace(/\D/g, '')))
    if (!fones.some(f => chaveTel(f) === chaveTel(d))) continue
    for (const l of c._embedded?.leads || []) {
      const lead = await getLead(l.id).catch(() => null)
      if (!lead || !pipelineIds.includes(lead.pipeline_id) || lead.status_id === 142 || lead.status_id === 143) continue
      if (!melhor || lead.id > melhor.id) melhor = lead
    }
  }
  return melhor
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
