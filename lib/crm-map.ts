/**
 * IDs da conta Kommo da Spasso, lidos AO VIVO em 2026-11-20 (funil e campos criados
 * pela Kuma nesse dia). O /api/validate confere tudo contra o Kommo vivo.
 * Alçada da Sofi: só o funil "Triagem Sofi (IA)". Fora dele, ela não mexe.
 */
export const CRM_MAP = {
  pipelineId: 14803072,
  stages: {
    entrada: { id: 114390340, quando: 'lead acabou de chegar' },
    atendendo: { id: 114390344, quando: 'a Sofi está conversando e coletando os dados' },
    follow1: { id: 114485104, quando: 'o cliente sumiu e recebeu o follow-up 1 (3 h)' },
    follow2: { id: 114485108, quando: 'recebeu o follow-up 2 (24 h)' },
    follow3: { id: 114485112, quando: 'recebeu o follow-up 3 (72 h); sem resposta em 96 h vai para SEM RESPOSTA' },
    qualificado: { id: 114390348, quando: 'tem data + convidados + aniversariante; vai para a vendedora' },
    querVisita: { id: 114390352, quando: 'cliente quer conhecer o espaço; a vendedora agenda a visita' },
    comVendedora: { id: 114390356, quando: 'passou para a vendedora por outro motivo (preço, desconto, pós-venda, reclamação, pediu atendente...)' },
    semResposta: { id: 114390360, quando: 'parou de responder (uso futuro do follow-up)' },
    naoECliente: { id: 114390364, quando: 'fornecedor, decoradora, currículo, parceiro ou engano' },
  },
  fields: {
    dataFesta: { id: 2477298, tipo: 'date' },
    convidados: { id: 2638329, tipo: 'numeric' },
    aniversariante: { id: 2638331, tipo: 'text' },
    idade: { id: 2638333, tipo: 'numeric' },
    tipoEvento: {
      id: 2638335, tipo: 'select',
      enums: {
        'Aniversário infantil': 134350827, 'Aniversário teen': 134350829, 'Festa adulta': 134350831,
        'Formatura / festa escolar': 134350833, 'Confraternização': 134350835, 'Chá revelação / bebê': 134350837, 'Outro': 134350839,
      } as Record<string, number>,
    },
    periodo: { id: 2638337, tipo: 'select', enums: { 'Almoço': 134350841, 'Jantar': 134350843, 'A definir': 134350845 } as Record<string, number> },
    conheceEspaco: { id: 2638339, tipo: 'select', enums: { 'Sim': 134350847, 'Não': 134350849 } as Record<string, number> },
    interesseVisita: { id: 2638341, tipo: 'select', enums: { 'Quer visitar': 134350851, 'Talvez': 134350853, 'Não agora': 134350855 } as Record<string, number> },
    preferenciaVisita: { id: 2638343, tipo: 'text' },
    clienteDaCasa: { id: 2638345, tipo: 'select', enums: { 'Novo': 134350857, 'Já fez festa': 134350859 } as Record<string, number> },
    motivo: {
      id: 2638347, tipo: 'select',
      enums: {
        'Qualificado': 134350861, 'Quer visita': 134350863, 'Pediu atendente': 134350865, 'Desconto / negociação': 134350867,
        'Pós-venda': 134350869, 'Reclamação': 134350871, 'Financeiro / pagamento': 134350873, 'Assunto delicado': 134350875,
        'Pedido fora do padrão': 134350877, 'Não é cliente': 134350879, 'Currículo / vaga': 134351013,
      } as Record<string, number>,
    },
    resumo: { id: 2638349, tipo: 'textarea' },
  },
} as const

export type Motivo = keyof typeof CRM_MAP.fields.motivo.enums

/**
 * Vendedoras (funis criados em 2026-11-23). O lead que chega pelo número de uma delas
 * é passado para o funil dela, com ela de responsável.
 */
export const VENDEDORAS = {
  naomy: { nome: 'Naomy', userId: 15276460, pipelineId: 14814284, etapas: { novo: 114472440, agendarVisita: 114472444, emAtendimento: 114472448, curriculo: 114480904 } },
  edi: { nome: 'Edi', userId: 14926311, pipelineId: 14814288, etapas: { novo: 114472468, agendarVisita: 114472472, emAtendimento: 114472476, curriculo: 114480908 } },
} as const
export type Vendedora = keyof typeof VENDEDORAS
export const ehVendedora = (inst: string): inst is Vendedora => Object.prototype.hasOwnProperty.call(VENDEDORAS, inst)

/** Funis onde um lead aberto desse telefone conta como o mesmo atendimento (a Sofi não abre outro). */
export const FUNIS_DO_ATENDIMENTO: number[] = [CRM_MAP.pipelineId, ...Object.values(VENDEDORAS).map(v => v.pipelineId)]

/** Para onde vai o lead na passagem. Sem vendedora conhecida, ou "Não é cliente", fica na Triagem. */
export function destinoDaPassagem(inst: string, motivo: string): { pipeline_id: number; status_id: number; responsible_user_id?: number } {
  if (!ehVendedora(inst) || motivo === 'Não é cliente') return { pipeline_id: CRM_MAP.pipelineId, status_id: etapaDoMotivo(motivo) }
  const v = VENDEDORAS[inst]
  const status_id = motivo === 'Qualificado' ? v.etapas.novo : motivo === 'Quer visita' ? v.etapas.agendarVisita
    : motivo === 'Currículo / vaga' ? v.etapas.curriculo : v.etapas.emAtendimento
  return { pipeline_id: v.pipelineId, status_id, responsible_user_id: v.userId }
}

/** Etapa de destino de cada motivo de passagem. */
export function etapaDoMotivo(motivo: string): number {
  const s = CRM_MAP.stages
  if (motivo === 'Qualificado') return s.qualificado.id
  if (motivo === 'Quer visita') return s.querVisita.id
  if (motivo === 'Não é cliente' || motivo === 'Currículo / vaga') return s.naoECliente.id
  return s.comVendedora.id
}
