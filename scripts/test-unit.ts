// Travas de lógica pura (sem IA, sem Kommo). Rodar: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-unit.ts
import assert from 'assert'
import { camposDosDados } from '../lib/tools'
import { CRM_MAP, FUNIS_DO_ATENDIMENTO, VENDEDORAS, destinoDaPassagem, ehVendedora, etapaDoMotivo } from '../lib/crm-map'
import { dentroDoHorario, linhaDeAgora, proximaAbertura } from '../lib/horario'
import { garantirAvisoForaDoHorario, garantirSaudacao, naturalizar, nomeDito, primeiroNome, prometePassar, saudacao, SAUDACAO, semEmoji } from '../lib/llm'
import { ancoraDoFollow, planoFollow } from '../lib/follow'
import { semEco } from '../lib/llm'

// sem papagaio e sem "Anotei" (casos reais de 24/11/2026)
{
  const cli = (t: string) => [{ id: 'x', dir: 'out' as const, text: 'Qual a idade?', ts: 1 }, { id: 'y', dir: 'in' as const, text: t, ts: 2 }]
  assert.deepStrictEqual(semEco(['A Liz vai fazer 7 anos 🎉', 'Você já conhece nosso espaço pessoalmente?'], cli('Liz , vai fazer 7 anos')),
    ['Você já conhece nosso espaço pessoalmente?'])
  assert.deepStrictEqual(semEco(['A festa ficou para 10/01, com aproximadamente 50 a 70 convidados, para Samuel, Miguel e Gabriel. Qual idade cada um vai fazer?'],
    cli('a festa é para 3 Samuel, Miguel e Gabriel, a data seria 10/01 e a quantidade 50 a 70 convidados')), ['Qual idade cada um vai fazer?'])
  assert.deepStrictEqual(semEco(['Anotei a data de 9 de janeiro e aproximadamente 200 convidados 😊', 'Qual é o nome e a idade do aniversariante?'], cli('9 de janeiro uns 200 convidados')),
    ['Qual é o nome e a idade do aniversariante?'])
  assert.deepStrictEqual(semEco(['Anotei para domingo, 16 de maio de 2027, para 80 convidados. Qual é o nome?'], cli('No domingo')), ['Qual é o nome?'])
  // frase com informação da Sofi fica
  const preco = 'O valor depende da data e dos convidados; a vendedora confirma a disponibilidade de 12/01/2027. Qual o nome do aniversariante?'
  assert.deepStrictEqual(semEco([preco], cli('valor para 12/01/2027, 80 convidados')), [preco])
  // sem pergunta (passagem): não mexe
  assert.deepStrictEqual(semEco(['A Liz vai fazer 7 anos 🎉'], cli('Liz , 7 anos')), ['A Liz vai fazer 7 anos 🎉'])
  assert.deepStrictEqual(semEco(['Que delícia!', 'Quantos convidados?'], cli('dia 23/01')), ['Que delícia!', 'Quantos convidados?'])
}

// follow-up da Triagem (3 h, 24 h, 72 h; fecha em 96 h)
{
  const H = 3_600_000, t = 1_000_000_000_000
  const conv = [
    { id: '1', dir: 'in' as const, text: 'quero orçamento', ts: t },
    { id: '2', dir: 'out' as const, text: 'Qual a data?', ts: t + 1000 },
    { id: '3', dir: 'out' as const, text: 'toque 1', ts: t + 4 * H },
  ]
  assert.strictEqual(ancoraDoFollow(conv), t + 1000, 'âncora = 1ª fala da Sofi depois do cliente; o toque não desloca')
  assert.strictEqual(ancoraDoFollow([...conv, { id: '4', dir: 'in' as const, text: 'oi', ts: t + 5 * H }]), null, 'cliente falou por último')
  const a = t + 1000
  assert.deepStrictEqual(planoFollow(conv, null, a + 2 * H, 0), { acao: 'nada', motivo: 'ainda não venceu' })
  assert.deepStrictEqual(planoFollow(conv, null, a + 3 * H, 0), { acao: 'enviar', toque: 1, ancora: a })
  assert.deepStrictEqual(planoFollow(conv, { ancora: a, enviados: 1 }, a + 10 * H, 0), { acao: 'nada', motivo: 'ainda não venceu' })
  assert.deepStrictEqual(planoFollow(conv, { ancora: a, enviados: 1 }, a + 24 * H, 0), { acao: 'enviar', toque: 2, ancora: a })
  assert.deepStrictEqual(planoFollow(conv, null, a + 80 * H, 0), { acao: 'enviar', toque: 3, ancora: a }, 'atrasado: manda só o mais recente')
  assert.deepStrictEqual(planoFollow(conv, { ancora: a, enviados: 3 }, a + 90 * H, 0), { acao: 'nada', motivo: 'esperando o fechamento' })
  assert.deepStrictEqual(planoFollow(conv, { ancora: a, enviados: 3 }, a + 96 * H, 0), { acao: 'fechar', ancora: a })
  assert.deepStrictEqual(planoFollow(conv, { ancora: a - 5, enviados: 3 }, a + 3 * H, 0), { acao: 'enviar', toque: 1, ancora: a }, 'âncora nova zera a cadência')
  assert.deepStrictEqual(planoFollow(conv, null, a + 3 * H, a + 1), { acao: 'nada', motivo: 'backlog (antes da ativação)' })
  assert.deepStrictEqual(semEmoji(['Fico no aguardo 😊', '🎉']), ['Fico no aguardo'])
}

