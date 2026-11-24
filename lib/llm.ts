import OpenAI from 'openai'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { CONFIG } from './config'
import type { ChatMsg } from './history'
import { TOOLS, runTool, type ToolCtx } from './tools'
import { dentroDoHorario, linhaDeAgora, quandoVolta } from './horario'
import { emptyUsage, mergeUsage, usageFromResponse, type TokenUsage } from './cost'

/**
 * Cérebro da Sofi: OpenAI Responses API (raciocínio + tools), loop com
 * previous_response_id. prompt.md vai em `instructions` (bloco fixo, cacheável);
 * o contexto do turno (hora, nome, dados do card) entra como mensagem developer.
 */

const client = new OpenAI({ apiKey: CONFIG.openaiApiKey })
export const PROMPT = fs.readFileSync(path.join(process.cwd(), 'prompt.md'), 'utf-8')
const CACHE_KEY = `sofi:${crypto.createHash('sha256').update(PROMPT).digest('hex').slice(0, 16)}`
const MAX_STEPS = 5

export const SAUDACAO = 'Oii! Eu sou a Sofi da Spasso Kids. Como posso te ajudar?' // sem nome; com nome: saudacao(nome)

export interface Contexto {
  nome?: string | null
  /** dados já gravados no card, em texto ("Data da festa: 23/01/2027; Convidados: 80") */
  dadosDoCard?: string
  agoraMs?: number
  /** ordem do sistema para este turno (não é fala do cliente) */
  instrucao?: string
  /** tira emoji da resposta (follow-up: a regra está no código, não só no prompt) */
  semEmoji?: boolean
  /** follow-up: a conversa vai até a última fala da Sofi e o modelo não tem ferramentas */
  modoFollow?: boolean
}

export interface AgentReply {
  parts: string[]
  toolsUsed: string[]
  handoff: boolean
  usage: TokenUsage
}

function toInput(msgs: ChatMsg[], manterFimDaSofi = false): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of msgs) {
    const role = m.dir === 'in' ? 'user' : 'assistant'
    const body = (m.text || '').trim()
    if (!body) continue
    const prev = turns[turns.length - 1]
    if (prev && prev.role === role) prev.content += `\n${body}`
    else turns.push({ role, content: body })
  }
  while (turns.length && turns[0].role !== 'user') turns.shift()
  if (!manterFimDaSofi) while (turns.length && turns[turns.length - 1].role !== 'user') turns.pop()
  return turns
}

function responsesText(resp: any): string {
  if (typeof resp?.output_text === 'string' && resp.output_text.trim()) return resp.output_text.trim()
  return (resp?.output || []).filter((o: any) => o.type === 'message')
    .flatMap((o: any) => (o.content || []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text))
    .join('\n').trim()
}

export function toParts(text: string): string[] {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).slice(0, 3)
}

function montarContexto(history: ChatMsg[], ctx: Contexto): string {
  const primeiraFala = !history.some(m => m.dir === 'out')
  return [
    '[CONTEXTO DO SISTEMA: não é fala do cliente]',
    linhaDeAgora(ctx.agoraMs),
    ctx.nome ? `Nome do contato no WhatsApp: ${ctx.nome} (use só se parecer nome de pessoa).` : 'Nome do cliente: ainda não sabemos.',
    ctx.dadosDoCard ? `Já anotado no card: ${ctx.dadosDoCard}.` : 'Nada anotado no card ainda.',
    primeiraFala
      ? `Esta é a PRIMEIRA resposta da Sofi nesta conversa (siga a regra da primeira mensagem). Saudação desta conversa: "${saudacao(ctx.nome)}"`
      : 'A Sofi já se apresentou nesta conversa.',
    !podeBloco(history)
      ? 'Não use o bloco de apresentação da Spasso nesta resposta (já foi enviado ou a conversa já andou): responda só o que perguntarem.'
      : `O bloco de apresentação da Spasso ainda NÃO foi enviado: se já está claro que é cliente de festa, coloque ${MARCA_BLOCO} sozinho num balão logo depois da apresentação (seção 2).`,
    ...(ctx.instrucao ? [`ORDEM DO SISTEMA PARA ESTA RESPOSTA: ${ctx.instrucao}`] : []),
  ].join('\n')
}

