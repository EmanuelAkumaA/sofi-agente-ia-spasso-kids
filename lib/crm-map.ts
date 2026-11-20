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
        'Pedido fora do padrão': 134350877, 'Não é cliente': 134350879,
      } as Record<string, number>,
    },
    resumo: { id: 2638349, tipo: 'textarea' },
  },
} as const

export type Motivo = keyof typeof CRM_MAP.fields.motivo.enums

/** Etapa de destino de cada motivo de passagem. */
export function etapaDoMotivo(motivo: string): number {
  const s = CRM_MAP.stages
  if (motivo === 'Qualificado') return s.qualificado.id
  if (motivo === 'Quer visita') return s.querVisita.id
  if (motivo === 'Não é cliente') return s.naoECliente.id
  return s.comVendedora.id
}
