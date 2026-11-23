import { CONFIG } from './config'
import { CRM_MAP, destinoDaPassagem } from './crm-map'
import { instanciaDoLead } from './transport'
import { addLeadNote, addLeadTags, createTask, getLead, patchLead, type KommoFieldValue } from './kommo'
import { proximoHorarioUtil } from './horario'

/**
 * As mãos da Sofi no Kommo. Duas ferramentas, alçada curta:
 *  - registrar_dados: grava o que o cliente contou nos campos do card.
 *  - passar_para_vendedora: resumo + motivo + etapa + tarefa + tag de humano (a Sofi sai).
 * Fail-closed: lead fora do funil da Triagem → não mexe.
 * dryRun (evals e laboratório): nada é gravado, só registrado.
 */

const F = CRM_MAP.fields

export const TOOLS = [
  {
    name: 'registrar_dados',
    description: 'Grava no card do Kommo o que o cliente JÁ disse sobre a festa. Chame sempre que o cliente informar um dado novo. Mande só os campos que o cliente disse; nunca invente.',
    input_schema: {
      type: 'object',
      properties: {
        tipo_evento: { type: 'string', enum: Object.keys(F.tipoEvento.enums) },
        data_festa: { type: 'string', description: 'Data da festa em AAAA-MM-DD, só se o cliente disse dia, mês e ano (deduza o ano mais próximo no futuro se ele disse só dia e mês).' },
        periodo: { type: 'string', enum: Object.keys(F.periodo.enums) },
        convidados: { type: 'number', description: 'Número aproximado de convidados.' },
        aniversariante: { type: 'string', description: 'Nome do aniversariante (ou homenageado).' },
        idade: { type: 'number', description: 'Idade que o aniversariante vai fazer.' },
        conhece_espaco: { type: 'string', enum: Object.keys(F.conheceEspaco.enums) },
        interesse_visita: { type: 'string', enum: Object.keys(F.interesseVisita.enums) },
        preferencia_visita: { type: 'string', description: 'Dia/período que o cliente prefere para visitar (texto livre, ex.: "sábado de manhã").' },
        cliente_da_casa: { type: 'string', enum: Object.keys(F.clienteDaCasa.enums) },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'passar_para_vendedora',
    description: 'Passa o atendimento para a vendedora. Use quando: o cliente está qualificado (data + convidados + aniversariante); quer visitar o espaço; pergunta preço/valores/desconto; é cliente que já fechou (pós-venda); reclamação; pagamento; pede uma pessoa; assunto delicado; pedido fora do padrão; ou não é cliente (fornecedor, decoradora, currículo). Depois desta ferramenta a Sofi para de responder este cliente.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', enum: Object.keys(F.motivo.enums) },
        resumo: { type: 'string', description: 'Resumo para a vendedora em 2 a 5 linhas: quem é, o que quer, dados da festa, o que já foi dito e o próximo passo.' },
      },
      required: ['motivo', 'resumo'],
      additionalProperties: false,
    },
  },
]

export interface ToolOutcome { content: string; isError?: boolean; handoff?: boolean }
export interface ToolCtx { dryRun?: boolean; calls?: Array<{ name: string; args: Record<string, unknown> }> }

function dataParaEpoch(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  if (!m) return null
  // meio-dia em Brasília (15h UTC): evita a data "voltar um dia" no Kommo
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], 15) / 1000)
}

const sel = (map: Record<string, number>, v: unknown) => (typeof v === 'string' && map[v] ? [{ enum_id: map[v] }] : null)