// trava do Pix (24/11/2026): prometeu passar sem chamar a ferramenta
assert.ok(prometePassar('A vendedora vai te enviar os dados do pagamento. Vou passar seu atendimento para ela agora.'))
assert.ok(prometePassar('Já repassei sua mensagem para a equipe.'))
assert.ok(prometePassar('Claro, conversem com calma. A vendedora continua o atendimento por aqui.'))
assert.ok(!prometePassar('Assim que tiver a data, vou passar para a vendedora. Qual a data da festa?'))
assert.ok(!prometePassar('O valor depende da data e dos convidados, a vendedora monta a proposta. Já tem uma data em mente?'))
assert.ok(!prometePassar('Claro, fico no aguardo 😊'))
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

// nome com moderação e sem "Perfeito" (caso Maria Clara, 24/11/2026)
const mc = [{ id: 'a', dir: 'in' as const, text: 'Olá! Meu nome é Maria Clara, tenho 16 anos', ts: 1 }]
assert.strictEqual(nomeDito(mc), 'Maria Clara')
assert.strictEqual(primeiroNome('Maria Clara Pontes'), 'Maria Clara')
assert.strictEqual(primeiroNome('Maria da Silva'), 'Maria')
assert.deepStrictEqual(garantirSaudacao(['Obrigada pelo interesse em trabalhar com a Spasso, Maria Clara! Você tem experiência?'], mc, 'Maria Clara')[0], 'Oi, Maria Clara! Eu sou a Sofi da Spasso Kids 😊')
assert.deepStrictEqual(
  naturalizar(['Oi, Maria Clara! Eu sou a Sofi da Spasso Kids 😊', 'Obrigada pelo interesse em trabalhar com a Spasso, Maria Clara! Você tem experiência?'], mc, 'Maria Clara'),
  ['Oi, Maria Clara! Eu sou a Sofi da Spasso Kids 😊', 'Obrigada pelo interesse em trabalhar com a Spasso! Você tem experiência?'])
const meio = [...mc, { id: 'b', dir: 'out' as const, text: 'Você tem experiência, Maria Clara?', ts: 2 }, { id: 'c', dir: 'in' as const, text: 'tenho', ts: 3 }]
assert.deepStrictEqual(naturalizar(['Perfeito, Maria Clara! Vou anotar. Em qual bairro você mora?'], meio, 'Maria Clara'), ['Vou anotar. Em qual bairro você mora?'])
assert.deepStrictEqual(naturalizar(['Ótimo! Em qual bairro?'], meio, null), ['Em qual bairro?'])
assert.deepStrictEqual(naturalizar(['Certinho, qual bairro?'], meio, null), ['Certinho, qual bairro?'])
// nome volta a valer depois de 2 respostas sem ele (despedida)
const longe = [...meio, { id: 'd', dir: 'out' as const, text: 'Qual bairro?', ts: 4 }, { id: 'e', dir: 'out' as const, text: 'Pode mandar o currículo?', ts: 5 }]
assert.deepStrictEqual(naturalizar(['Obrigada, Maria Clara! Fica salvo.'], longe, 'Maria Clara'), ['Obrigada, Maria Clara! Fica salvo.'])

// aviso de fora do horário na passagem (sáb 21/11 15h → segunda)
const sab = brt('2026-11-21T15:00:00')
const av = garantirAvisoForaDoHorario(['Perfeito! Vou passar para a vendedora, que já chama você por aqui.'], 'Qualificado', sab)
assert.strictEqual(av.length, 2)
assert.ok(!/já chama/.test(av[0]) && /segunda-feira a partir das 10h/.test(av[1]))
assert.deepStrictEqual(garantirAvisoForaDoHorario(['Ela chama você segunda às 10h.'], 'Qualificado', sab), ['Ela chama você segunda às 10h.'])
assert.deepStrictEqual(garantirAvisoForaDoHorario(['Obrigada!'], 'Currículo / vaga', sab), ['Obrigada!'])
assert.deepStrictEqual(garantirAvisoForaDoHorario(['Ok'], 'Qualificado', brt('2026-11-20T11:00:00')), ['Ok'])
assert.deepStrictEqual(garantirAvisoForaDoHorario(['Ok'], '', sab), ['Ok'])

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