export async function generateReply(leadId: number, history: ChatMsg[], ctx: Contexto, toolCtx: ToolCtx = {}): Promise<AgentReply | null> {
  const base = toInput(history, !!ctx.modoFollow)
  if (!base.length) return null
  // contato sem nome no Kommo: usa o nome que o cliente disse na conversa
  if (!primeiroNome(ctx.nome)) ctx = { ...ctx, nome: nomeDito(history) || ctx.nome }

  // contexto ANTES da última fala do cliente: o modelo responde à fala, não ao contexto.
  // No follow, a conversa termina na Sofi e a ordem do sistema vem por último.
  let input: any[] = ctx.modoFollow
    ? [...base, { role: 'developer', content: montarContexto(history, ctx) }]
    : [...base.slice(0, -1), { role: 'developer', content: montarContexto(history, ctx) }, base[base.length - 1]]
  const toolsUsed: string[] = []
  let usage = emptyUsage()
  let handoff = false
  let motivoPassagem = ''
  let cobrouPassagem = false
  let previousId: string | undefined
  let lastPartial = ''

  for (let step = 0; step <= MAX_STEPS; step++) {
    const final = step === MAX_STEPS
    const params: any = {
      model: CONFIG.llmModel,
      instructions: PROMPT,
      input,
      ...(final || ctx.modoFollow ? {} : { tools: TOOLS.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })) }),
      reasoning: { effort: CONFIG.llmEffort },
      max_output_tokens: 3000,
      prompt_cache_key: CACHE_KEY,
      ...(previousId ? { previous_response_id: previousId } : {}),
    }
    const resp: any = await client.responses.create(params)
    previousId = resp.id
    usage = mergeUsage(usage, usageFromResponse(resp))
    const text = responsesText(resp)
    if (text) lastPartial = text
    const calls = (resp.output || []).filter((o: any) => o.type === 'function_call')

    if (calls.length && !final) {
      const next: any[] = []
      for (const call of calls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.arguments || '{}') } catch { /* runTool devolve erro útil */ }
        toolsUsed.push(call.name)
        const out = await runTool(leadId, call.name, args, toolCtx)
        if (out.handoff) { handoff = true; motivoPassagem = String(args.motivo || '') }
        if (out.isError) console.error(`[tool:${call.name}] lead ${leadId}: ${out.content}`)
        next.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ ok: !out.isError, resultado: out.content }) })
      }
      input = next
      continue
    }
    const finalText = text || lastPartial
    if (!finalText) {
      if (final) return null
      input = [{ role: 'developer', content: 'Escreva agora a resposta para o cliente.' }]
      continue
    }
    // Trava (24/11/2026): disse que passa para a vendedora mas não chamou a ferramenta → o card ficaria parado.
    if (!final && !ctx.modoFollow && !cobrouPassagem && !handoff && !toolsUsed.includes('aguardar_curriculo') && prometePassar(finalText)) {
      cobrouPassagem = true
      input = [{ role: 'developer', content: 'Sua resposta diz que vai passar o atendimento, mas você NÃO chamou passar_para_vendedora. Se for mesmo passar, chame agora com o motivo certo e depois escreva a mensagem final. Se não for passar, reescreva a resposta sem dizer que vai passar.' }]
      continue
    }
    const comSaudacao = semEco(garantirSaudacao(toParts(finalText), history, ctx.nome), history)
    let parts = garantirAvisoForaDoHorario(naturalizar(comSaudacao, history, ctx.nome), motivoPassagem, ctx.agoraMs)
    if (ctx.semEmoji) parts = semEmoji(parts)
    parts = aplicarBloco(semTravessao(parts), history) // por último: as travas acima não mexem no texto fixo
    return { parts, toolsUsed, handoff, usage }
  }
  return null
}

