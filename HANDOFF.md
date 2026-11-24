# Sofi · agente de IA da Spasso Kids & Teens — HANDOFF

**Estado em 2026-11-23: no ar, em teste, nos números da Naomy e da Edi** (servidor `UAZAPI_SPASSO_URL`, tokens `UAZAPI_TOKEN_NAOMY`/`_EDI`).
- Webhook de cada instância → `/api/uazapi?inst=naomy|edi&secret=...` (evento `messages`, exclui `wasSentByApi` e grupos). Sem `inst` = "kuma" (repasse do Ítalo SDR, mantido).
- `TESTE_NUMEROS` = dono + pessoais da Naomy e da Edi. Fora disso, ignora.
- Lead nasce na Triagem com a vendedora do número como responsável; a instância fica em `sofi:inst:<leadId>` (Redis) e a resposta sai por ela.
- Passagem (`destinoDaPassagem` em `lib/crm-map.ts`): Qualificado → NOVO DA SOFI, Quer visita → AGENDAR VISITA, demais → EM ATENDIMENTO, no funil "Naomy" (14814284) ou "Edi" (14814288); "Não é cliente" fica na Triagem.
- Lead aberto nos funis das vendedoras conta como o mesmo atendimento: a Sofi não abre card novo.
- Mensagem `fromMe` que não veio da API = a vendedora respondeu pelo celular → tag `atendimento-humano`.
- Os dois números também estão no Coex: o lead real nasce no "Funil de vendas / CONTATO NOVO" (responsável Ediane) e o robô de menu do Kommo responde.

**Teste valendo (2026-11-23, até o dono parar):** `ATENDE_TRIAGEM=sim`. O round robin do Kommo (configurado pelo dono) manda um lead para o robô e outro para a Triagem da Sofi com a tag `sofi`. Para número fora da lista, a Sofi procura o card na Triagem com a tag em até 3 tentativas de 6 s; achou → atende; não achou → ignora (é do robô). Nunca cria card para esses números. Resumo da passagem vai **só na nota** (campo Resumo não é mais gravado). Parar: pausa geral na Central IAs Kuma ou `ATENDE_TRIAGEM` fora + redeploy.

**Ajustes do 1º lead real (2026-11-23):** etapa **CURRÍCULO** no fim dos funis Naomy (114480904) e Edi (114480908) e motivo **"Currículo / vaga"** (enum 134351013): vai para o funil da vendedora do número, sem tarefa. Saudação com o nome quando parece nome de pessoa (`saudacao()` / `primeiroNome()` em `lib/llm.ts`); `garantirSaudacao` tira o "oi"/nome repetido do balão seguinte e deixa no máximo 1 emoji. Currículo e "Não é cliente": sem prometer retorno, prazo ou orientações. Evals 19/19.

**2026-11-24:** currículo ganhou **triagem** (prompt 8.1): agradece, pergunta função/serviço e freela ou fixo, experiência, disponibilidade + bairro e pede o currículo (PDF ou foto; o arquivo fica no chat do Kommo pelo Coex). Só então passa, com o resumo em ficha na nota. Fora do horário, na passagem, avisa que a vendedora entra em contato no horário de atendimento (dia e 10h). Evals 20 cenários (novo: `curriculo-completo`).

Estado em 2026-11-20: **em teste pelo número da Kuma** (TRANSPORT=uazapi com a instância do Ítalo SDR). O SDR repassa para `/api/uazapi` só os números de `SOFI_TESTE_NUMEROS` (no SDR); a Sofi confere `TESTE_NUMEROS` na entrada, no atendimento e no envio (vazio = ninguém, `todos` = todos). Para desligar o teste: apagar `SOFI_TESTE_NUMEROS`/`SOFI_URL` no SDR e redeploy; na Sofi, `TRANSPORT=dry`.

## Onde está
- Produção: https://sofi-agente-ia-spasso-kids.vercel.app (Vercel, time kumatech4-8384s-projects, projeto `sofi-agente-ia-spasso-kids`, deploy pela CLI).
- Código: este repositório (GitHub `EmanuelAkumaA/sofi-agente-ia-spasso-kids`). Commits com autor kumatech4.
- Segredos: `.env.local` (fora do Git) e envs de produção da Vercel. Variáveis em `.env.local.example`.
- Base de conhecimento: `../CONHECIMENTO-DAS-CONVERSAS.md` e `../PLANO.md`.

