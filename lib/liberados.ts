import { CONFIG } from './config'
import { redis } from './redis'

/** DDD + 8 últimos dígitos: tolera o 55 na frente e o 9º dígito presente ou não. */
export function chaveTel(tel: string | null | undefined): string {
  const d = String(tel || '').replace(/\D/g, '')
  const n = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
  return n.length >= 10 ? n.slice(0, 2) + n.slice(-8) : n
}

export interface Liberacao { modo: 'teste' | 'todos'; numeros: string[] }

/** Liberação gravada pela Central IAs Kuma (ak:liberacao); sem ela, vale TESTE_NUMEROS. */
let cache: { v: Liberacao; ate: number } | null = null
export async function liberacaoAtual(): Promise<Liberacao> {
  if (cache && cache.ate > Date.now()) return cache.v
  let v: Liberacao = { modo: CONFIG.atendeTodos ? 'todos' : 'teste', numeros: CONFIG.testeNumeros }
  try {
    const r = await redis.get<Liberacao | string>('ak:liberacao')
    const o = typeof r === 'string' ? JSON.parse(r) : r
    if (o && (o.modo === 'teste' || o.modo === 'todos')) v = { modo: o.modo, numeros: Array.isArray(o.numeros) ? o.numeros : [] }
  } catch { /* sem Redis: fica no TESTE_NUMEROS */ }
  cache = { v, ate: Date.now() + 30_000 }
  return v
}
export async function gravarLiberacao(v: Liberacao): Promise<void> {
  await redis.set('ak:liberacao', JSON.stringify(v))
  cache = null
}

/** Quem a Sofi pode atender agora. Fail-closed: lista vazia = ninguém; "todos" = todos. */
export async function numeroLiberado(tel: string | null | undefined): Promise<boolean> {
  return liberadoPor(await liberacaoAtual(), tel)
}
export function liberadoPor(l: Liberacao, tel: string | null | undefined): boolean {
  if (l.modo === 'todos') return true
  const k = chaveTel(tel)
  return !!k && l.numeros.some(t => chaveTel(t) === k)
}

/** Pausa geral pela Central: a Sofi não responde ninguém enquanto estiver ligada. */
export async function pausaGeral(): Promise<boolean> {
  try { return !!(await redis.get('ak:pausa:geral')) } catch { return false }
}