const cap = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase()
// ponytail: lista curta de nomes que quase sempre vêm compostos; ampliar se aparecer outro
const COMPOSTOS = /^(maria|ana|jo[ãa]o|pedro|lu[ií]s|luiz|jos[ée]|carlos|paulo)$/i

/**
 * A resposta promete passar o atendimento agora? Só conta resposta SEM pergunta: com pergunta,
 * a conversa continua ("assim que tiver a data, passo para a vendedora. Qual a data?").
 */
export function prometePassar(texto: string): boolean {
  if (texto.includes('?')) return false
  return /(?:vou|já vou|vamos)\s+(?:te\s+)?(?:passar|repassar|encaminhar|transferir)|(?:passei|repassei|encaminhei|transferi)\s|a vendedora (?:já\s+)?(?:continua|segue|assume)/i.test(texto)
}

/** Primeiro nome do contato (ou "Maria Clara", "Ana Julia"), só se parecer nome de pessoa. */
export function primeiroNome(nome?: string | null): string | null {
  const ws = String(nome || '').trim().split(/\s+/)
  const w = ws[0] || ''
  if (!/^[A-Za-zÀ-ÿ]{2,20}$/.test(w) || /^(teste|sofi|spasso|cliente|buffet)$/i.test(w)) return null
  if (COMPOSTOS.test(w) && /^[A-Za-zÀ-ÿ]{2,20}$/.test(ws[1] || '') && !/^(d[aeo]s?|e)$/i.test(ws[1])) return `${cap(w)} ${cap(ws[1])}`
  return cap(w)
}

/** Nome que o cliente disse na conversa ("meu nome é Maria Clara", "me chamo Ana"). */
export function nomeDito(history: ChatMsg[]): string | null {
  for (const m of history) {
    if (m.dir !== 'in') continue
    const r = /(?:meu nome [ée]|me chamo)\s+([A-ZÀ-Ýa-zà-ÿ]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ]+)?)/i.exec(m.text)
    if (r && primeiroNome(r[1])) return r[1]
  }
  return null
}

const ABERTURA_PRONTA = /^(?:perfeito|[óo]timo|excelente|maravilha|show|certo|entendi|combinado)(?![a-zà-ÿ])\s*[,!.]?\s*/i
function tirarVocativo(p: string, n: string): string {
  const e = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return p.replace(new RegExp(`,\\s*${e}(?=\\s*[!?.,])`, 'g'), '').replace(new RegExp(`^${e}\\s*[,!]\\s*`), '')
}

/**
 * Conversa natural (pedido do dono, 24/11/2026): sem "Perfeito/Ótimo..." abrindo balão e
 * sem o nome do cliente se ele já apareceu nesta resposta ou nas 2 últimas da Sofi.
 */
export function naturalizar(parts: string[], history: ChatMsg[], nome?: string | null): string[] {
  const n = primeiroNome(nome)
  let usado = !!n && history.filter(m => m.dir === 'out' && !m.text.startsWith('[equipe]')).slice(-2).some(m => m.text.includes(n))
  const out: string[] = []
  for (const original of parts) {
    let p = n && usado ? tirarVocativo(original, n) : original
    p = p.replace(ABERTURA_PRONTA, '')
    p = p ? p[0].toUpperCase() + p.slice(1) : p
    if (n && p.includes(n)) usado = true
    if (p.trim()) out.push(p)
  }
  return out.length ? out : parts
}

/** Saudação da primeira fala: com o nome quando tiver (regra do dono, 23/11/2026). */
export function saudacao(nome?: string | null): string {
  const n = primeiroNome(nome)
  return `${n ? `Oi, ${n}!` : 'Oii!'} Eu sou a Sofi da Spasso Kids. Como posso te ajudar?`
}

