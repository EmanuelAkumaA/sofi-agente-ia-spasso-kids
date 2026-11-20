function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Env var obrigatória ausente: ${name}`)
  return v
}

/**
 * Sofi (Spasso Kids & Teens). Entrada pelo webhook add_message do Kommo (Coex);
 * saída pela uazapi quando o número estiver conectado. Até lá TRANSPORT=dry:
 * a resposta é gerada, gravada no histórico e no diário, e NADA é enviado.
 */
export const CONFIG = {
  kommoDomain: required('KOMMO_DOMAIN').replace(/\/+$/, ''),
  kommoToken: required('KOMMO_TOKEN'),
  kommoAccountId: required('KOMMO_ACCOUNT_ID'),

  transport: (process.env.TRANSPORT || 'dry') as 'dry' | 'uazapi',
  uazapiBaseUrl: (process.env.UAZAPI_BASE_URL || '').replace(/\/+$/, ''),
  uazapiToken: process.env.UAZAPI_TOKEN || '',

  openaiApiKey: required('OPENAI_API_KEY'),
  llmModel: process.env.LLM_MODEL_RESPONSES || 'gpt-5.6-luna',
  llmEffort: (process.env.LLM_EFFORT || 'medium') as 'low' | 'medium' | 'high',

  webhookSecret: required('WEBHOOK_SECRET'),
  // Junta as mensagens seguidas do cliente antes de responder.
  debounceSeconds: Number(process.env.DEBOUNCE_SECONDS || 12),

  gateTag: (process.env.GATE_TAG ?? 'sofi').toLowerCase(),
  humanTag: (process.env.HUMAN_TAG || 'atendimento-humano').toLowerCase(),

  upstashUrl: required('UPSTASH_REDIS_REST_URL'),
  upstashToken: required('UPSTASH_REDIS_REST_TOKEN'),

  // Ledger de custo (lib/cost.ts). 0 = usa a tabela datada.
  llmInputUsdMtok: Number(process.env.LLM_INPUT_USD_MTOK || 0),
  llmCachedUsdMtok: Number(process.env.LLM_CACHED_USD_MTOK || 0),
  llmOutputUsdMtok: Number(process.env.LLM_OUTPUT_USD_MTOK || 0),
  ttsUsdKchars: Number(process.env.TTS_USD_KCHARS || 0),
  sttUsdMinute: Number(process.env.STT_USD_MINUTE || 0),
  usdBrl: Number(process.env.USD_BRL || 5.4),
  infraPerExecutionBrl: Number(process.env.INFRA_BRL_POR_EXECUCAO || 0),
}
