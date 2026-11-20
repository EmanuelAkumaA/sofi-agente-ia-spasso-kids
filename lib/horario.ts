/**
 * Horário de atendimento da equipe (Brasília, sem horário de verão):
 * seg a sex 10h–18h, sáb 10h–12h, domingo fechado. Feriados ainda não contam.
 */
const OFFSET_MS = -3 * 3600_000
const ABRE = 10
const FECHA = [0, 18, 18, 18, 18, 18, 12] // domingo = 0 (fechado)
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

function local(ms: number): Date { return new Date(ms + OFFSET_MS) } // ler com getUTC*

export function dentroDoHorario(ms = Date.now()): boolean {
  const d = local(ms)
  const dia = d.getUTCDay(), h = d.getUTCHours()
  return FECHA[dia] > 0 && h >= ABRE && h < FECHA[dia]
}

/** Próxima abertura (epoch ms). Se já está aberto, devolve agora. */
export function proximaAbertura(ms = Date.now()): number {
  if (dentroDoHorario(ms)) return ms
  for (let i = 0; i < 8; i++) {
    const d = local(ms + i * 86400_000)
    const abre = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ABRE) - OFFSET_MS
    if (FECHA[d.getUTCDay()] > 0 && abre > ms) return abre
  }
  return ms + 86400_000
}

/** Prazo da tarefa da vendedora (epoch s): 1 h depois de agora ou da próxima abertura. */
export function proximoHorarioUtil(ms = Date.now()): number {
  return Math.floor((proximaAbertura(ms) + 3600_000) / 1000)
}

/** Linha de contexto para o cérebro: data, hora e se a equipe está trabalhando. */
export function linhaDeAgora(ms = Date.now()): string {
  const d = local(ms)
  const dd = String(d.getUTCDate()).padStart(2, '0'), mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0'), mi = String(d.getUTCMinutes()).padStart(2, '0')
  const base = `Agora: ${DIAS[d.getUTCDay()]}, ${dd}/${mm}/${d.getUTCFullYear()} ${hh}:${mi} (Brasília).`
  if (dentroDoHorario(ms)) return `${base} A equipe está em horário de atendimento.`
  const ab = local(proximaAbertura(ms))
  const quando = ab.getUTCDate() === d.getUTCDate() ? 'hoje' : (ab.getTime() - d.getTime() < 2 * 86400_000 && ab.getUTCDay() === (d.getUTCDay() + 1) % 7 ? 'amanhã' : DIAS[ab.getUTCDay()])
  return `${base} FORA do horário de atendimento: a equipe volta ${quando} às 10h.`
}
