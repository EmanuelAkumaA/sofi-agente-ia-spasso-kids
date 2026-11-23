import { CONFIG } from './config'
import { CRM_MAP } from './crm-map'
import { adoptToken, currentToken, debounceAndClaim, releaseLock } from './buffer'
import { appendMessage, getHistory } from './history'
import { getContactName, getLead, getLeadPhone, tagNames, type KommoLead } from './kommo'
import { podeAtender, pausaGeral } from './liberados'
import { generateReply } from './llm'
import { sendReply } from './transport'
import { logExec } from './execlog'
import { calculateExecutionCost } from './cost'

/**
 * O ciclo de uma resposta: espera a rajada → confere o gate → gera → envia → registra.
 * Gate (fail-closed): funil da Triagem + tag `sofi` + sem tag de atendimento humano.
 */
export function gateDoLead(lead: KommoLead): { ok: boolean; motivo: string } {
  const tags = tagNames(lead)
  if (lead.pipeline_id !== CRM_MAP.pipelineId) return { ok: false, motivo: 'fora do funil da Triagem' }
  if (CONFIG.gateTag && !tags.includes(CONFIG.gateTag)) return { ok: false, motivo: `sem a tag ${CONFIG.gateTag}` }
  if (tags.includes(CONFIG.humanTag)) return { ok: false, motivo: 'atendimento humano' }
  if (lead.status_id === 142 || lead.status_id === 143) return { ok: false, motivo: 'card fechado' }
  return { ok: true, motivo: 'ok' }
}

const ROTULOS: Record<number, string> = {
  [CRM_MAP.fields.tipoEvento.id]: 'Tipo de evento',
  [CRM_MAP.fields.dataFesta.id]: 'Data da festa',
  [CRM_MAP.fields.periodo.id]: 'Período',
  [CRM_MAP.fields.convidados.id]: 'Convidados',
  [CRM_MAP.fields.aniversariante.id]: 'Aniversariante',
  [CRM_MAP.fields.idade.id]: 'Idade',
  [CRM_MAP.fields.conheceEspaco.id]: 'Conhece o espaço',
  [CRM_MAP.fields.interesseVisita.id]: 'Interesse em visita',
  [CRM_MAP.fields.preferenciaVisita.id]: 'Preferência de visita',
  [CRM_MAP.fields.clienteDaCasa.id]: 'Cliente da casa',
}

export function dadosDoCard(lead: KommoLead): string {
  const out: string[] = []
  for (const f of lead.custom_fields_values || []) {
    const rot = ROTULOS[f.field_id]
    let v = f.values?.[0]?.value
    if (!rot || v === undefined || v === null || v === '') continue
    if (f.field_id === CRM_MAP.fields.dataFesta.id) v = new Date(Number(v) * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    out.push(`${rot}: ${v}`)
  }
  return out.join('; ')
}

export async function processLead(leadId: number, webhookId: string, esperaSegundos?: number): Promise<void> {
  const claim = await debounceAndClaim(leadId, webhookId, esperaSegundos)
  if (!claim.proceed) return
  const t0 = Date.now()
  try {
    for (let rodada = 0; rodada < 2; rodada++) {
      const lead = await getLead(leadId)
      const gate = gateDoLead(lead)
      if (!gate.ok) {
        await logExec({ ts: new Date().toISOString(), leadId, resultado: 'pulou', detalhe: `gate: ${gate.motivo}`, duracaoMs: Date.now() - t0, tools: [] })
        return
      }
      // Rampagem por número: com envio real ligado, só atende quem está na lista de teste.
      if (await pausaGeral()) {
        await logExec({ ts: new Date().toISOString(), leadId, resultado: 'pulou', detalhe: 'pausa geral (Central)', duracaoMs: Date.now() - t0, tools: [] })
        return
      }
      if (CONFIG.transport === 'uazapi' && !(await podeAtender(await getLeadPhone(lead)))) {
        await logExec({ ts: new Date().toISOString(), leadId, resultado: 'pulou', detalhe: 'número fora da lista de teste', duracaoMs: Date.now() - t0, tools: [] })
        return
      }
      const history = await getHistory(leadId)
      if (!history.length || history[history.length - 1].dir !== 'in') return
      const tokenAntes = await currentToken(leadId)

      const reply = await generateReply(leadId, history, { nome: await getContactName(lead), dadosDoCard: dadosDoCard(lead) })
      if (!reply) {
        await logExec({ ts: new Date().toISOString(), leadId, resultado: 'erro', detalhe: 'modelo não devolveu texto', duracaoMs: Date.now() - t0, tools: [] })
        return
      }
      // Chegou mensagem nova enquanto gerava e ela ainda não mexeu no CRM: refaz com a conversa completa.
      const tokenDepois = await currentToken(leadId)
      if (tokenDepois && tokenDepois !== tokenAntes && !reply.toolsUsed.length && rodada === 0) {
        await adoptToken(leadId, tokenDepois)
        continue
      }

      const envio = await sendReply(lead, reply.parts)
      for (const [i, p] of reply.parts.entries()) {
        await appendMessage(leadId, { id: `sofi:${Date.now()}:${i}`, dir: 'out', text: p, ts: Date.now() })
      }
      const ultimaIn = [...history].reverse().find(m => m.dir === 'in')
      await logExec({
        ts: new Date().toISOString(), leadId,
        resultado: envio.ok ? 'respondeu' : 'erro',
        detalhe: envio.ok ? (envio.dry ? 'resposta gerada (modo teste: nada enviado)' : 'enviada') : `falha no envio: ${envio.erro}`,
        duracaoMs: Date.now() - t0, tools: reply.toolsUsed,
        turnoLead: ultimaIn?.text.slice(0, 500), resposta: reply.parts,
        envio: envio.dry ? 'dry' : CONFIG.transport,
        custo: calculateExecutionCost({ usage: reply.usage }),
      })
      return
    }
  } catch (e) {
    console.error(`[agent] lead ${leadId}:`, e)
    await logExec({ ts: new Date().toISOString(), leadId, resultado: 'erro', detalhe: String((e as Error).message).slice(0, 400), duracaoMs: Date.now() - t0, tools: [] })
  } finally {
    await releaseLock(leadId, claim.lockOwner)
  }
}
