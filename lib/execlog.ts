import { redis } from './redis'
import type { ExecutionCost } from './cost'

/** Diário de execuções (últimas 500): quem, quando, o que fez e quanto custou. */
export interface ExecEntry {
  ts: string
  leadId: number
  resultado: 'respondeu' | 'pulou' | 'erro'
  detalhe: string
  duracaoMs: number
  tools: string[]
  turnoLead?: string
  resposta?: string[]
  envio?: string
  custo?: ExecutionCost
}

export async function logExec(e: ExecEntry): Promise<void> {
  try {
    await redis.lpush('ak:exec', JSON.stringify(e))
    await redis.ltrim('ak:exec', 0, 499)
  } catch (err) {
    console.error('[execlog] falhou (não afeta o atendimento):', err)
  }
}

export async function listExec(limit = 50): Promise<ExecEntry[]> {
  const raw = await redis.lrange<string | ExecEntry>('ak:exec', 0, limit - 1)
  return raw.map(r => (typeof r === 'string' ? JSON.parse(r) : r))
}
