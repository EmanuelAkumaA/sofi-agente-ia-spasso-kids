// Travas de lógica pura (sem IA, sem Kommo). Rodar: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-unit.ts
import assert from 'assert'
import { camposDosDados } from '../lib/tools'
import { CRM_MAP, FUNIS_DO_ATENDIMENTO, VENDEDORAS, destinoDaPassagem, ehVendedora, etapaDoMotivo } from '../lib/crm-map'
import { dentroDoHorario, linhaDeAgora, proximaAbertura } from '../lib/horario'
import { garantirSaudacao, primeiroNome, saudacao, SAUDACAO } from '../lib/llm'
import { dadosDoCard, gateDoLead } from '../lib/agent'

const F = CRM_MAP.fields
const brt = (iso: string) => Date.parse(iso + '-03:00')

// campos
const c = camposDosDados({ data_festa: '2027-01-23', convidados: 80.4, aniversariante: ' Theo ', idade: 5, periodo: 'Jantar', tipo_evento: 'Inventado' })
assert.deepStrictEqual(c.find(x => x.field_id === F.convidados.id)?.values, [{ value: 80 }])
assert.strictEqual(c.find(x => x.field_id === F.aniversariante.id)?.values[0].value, 'Theo')
assert.strictEqual(c.find(x => x.field_id === F.periodo.id)?.values[0].enum_id, 134350843)
assert.ok(!c.some(x => x.field_id === F.tipoEvento.id), 'opção inexistente não grava')
const ep = Number(c.find(x => x.field_id === F.dataFesta.id)?.values[0].value)
assert.strictEqual(new Date(ep * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }), '23/01/2027')
assert.strictEqual(camposDosDados({ data_festa: '23/01', idade: 300 }).length, 0)

// etapas
assert.strictEqual(etapaDoMotivo('Qualificado'), CRM_MAP.stages.qualificado.id)
assert.strictEqual(etapaDoMotivo('Quer visita'), CRM_MAP.stages.querVisita.id)
assert.strictEqual(etapaDoMotivo('Não é cliente'), CRM_MAP.stages.naoECliente.id)
assert.strictEqual(etapaDoMotivo('Reclamação'), CRM_MAP.stages.comVendedora.id)

// passagem: número da vendedora → funil dela
const N = VENDEDORAS.naomy, E = VENDEDORAS.edi
assert.deepStrictEqual(destinoDaPassagem('naomy', 'Qualificado'), { pipeline_id: N.pipelineId, status_id: N.etapas.novo, responsible_user_id: N.userId })
assert.deepStrictEqual(destinoDaPassagem('edi', 'Quer visita'), { pipeline_id: E.pipelineId, status_id: E.etapas.agendarVisita, responsible_user_id: E.userId })
assert.strictEqual(destinoDaPassagem('edi', 'Reclamação').status_id, E.etapas.emAtendimento)
assert.deepStrictEqual(destinoDaPassagem('edi', 'Currículo / vaga'), { pipeline_id: E.pipelineId, status_id: E.etapas.curriculo, responsible_user_id: E.userId })
assert.strictEqual(destinoDaPassagem('kuma', 'Currículo / vaga').status_id, CRM_MAP.stages.naoECliente.id)
assert.deepStrictEqual(destinoDaPassagem('naomy', 'Não é cliente'), { pipeline_id: CRM_MAP.pipelineId, status_id: CRM_MAP.stages.naoECliente.id })
assert.deepStrictEqual(destinoDaPassagem('kuma', 'Qualificado'), { pipeline_id: CRM_MAP.pipelineId, status_id: CRM_MAP.stages.qualificado.id })
assert.ok(!ehVendedora('toString'), 'nome de propriedade não vira vendedora')
assert.ok(FUNIS_DO_ATENDIMENTO.includes(N.pipelineId) && FUNIS_DO_ATENDIMENTO.includes(E.pipelineId))

