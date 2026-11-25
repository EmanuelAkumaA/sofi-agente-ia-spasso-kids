import type { ChatMsg } from './history'

/**
 * Follow-up da Triagem (pedido do dono, 24/11/2026; doutrina da skill followup-ia-metrik):
 * 3 toques com 3 h, 24 h e 72 h de silêncio contados da âncora. Esgotou e passou FECHA_H → SEM RESPOSTA.
 */
export const REGUA_H = [3, 24, 72]
// ponytail: espera de fechamento fixa (folga de 24 h depois do último toque); vira config quando otimizar
export const FECHA_H = 96

export interface EstadoFollow { ancora: number; enviados: number }
export type Plano =
  | { acao: 'nada'; motivo: string }
  | { acao: 'enviar'; toque: number; ancora: number }
  | { acao: 'fechar'; ancora: number }

/**
 * Âncora = a 1ª fala da Sofi DEPOIS da última fala do cliente. Os toques do follow vêm depois
 * e não a deslocam (senão cada toque adiaria o próprio fechamento). null = o cliente falou por último.
 */
export function ancoraDoFollow(h: ChatMsg[]): number | null {
  let ultimaIn = -1
  for (let i = h.length - 1; i >= 0; i--) if (h[i].dir === 'in') { ultimaIn = i; break }
  if (ultimaIn < 0) return null
  const out = h.slice(ultimaIn + 1).find(m => m.dir === 'out' && !m.text.startsWith('[equipe]'))
  return out ? out.ts : null
}

/** O que fazer com o lead agora. `desde` congela o backlog: âncora anterior à ativação não recebe follow. */
export function planoFollow(h: ChatMsg[], estado: EstadoFollow | null, agora: number, desde: number): Plano {
  const ancora = ancoraDoFollow(h)
  if (!ancora) return { acao: 'nada', motivo: 'cliente falou por último ou sem conversa' }
  if (ancora < desde) return { acao: 'nada', motivo: 'backlog (antes da ativação)' }
  // Despedida ou agradecimento não pede resposta: sem pergunta pendente, não há o que cobrar (caso Elisa, 25/11/2026)
  const ultimaIn = h.map(m => m.dir).lastIndexOf('in')
  if (!h.slice(ultimaIn + 1).some(m => m.dir === 'out' && m.text.includes('?'))) return { acao: 'nada', motivo: 'sem pergunta pendente' }
  // resposta nova do cliente = âncora nova = cadência recomeça
  const enviados = estado && estado.ancora === ancora ? estado.enviados : 0
  const horas = (agora - ancora) / 3_600_000
  if (enviados >= REGUA_H.length) return horas >= FECHA_H ? { acao: 'fechar', ancora } : { acao: 'nada', motivo: 'esperando o fechamento' }
  // se vários toques venceram de uma vez, manda só o mais recente (não dispara 3 seguidos)
  let toque = -1
  for (let i = enviados; i < REGUA_H.length; i++) if (horas >= REGUA_H[i]) toque = i
  return toque < 0 ? { acao: 'nada', motivo: 'ainda não venceu' } : { acao: 'enviar', toque: toque + 1, ancora }
}

/** A ordem que a Sofi recebe para escrever cada toque. */
export function instrucaoDoToque(n: number): string {
  const comum = 'Escreva UM balão curto (1 a 2 frases), leve e simpático, que retome a última pergunta que você fez, sem pressão. '
    + 'Não se apresente de novo, não comece com "oi", não pergunte se ainda tem interesse, não use emoji e não use ferramentas.'
  if (n === 1) return `Follow-up 1 de 3: o cliente parou de responder há umas 3 horas. ${comum}`
  if (n === 2) return `Follow-up 2 de 3: o cliente está sem responder há 1 dia. Traga algo útil ligado ao que vocês estavam conversando (ex.: a visita com degustação, se for de festa). ${comum}`
  return `Follow-up 3 de 3 (o último): o cliente está sem responder há 3 dias. Deixe a porta aberta ("quando quiser retomar, é só me chamar por aqui"). ${comum}`
}