const EMOJI = /\p{Extended_Pictographic}/u
// "Oi, Mayara! ", "Olá! ", "Oii, tudo bem? " no começo do balão: o oi já foi dito na apresentação.
const OI_NO_COMECO = /^(?:[Oo]i+e?|[Oo]l[áa])(?![a-zà-ÿ])\s*[,!.]?\s*(?:[A-ZÀ-Ý][a-zà-ÿ]+\s*[,!.]\s*)?/
function semOi(p: string): string {
  const s = p.replace(OI_NO_COMECO, '')
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/**
 * Na primeira fala, a apresentação da Sofi é obrigatória (regra do dono, 20/11/2026).
 * Sem "oi" repetido depois dela e no máximo 1 emoji na resposta.
 */
export function garantirSaudacao(parts: string[], history: ChatMsg[], nome?: string | null): string[] {
  if (history.some(m => m.dir === 'out') || !parts.length) return parts
  const i = parts.findIndex(p => /sou a sofi/i.test(p))
  if (i >= 0) return parts.map((p, j) => (j > i ? semOi(p) : p)).filter(Boolean)
  const resto = parts.map(semOi).filter(Boolean)
  const n = primeiroNome(nome)
  const apresentacao = `${n ? `Oi, ${n}!` : 'Oii!'} Eu sou a Sofi da Spasso Kids${EMOJI.test(resto.join(' ')) ? '.' : ' 😊'}`
  return [apresentacao, ...resto].slice(0, 3)
}

/**
 * Fora do horário, a passagem para a vendedora sempre avisa quando ela entra em contato
 * (pedido do dono, 24/11/2026). Currículo e "Não é cliente" não ganham prazo.
 */
export function garantirAvisoForaDoHorario(parts: string[], motivo: string, ms = Date.now()): string[] {
  if (!motivo || motivo === 'Currículo / vaga' || motivo === 'Não é cliente' || dentroDoHorario(ms) || !parts.length) return parts
  const q = quandoVolta(ms)
  // "já chama você" contradiz o aviso: tira o "já"
  const out = parts.map(p => p.replace(/(?<![a-zà-ÿ])j[áa] (?=(?:te |você |vc )?(?:chama|entra|fala|retorna))/gi, ''))
  const texto = out.join(' ')
  if (new RegExp(q.split('-')[0], 'i').test(texto) && /10\s?h/i.test(texto)) return out
  const aviso = `Como estamos fora do horário de atendimento, a vendedora entra em contato com você ${q} a partir das 10h, aqui mesmo no WhatsApp.`
  return out.length < 3 ? [...out, aviso] : [...out.slice(0, -1), `${out[out.length - 1]} ${aviso}`]
}

/** Tira emoji (e as "colas" de emoji composto); balão que ficar vazio sai. */
export function semEmoji(parts: string[]): string[] {
  const out = parts.map(p => p.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/ {2,}/g, ' ').replace(/ ([.,!?])/g, '$1').trim()).filter(Boolean)
  return out.length ? out : parts
}

// "Anotei a data...", "Vou anotar...", "Registrei..." no começo do balão: narra o que ela faz por dentro.
const NARRA = /^(?:vou anotar|anotei|anotado|registrei|deixei anotado)(?![a-zà-ÿ])[^.!?\n]*[.!]?\s*/i
const PARADA = new Set(['Sim', 'Não', 'Nao', 'Oi', 'Oie', 'Olá', 'Ola', 'Bom', 'Boa', 'Para', 'Pode', 'Ainda', 'Isso', 'Tudo', 'Dia',
  'Meu', 'Minha', 'Gostaria', 'Queria', 'Quero', 'Sou', 'Tenho', 'Obrigada', 'Obrigado', 'Então', 'Entao', 'Por', 'Vocês', 'Voces', 'Ele', 'Ela', 'Festa'])
// frase com isto tem informação nova da Sofi, não é eco
const TEM_CONTEUDO = /vendedora|valor|or[çc]amento|disponib|visita|degusta|cashback|cerveja|hor[áa]rio/i

