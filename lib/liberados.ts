import { CONFIG } from './config'

/** DDD + 8 últimos dígitos: tolera o 55 na frente e o 9º dígito presente ou não. */
export function chaveTel(tel: string | null | undefined): string {
  const d = String(tel || '').replace(/\D/g, '')
  const n = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
  return n.length >= 10 ? n.slice(0, 2) + n.slice(-8) : n
}

/** Quem a Sofi pode atender agora. Fail-closed: lista vazia = ninguém; "todos" = todos. */
export function numeroLiberado(tel: string | null | undefined): boolean {
  if (CONFIG.atendeTodos) return true
  const k = chaveTel(tel)
  return !!k && CONFIG.testeNumeros.some(t => chaveTel(t) === k)
}
