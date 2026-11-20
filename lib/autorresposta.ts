/**
 * QUANDO QUEM RESPONDE É O WHATSAPP BUSINESS DA CLIENTE.
 *
 * Muita cliente da Spasso tem loja, e a loja tem mensagem de ausência: a Sofi
 * escreve, o aplicativo da cliente responde sozinho "Agradecemos sua mensagem.
 * Não estamos disponíveis no momento, mas responderemos assim que possível...".
 *
 * 🩸 18/09/2026, lead 4449396: essa mensagem automática entrou no histórico
 * como fala da cliente. A Sofi respondeu a ela, consultou o catálogo e ainda
 * encaminhou o lead para uma vendedora, sem a cliente ter dito nada. Outro caso
 * do dia anterior (lead 3633748) era o mesmo mecanismo em inglês.
 *
 * Aviso automático não é conversa: não entra no histórico, não gasta token e
 * não desliga o follow-up (a cliente continua calada). O contrário importa
 * igual: só as frases típicas de ausência contam, para nunca engolir uma cliente
 * de verdade que pergunte "qual o horário de atendimento?".
 *
 * Módulo puro, sem IA e sem CRM.
 */

function normalizar(t: string): string {
  return String(t || '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cada sinal sozinho já basta: são frases que gente não escreve numa conversa. */
const SINAIS_FORTES: RegExp[] = [
  /nao estamos disponiveis (no momento|agora)/,
  /(estamos|encontramo-nos) (fora do horario|ausentes|indisponiveis)/,
  /estamos abertos agora\b/,
  /\bmensagem automatica\b/,
  /\bresposta automatica\b/,
  /\bauto-?reply\b/,
  /we (are|re) (currently )?(away|unavailable|closed|out of office)/,
  /we cannot provide you with services/,
  /(sorry|unfortunately),? we (are|re) not available/,
  /thank(s| you) for (contacting|messaging|your message)[^.]*(we will|we'll|soon|shortly|as soon)/,
]

/** Agradecimento de empresa (plural) + promessa de retorno: só junto contam. */
const AGRADECE = /agradecemos (a sua |sua |o seu |seu )?(mensagem|contato)/
const PROMETE = /(assim que possivel|em breve|no proximo dia util|horario de atendimento|horario comercial|retornaremos|responderemos|entraremos em contato)/

/** "Nosso horário de atendimento é: segunda a sexta..." (a tabela de horários da loja). */
const TABELA_DE_HORARIO = /nosso horario de (atendimento|funcionamento)( e| eh|:)/

export function ehAutorresposta(texto: string): boolean {
  const t = normalizar(texto)
  // Mensagem curta é conversa; aviso automático tem frase inteira.
  if (t.length < 25) return false
  if (SINAIS_FORTES.some(s => s.test(t))) return true
  if (AGRADECE.test(t) && PROMETE.test(t)) return true
  if (TABELA_DE_HORARIO.test(t)) return true
  return false
}
