import { CONFIG } from './config'

/**
 * Ledger financeiro por execução — o que abastece o Radar de Dinheiro e o
 * Recibo de Valor da Central (CENTRAL.md).
 *
 * ⚠️ Este arquivo é PATCH, não asset. O `cost.ts` de `assets/central-v3/` é
 * Anthropic puro (`usageFromMessage(Anthropic.Message)`, `CONFIG.claudeModel`,
 * ElevenLabs, Groq). A Spasso é OpenAI ponta a ponta — cérebro na Responses API,
 * voz em TTS da OpenAI, ouvido em transcribe da OpenAI. Copiar por cima
 * quebraria tudo, então aqui está a versão adaptada.
 *
 * Preços de LLM: tabela datada de `comum/ESCOLHA-LLM.md` (USD por 1M tokens).
 * Não são chute — e podem ser sobrescritos por env sem tocar em código.
 *
 * 🩸 Registro histórico honesto: execução gravada ANTES desta instrumentação
 * fica sem `custo`. A Central deve mostrar essas como **"não medido"**, jamais
 * como R$ 0,00 — zero inventado é pior que lacuna assumida.
 */

export interface TokenUsage {
  input: number
  cached: number
  output: number
  chamadas: number
}

export interface ExecutionCost {
  moeda: 'BRL'
  usdBrl: number
  modelo: string
  tabela: string
  tokens: TokenUsage
  vozCaracteres: number
  sttSegundos: number
  llmUsd: number
  vozUsd: number
  sttUsd: number
  infraBrl: number
  totalUsd: number
  totalBrl: number
  /** true quando voz/STT foram usados mas a tarifa não está configurada. */
  parcial: boolean
}

export function emptyUsage(): TokenUsage {
  return { input: 0, cached: 0, output: 0, chamadas: 0 }
}

export function mergeUsage(a: TokenUsage, b?: TokenUsage): TokenUsage {
  if (!b) return a
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    output: a.output + b.output,
    chamadas: a.chamadas + b.chamadas,
  }
}

/**
 * Extrai o usage de uma resposta da Responses API.
 * O token cacheado vem em `input_tokens_details.cached_tokens` e JÁ ESTÁ contido
 * em `input_tokens` — por isso separamos, senão o cache seria cobrado duas vezes.
 */
export function usageFromResponse(resp: any): TokenUsage {
  const u = resp?.usage || {}
  const totalInput = Number(u.input_tokens || 0)
  const cached = Number(u.input_tokens_details?.cached_tokens || 0)
  return {
    input: Math.max(0, totalInput - cached),
    cached,
    output: Number(u.output_tokens || 0),
    chamadas: 1,
  }
}

/**
 * USD por 1M tokens, preços oficiais conferidos em 15/09/2026
 * (developers.openai.com/api/docs/pricing).
 *
 * 🩸 A tabela anterior era de antes do corte de 30/07/2026 (Terra -20%, Luna
 * -80%): mostrava o Terra 25% mais caro e a Luna 5 vezes mais cara que o real.
 */
const TABELA_LLM: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.6-sol': { input: 4.0, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2.0, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
}

export function tarifas(modelo: string) {
  // Env vence a tabela: preço muda mais rápido que deploy.
  if (CONFIG.llmInputUsdMtok > 0 || CONFIG.llmOutputUsdMtok > 0) {
    return {
      input: CONFIG.llmInputUsdMtok,
      cached: CONFIG.llmCachedUsdMtok,
      output: CONFIG.llmOutputUsdMtok,
      tabela: 'env',
    }
  }
  const chave = modelo.toLowerCase()
  const hit = TABELA_LLM[chave] || TABELA_LLM[Object.keys(TABELA_LLM).find(k => chave.startsWith(k)) || '']
  if (hit) return { ...hit, tabela: `escolha-llm:${chave}` }
  // Modelo desconhecido: NÃO chutar preço. Zero aqui vira "não medido" na Central.
  return { input: 0, cached: 0, output: 0, tabela: 'desconhecido' }
}

function round(n: number, casas = 6): number {
  return Number(n.toFixed(casas))
}

export function calculateExecutionCost(args: {
  usage?: TokenUsage
  voiceChars?: number
  sttSeconds?: number
  modelo?: string
}): ExecutionCost {
  const tokens = args.usage || emptyUsage()
  const modelo = args.modelo || CONFIG.llmModel
  const t = tarifas(modelo)

  const llmUsd =
    (tokens.input * t.input + tokens.cached * t.cached + tokens.output * t.output) / 1_000_000

  const vozCaracteres = Math.max(0, args.voiceChars || 0)
  const sttSegundos = Math.max(0, args.sttSeconds || 0)
  const vozUsd = (vozCaracteres / 1000) * CONFIG.ttsUsdKchars
  const sttUsd = (sttSegundos / 60) * CONFIG.sttUsdMinute

  // Usou o recurso mas não há tarifa configurada → o número está incompleto e
  // a Central precisa saber disso pra não apresentar um total mentiroso.
  const parcial =
    t.tabela === 'desconhecido' ||
    (vozCaracteres > 0 && CONFIG.ttsUsdKchars === 0) ||
    (sttSegundos > 0 && CONFIG.sttUsdMinute === 0)

  const totalUsd = llmUsd + vozUsd + sttUsd
  const totalBrl = totalUsd * CONFIG.usdBrl + CONFIG.infraPerExecutionBrl

  return {
    moeda: 'BRL',
    usdBrl: CONFIG.usdBrl,
    modelo,
    tabela: t.tabela,
    tokens,
    vozCaracteres,
    sttSegundos: round(sttSegundos, 2),
    llmUsd: round(llmUsd),
    vozUsd: round(vozUsd),
    sttUsd: round(sttUsd),
    infraBrl: round(CONFIG.infraPerExecutionBrl),
    totalUsd: round(totalUsd),
    totalBrl: round(totalBrl, 4),
    parcial,
  }
}