/** Números e nomes que o cliente acabou de mandar (as mensagens dele depois da última fala da Sofi). */
function dadosDoCliente(h: ChatMsg[]): Set<string> {
  const t = new Set<string>()
  for (let i = h.length - 1; i >= 0 && h[i].dir === 'in'; i--) {
    for (const n of h[i].text.match(/\d+/g) || []) t.add(n)
    for (const w of h[i].text.match(/[A-ZÀ-Ý][a-zà-ÿ]{2,}/g) || []) if (!PARADA.has(w)) t.add(w)
  }
  return t
}

/**
 * Sem papagaio (pedido do dono, 24/11/2026): tira "Anotei..." do começo do balão e a frase sem pergunta que só
 * devolve 2+ dados que o cliente acabou de dar ("A Liz vai fazer 7 anos 🎉"). Só mexe se a resposta tem pergunta
 * (a conversa segue) e nunca na apresentação.
 * ponytail: heurística por número/nome repetido; se cortar frase boa, afinar TEM_CONTEUDO ou PARADA.
 */
export function semEco(parts: string[], history: ChatMsg[]): string[] {
  if (!parts.some(p => p.includes('?'))) return parts
  const dados = dadosDoCliente(history)
  const eco = (f: string) => !f.includes('?') && f.length < 160 && !TEM_CONTEUDO.test(f)
    && [...(f.match(/\d+/g) || []), ...(f.match(/[A-ZÀ-Ý][a-zà-ÿ]{2,}/g) || [])].filter(x => dados.has(x)).length >= 2
  const out = parts.map(p => {
    if (/sou a sofi/i.test(p)) return p
    const frases = p.replace(NARRA, '').match(/[^.!?]+[.!?]*\s*/g) || []
    const s = frases.filter(f => !eco(f)).join('').trim()
    return s ? s[0].toUpperCase() + s.slice(1) : s
  }).filter(Boolean)
  return out.some(p => p.includes('?')) ? out : parts
}

/**
 * Bloco de apresentação da Spasso (pedido da cliente, opção A escolhida pelo dono em 24/11/2026).
 * Texto FIXO: o modelo só decide QUANDO (marca no balão), o código põe o texto, sempre igual.
 */
export const MARCA_BLOCO = '[[APRESENTACAO]]'
export const BLOCO_SPASSO = 'Pra você já conhecer um pouquinho: nosso espaço no Tatuapé tem 1.300 m² e pé-direito de 10 m, '
  + 'com brinquedos para crianças e adultos e um finger food de apaixonar. A festa dura 4 horas (mais 30 min de tolerância), '
  + 'recebe de 50 a 350 convidados, e crianças até 5 anos são cortesia.'

export function blocoJaEnviado(history: ChatMsg[]): boolean {
  return history.some(m => m.dir === 'out' && m.text.startsWith('Pra você já conhecer um pouquinho'))
}

/** O bloco só entra no começo: ainda não foi e a Sofi mandou no máximo a saudação. */
export function podeBloco(history: ChatMsg[]): boolean {
  return !blocoJaEnviado(history) && history.filter(m => m.dir === 'out').length <= 1
}

/** Troca a marca pelo bloco (uma vez por conversa); marca fora de hora some. */
export function aplicarBloco(parts: string[], history: ChatMsg[]): string[] {
  let usado = !podeBloco(history)
  const out: string[] = []
  for (const p of parts) {
    if (!p.includes(MARCA_BLOCO)) { out.push(p); continue }
    const resto = p.split(MARCA_BLOCO).join('').trim()
    if (!usado) { out.push(BLOCO_SPASSO); usado = true }
    if (resto) out.push(resto)
  }
  return out
}

/** Sem travessão (pedido do dono, 24/11/2026): "—" e "–" viram vírgula. Hífen normal fica. */
export function semTravessao(parts: string[]): string[] {
  return parts.map(p => p.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*([,.!?])/g, '$1').replace(/^,\s*/, ''))
}