export function camposDosDados(a: Record<string, unknown>): KommoFieldValue[] {
  const out: KommoFieldValue[] = []
  const push = (field_id: number, values: KommoFieldValue['values'] | null) => { if (values) out.push({ field_id, values }) }
  push(F.tipoEvento.id, sel(F.tipoEvento.enums, a.tipo_evento))
  const ep = dataParaEpoch(String(a.data_festa || ''))
  push(F.dataFesta.id, ep ? [{ value: ep }] : null)
  push(F.periodo.id, sel(F.periodo.enums, a.periodo))
  if (Number(a.convidados) > 0) push(F.convidados.id, [{ value: Math.round(Number(a.convidados)) }])
  if (typeof a.aniversariante === 'string' && a.aniversariante.trim()) push(F.aniversariante.id, [{ value: a.aniversariante.trim().slice(0, 120) }])
  if (Number(a.idade) > 0 && Number(a.idade) < 120) push(F.idade.id, [{ value: Math.round(Number(a.idade)) }])
  push(F.conheceEspaco.id, sel(F.conheceEspaco.enums, a.conhece_espaco))
  push(F.interesseVisita.id, sel(F.interesseVisita.enums, a.interesse_visita))
  if (typeof a.preferencia_visita === 'string' && a.preferencia_visita.trim()) push(F.preferenciaVisita.id, [{ value: a.preferencia_visita.trim().slice(0, 200) }])
  push(F.clienteDaCasa.id, sel(F.clienteDaCasa.enums, a.cliente_da_casa))
  return out
}

export async function runTool(leadId: number, name: string, args: Record<string, unknown>, ctx: ToolCtx = {}): Promise<ToolOutcome> {
  ctx.calls?.push({ name, args })
  try {
    if (name === 'registrar_dados') {
      const campos = camposDosDados(args)
      if (!campos.length) return { content: 'nenhum dado válido para gravar', isError: true }
      if (ctx.dryRun) return { content: `(teste) ${campos.length} campo(s) gravado(s)` }
      const lead = await getLead(leadId)
      if (lead.pipeline_id !== CRM_MAP.pipelineId) return { content: 'lead fora do funil da Triagem: nada gravado', isError: true }
      const patch: Record<string, unknown> = { custom_fields_values: campos }
      if (lead.status_id === CRM_MAP.stages.entrada.id) patch.status_id = CRM_MAP.stages.atendendo.id
      await patchLead(leadId, patch)
      return { content: `${campos.length} campo(s) gravado(s)` }
    }

    if (name === 'passar_para_vendedora') {
      const motivo = String(args.motivo || '')
      const enumId = F.motivo.enums[motivo]
      if (!enumId) return { content: `motivo inválido: ${motivo}`, isError: true }
      const resumo = String(args.resumo || '').trim().slice(0, 1500)
      if (ctx.dryRun) return { content: `(teste) passado para a vendedora: ${motivo}`, handoff: true }
      const lead = await getLead(leadId)
      if (lead.pipeline_id !== CRM_MAP.pipelineId) return { content: 'lead fora do funil da Triagem: não movido', isError: true }
      // Chegou pelo número de uma vendedora → vai para o funil dela, com ela de responsável.
      const destino = destinoDaPassagem(await instanciaDoLead(leadId), motivo)
      await patchLead(leadId, {
        ...destino,
        // O resumo vai só na nota (decisão do dono, 2026-11-23), não no campo.
        custom_fields_values: [{ field_id: F.motivo.id, values: [{ enum_id: enumId }] }],
      })
      await addLeadTags(leadId, [CONFIG.humanTag])
      await addLeadNote(leadId, `🤖 Sofi passou para a vendedora — ${motivo}\n\n${resumo}`)
      if (motivo !== 'Não é cliente') {
        await createTask({ leadId, text: `Sofi: ${motivo}. Retomar o cliente pelo WhatsApp.`, completeTill: proximoHorarioUtil(), responsibleUserId: destino.responsible_user_id ?? lead.responsible_user_id })
      }
      return { content: `passado para a vendedora (${motivo})`, handoff: true }
    }
    return { content: `ferramenta desconhecida: ${name}`, isError: true }
  } catch (e) {
    return { content: `erro: ${(e as Error).message.slice(0, 300)}`, isError: true }
  }
}