// horário (sex 20/11/2026)
assert.ok(dentroDoHorario(brt('2026-11-20T10:00:00')))
assert.ok(!dentroDoHorario(brt('2026-11-20T18:00:00')))
assert.ok(!dentroDoHorario(brt('2026-11-21T12:30:00'))) // sábado depois das 12h
assert.ok(!dentroDoHorario(brt('2026-11-22T11:00:00'))) // domingo
assert.strictEqual(proximaAbertura(brt('2026-11-21T13:00:00')), brt('2026-11-23T10:00:00')) // sáb tarde → segunda
assert.ok(/volta amanhã às 10h/.test(linhaDeAgora(brt('2026-11-20T19:00:00'))))
assert.ok(/volta segunda-feira às 10h/.test(linhaDeAgora(brt('2026-11-21T15:00:00'))))

// saudação obrigatória só na primeira fala
const h0 = [{ id: '1', dir: 'in' as const, text: 'tem data 23/01?', ts: 1 }]
assert.ok(garantirSaudacao(['Vou anotar!'], h0)[0].startsWith('Oii! Eu sou a Sofi'))
assert.deepStrictEqual(garantirSaudacao([SAUDACAO], h0), [SAUDACAO])
assert.deepStrictEqual(garantirSaudacao(['Ok'], [...h0, { id: '2', dir: 'out', text: 'x', ts: 2 }]), ['Ok'])
// com nome, sem "oi" repetido no balão seguinte e no máximo 1 emoji (caso Mayara, 23/11/2026)
const mayara = garantirSaudacao(['Oi, Mayara! Obrigada pelo interesse em trabalhar com a Spasso 😊 Vou repassar.'], h0, 'Mayara')
assert.deepStrictEqual(mayara, ['Oi, Mayara! Eu sou a Sofi da Spasso Kids.', 'Obrigada pelo interesse em trabalhar com a Spasso 😊 Vou repassar.'])
assert.deepStrictEqual(garantirSaudacao(['Olá! Tem sim.'], h0, null), ['Oii! Eu sou a Sofi da Spasso Kids 😊', 'Tem sim.'])
assert.deepStrictEqual(garantirSaudacao(['Oito convidados?'], h0, 'ana')[1], 'Oito convidados?')
assert.deepStrictEqual(garantirSaudacao(['Oi, Ana! Eu sou a Sofi da Spasso Kids 😊', 'Oi Ana, tem sim.'], h0, 'Ana'), ['Oi, Ana! Eu sou a Sofi da Spasso Kids 😊', 'Tem sim.'])
assert.strictEqual(saudacao('mayara silva'), 'Oi, Mayara! Eu sou a Sofi da Spasso Kids. Como posso te ajudar?')
assert.strictEqual(saudacao('~ May 🌸'), SAUDACAO)
assert.strictEqual(primeiroNome('TESTE SOFI - 1234'), null)
assert.strictEqual(primeiroNome('5511999999999'), null)

// gate (fail-closed)
const base = { id: 1, pipeline_id: CRM_MAP.pipelineId, status_id: CRM_MAP.stages.atendendo.id, _embedded: { tags: [{ id: 1, name: 'Sofi' }] } }
assert.ok(gateDoLead(base).ok)
assert.ok(!gateDoLead({ ...base, pipeline_id: 13303247 }).ok)
assert.ok(!gateDoLead({ ...base, _embedded: { tags: [] } }).ok)
assert.ok(!gateDoLead({ ...base, _embedded: { tags: [{ id: 1, name: 'sofi' }, { id: 2, name: 'atendimento-humano' }] } }).ok)

// dados do card
assert.strictEqual(dadosDoCard({ ...base, custom_fields_values: [{ field_id: F.convidados.id, values: [{ value: 80 }] }, { field_id: 999, values: [{ value: 'x' }] }] }), 'Convidados: 80')

// liberação (lista de teste ou todos; a Central grava em ak:liberacao)
import { liberadoPor } from '../lib/liberados'
const teste = { modo: 'teste' as const, numeros: ['5511999990000'] }
assert.ok(liberadoPor(teste, '5511999990000'))
assert.ok(liberadoPor(teste, '+55 (11) 99999-0000'))
assert.ok(liberadoPor(teste, '551199990000'), 'sem o 9º dígito')
assert.ok(!liberadoPor(teste, '5511988887777'))
assert.ok(!liberadoPor(teste, ''))
assert.ok(!liberadoPor({ modo: 'teste', numeros: [] }, '5511999990000'), 'lista vazia = ninguém')
assert.ok(liberadoPor({ modo: 'todos', numeros: [] }, '5511988887777'))

console.log('test-unit: todas as travas passaram')
