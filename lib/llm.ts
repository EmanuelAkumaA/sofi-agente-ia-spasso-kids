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
}

export interface AgentReply {
  parts: string[]
  toolsUsed: string[]
  handoff: boolean
  usage: TokenUsage
}

function toInput(msgs: ChatMsg[]): Array<{ role: 'user' | 'assistant'; content: string }> {
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
  while (turns.length && turns[turns.length - 1].role !== 'user') turns.pop()
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
    '[CONTEXTO DO SISTEMA — não é fala do cliente]',
    linhaDeAgora(ctx.agoraMs),
    ctx.nome ? `Nome do contato no WhatsApp: ${ctx.nome} (use só se parecer nome de pessoa).` : 'Nome do cliente: ainda não sabemos.',
    ctx.dadosDoCard ? `Já anotado no card: ${ctx.dadosDoCard}.` : 'Nada anotado no card ainda.',
    primeiraFala
      ? `Esta é a PRIMEIRA resposta da Sofi nesta conversa (siga a regra da primeira mensagem). Saudação desta conversa: "${saudacao(ctx.nome)}"`
      : 'A Sofi já se apresentou nesta conversa.',
  ].join('\n')
}

export async function generateReply(leadId: number, history: ChatMsg[], ctx: Contexto, toolCtx: ToolCtx = {}): Promise<AgentReply | null> {
  const base = toInput(history)
  if (!base.length) return null

  // contexto ANTES da última fala do cliente: o modelo responde à fala, não ao contexto
  let input: any[] = [...base.slice(0, -1), { role: 'developer', content: montarContexto(history, ctx) }, base[base.length - 1]]
  const toolsUsed: string[] = []
  let usage = emptyUsage()
  let handoff = false
  let motivoPassagem = ''
  let previousId: string | undefined
  let lastPartial = ''

  for (let step = 0; step <= MAX_STEPS; step++) {
    const final = step === MAX_STEPS
    const params: any = {
      model: CONFIG.llmModel,
      instructions: PROMPT,
      input,
      ...(final ? {} : { tools: TOOLS.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })) }),
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
    const parts = garantirAvisoForaDoHorario(garantirSaudacao(toParts(finalText), history, ctx.nome), motivoPassagem, ctx.agoraMs)
    return { parts, toolsUsed, handoff, usage }
  }
  return null
}

/** Primeiro nome do contato, só se parecer nome de pessoa. */
export function primeiroNome(nome?: string | null): string | null {
  const w = String(nome || '').trim().split(/\s+/)[0] || ''
  if (!/^[A-Za-zÀ-ÿ]{2,20}$/.test(w) || /^(teste|sofi|spasso|cliente|buffet)$/i.test(w)) return null
  return w[0].toUpperCase() + w.slice(1).toLowerCase()
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