## Como funciona
Webhook `add_message` do Kommo → `api/inbound.ts` → gate (funil Triagem + tag `sofi` + sem `atendimento-humano`)
→ áudio/imagem/PDF viram texto → histórico no Redis → espera 12 s (junta mensagens) → `lib/llm.ts` (OpenAI Responses,
`prompt.md`) com 2 ferramentas (`lib/tools.ts`) → envio (`lib/transport.ts`) → diário (`ak:exec`).
- `registrar_dados`: grava data, convidados, aniversariante, idade, tipo de evento, período, conhece o espaço, visita, cliente da casa.
- `passar_para_vendedora`: motivo + resumo, move a etapa, põe `atendimento-humano`, nota e tarefa para o responsável. A Sofi para.
- Mensagem "outgoing" que não é eco da Sofi (vendedora respondeu pelo celular ou Kommo) → `atendimento-humano`: a Sofi sai.

## Kommo (criado em 2026-11-20, IDs em `lib/crm-map.ts`)
Funil **Triagem Sofi (IA)**: Leads de entrada → SOFI ATENDENDO → QUALIFICADO - VENDEDORA / QUER VISITA - AGENDAR /
COM A VENDEDORA / SEM RESPOSTA / NÃO É CLIENTE. 11 campos novos + "Data da Festa" (já existia). Tags `sofi`, `atendimento-humano`.
As etapas de sistema ficaram "Incoming leads / Closed - won / Closed - lost" (a API não renomeia; trocar na tela).

## Regras do dono (2026-11-20)
Nome Sofi; abre com "Oii! Eu sou a Sofi da Spasso Kids. Como posso te ajudar?"; só diz que é assistente se perguntarem;
**não fala valores** nem tabela; não diz quem paga (criança) → vendedora explica; qualifica e/ou identifica interesse em visita
e passa para a vendedora agendar. Exceção mantida do FAQ da cliente: cashback de R$ 300 da decoração e 20 cervejas de cortesia.

## Testes
- `node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-unit.ts` (travas de lógica)
- `node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/evals.ts [filtro] [--vezes=N] [--ver]` (18 cenários, juiz) — **18/18 antes de publicar prompt**.
- Laboratório em produção: `POST /api/teste` com `x-webhook-secret` — `{acao:'criar'}`, `{acao:'falar',leadId,texto}`, `historico`, `limpar`, `diario`.
- `GET /api/validate` confere o mapa contra o Kommo vivo.
- E2E de 2026-11-20 no lead de teste 76324737 ("TESTE SOFI (Kuma) - pode apagar"): 5 respostas, 7 campos, etapa Qualificado, nota, tarefa, silêncio depois. ~R$ 0,01 a conversa.

## Pegadinhas
- O `&` em "SPASSO KIDS & TEENS" quebra `npm`/`npx`/`.cmd` no Windows: rode `node node_modules/typescript/bin/tsc`, `node node_modules/tsx/dist/cli.mjs` e a CLI da Vercel por `node <caminho>/vercel/dist/vc.js`.
- A API do Kommo não cria lead na etapa "Leads de entrada" (NotSupportedChoice): o card de teste nasce em SOFI ATENDENDO.

## Para ir ao ar (pendente)
1. Conectar o número (Coex) e uma instância uazapi no mesmo número; envs `UAZAPI_BASE_URL`, `UAZAPI_TOKEN`, `TRANSPORT=uazapi`, redeploy.
2. Fonte do número → funil Triagem; desligar os robôs de menu (boas-vindas e FONTE) nesse número.
3. Automação no Kommo: tag `sofi` em quem entra na Triagem (rampagem: 1 número de teste → 10 leads → todos).
4. Criar o webhook `add_message` apontando para `/api/inbound?secret=...` (via API).
5. Teste E2E no número do dono, depois rampagem.
Depois: follow-up (2 toques, dia seguinte), lembrete de visita, origem do lead, relatório no grupo, envio de materiais.
