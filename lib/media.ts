import OpenAI from 'openai'
import { CONFIG } from './config'

/**
 * Olho da Sofi: lê IMAGEM e PDF que a cliente manda (print de peça, print de
 * conversa, tabela de preço, comprovante de pagamento) com a visão da OpenAI —
 * mesma conta do cérebro, padrão da casa.
 *
 * Doutrina (kommo/PEGADINHAS.md §15 + §3-u2): descreve UMA única vez na
 * ENTRADA e grava o resultado como TEXTO no histórico Redis. O modelo nunca
 * precisa dos bytes de novo — não se paga visão a cada turno da conversa.
 *
 * ⚠️ Reconhecer `attachment.type` NÃO é visão. O parser anterior extraía o
 * `attachment.link` e o DESCARTAVA, gravando '[imagem recebida]' — o modelo
 * nunca recebia nada e a Sofi respondia no escuro.
 *
 * Em qualquer falha (download, formato, tamanho, API) devolvemos `null`, e
 * quem chama grava um placeholder HONESTO. Fingir leitura é o pior desfecho:
 * a Sofi afirmaria com confiança total sobre um comprovante que não viu.
 */

const client = new OpenAI({ apiKey: CONFIG.openaiApiKey })

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 15_000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_DOC_BYTES = 15 * 1024 * 1024
const MAX_OUTPUT_TOKENS = 700

/** A visão pode rodar num modelo diferente do cérebro sem mexer em código. */
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || CONFIG.llmModel

/** Formatos que a visão da OpenAI aceita. HEIC e afins ficam de fora. */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const INSTRUCOES = [
  'Você é o olho de uma atendente de um BUFFET de festas infantis e teen (Spasso Kids, São Paulo).',
  'Descreva o arquivo de forma OBJETIVA e completa, em português do Brasil, para que a',
  'atendente entenda o conteúdo sem precisar abrir o arquivo.',
  '',
  'Regras:',
  '- Se for REFERÊNCIA DE DECORAÇÃO / TEMA / CONVITE: tema, personagens, cores e elementos principais.',
  '- Se for COMPROVANTE DE PAGAMENTO: diga apenas que é um comprovante e o valor e a data visíveis.',
  '- Se for PRINT DE CONVERSA, ORÇAMENTO ou documento com texto: TRANSCREVA o texto literalmente.',
  '- Se for lista de convidados: diga quantos nomes aparecem, sem copiar os nomes.',
  '- Diga o que ESTÁ no arquivo. Nunca deduza preço, disponibilidade ou condição comercial.',
  '- Se estiver ilegível, cortado ou ambíguo, diga exatamente isso. Não invente para preencher.',
  '',
  'Responda só com a descrição, sem preâmbulo e sem oferecer ajuda.',
].join('\n')

export function visionEnabled(): boolean {
  return !!CONFIG.openaiApiKey
}

interface Baixado {
  bytes: ArrayBuffer
  mime: string
  ext: string
}

/** Baixa o anexo com timeout e teto de tamanho. `null` = não deu, e tudo bem. */
async function baixar(url: string, maxBytes: number): Promise<Baixado | null> {
  if (!/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.log(`[media] download falhou (${res.status}) — anexo não será lido`)
      return null
    }

    // Corta antes de baixar quando o servidor declara o tamanho.
    const declarado = Number(res.headers.get('content-length') || 0)
    if (declarado > maxBytes) {
      console.log(`[media] anexo grande demais (${declarado} bytes, teto ${maxBytes})`)
      return null
    }

    const bytes = await res.arrayBuffer()
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
      console.log(`[media] anexo vazio ou acima do teto (${bytes.byteLength} bytes)`)
      return null
    }

    const headerMime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const ext = (url.match(/\.([a-z0-9]{2,5})(?:$|\?)/i)?.[1] || '').toLowerCase()
    const mime = headerMime || IMAGE_MIMES[ext] || (ext === 'pdf' ? 'application/pdf' : '')
    return { bytes, mime, ext }
  } catch (e) {
    console.error('[media] erro no download (placeholder será usado):', e)
    return null
  }
}

function paraDataUri(bytes: ArrayBuffer, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** Mesmo extrator do llm.ts: `output_text` com fallback pro walk do output. */
function extrairTexto(resp: any): string | null {
  if (typeof resp?.output_text === 'string' && resp.output_text.trim()) {
    return resp.output_text.trim()
  }
  const texto = (resp?.output || [])
    .flatMap((o: any) => (o.content || []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text))
    .join('\n')
    .trim()
  return texto || null
}

async function descrever(conteudo: unknown[], rotulo: string): Promise<string | null> {
  try {
    const resp: any = await client.responses.create({
      model: VISION_MODEL,
      instructions: INSTRUCOES,
      input: [{ role: 'user', content: conteudo }],
      max_output_tokens: MAX_OUTPUT_TOKENS,
    } as any)

    const texto = extrairTexto(resp)
    if (!texto) {
      console.log(`[media] ${rotulo}: modelo não devolveu descrição`)
      return null
    }
    // Anticorpo §15: o log tem que provar QUE descrição foi criada — ver o
    // thumbnail no Kommo não prova leitura nenhuma.
    console.log(`[media] ${rotulo} lido (${texto.length} chars): ${texto.slice(0, 160)}`)
    return texto
  } catch (e) {
    console.error(`[media] visão falhou (${rotulo}):`, e)
    return null
  }
}

/** Descreve uma IMAGEM. `null` se não deu — quem chama não pode fingir leitura. */
export async function describeImage(url: string): Promise<string | null> {
  if (!visionEnabled()) return null

  const arq = await baixar(url, MAX_IMAGE_BYTES)
  if (!arq) return null

  const mime = arq.mime.startsWith('image/') ? arq.mime : IMAGE_MIMES[arq.ext]
  if (!mime || !Object.values(IMAGE_MIMES).includes(mime)) {
    console.log(`[media] formato de imagem não suportado (${arq.mime || arq.ext || 'desconhecido'})`)
    return null
  }

  return descrever(
    [
      { type: 'input_text', text: 'Descreva esta imagem enviada pela cliente.' },
      { type: 'input_image', image_url: paraDataUri(arq.bytes, mime), detail: 'auto' },
    ],
    'imagem',
  )
}

/**
 * Descreve um DOCUMENTO. PDF vai como `input_file`; anexo `file` que na verdade
 * é imagem cai na visão de imagem. Formato que a visão não lê (docx, xlsx, zip)
 * devolve `null` — melhor a Sofi dizer que não abriu do que inventar.
 */
export async function describeDocument(url: string): Promise<string | null> {
  if (!visionEnabled()) return null

  const arq = await baixar(url, MAX_DOC_BYTES)
  if (!arq) return null

  if (arq.mime.startsWith('image/')) return describeImage(url)

  const ehPdf = arq.mime === 'application/pdf' || arq.ext === 'pdf'
  if (!ehPdf) {
    console.log(`[media] documento não legível pela visão (${arq.mime || arq.ext || 'desconhecido'})`)
    return null
  }

  return descrever(
    [
      { type: 'input_text', text: 'Descreva e transcreva este documento enviado pela cliente.' },
      {
        type: 'input_file',
        filename: `documento-${Date.now()}.pdf`,
        file_data: paraDataUri(arq.bytes, 'application/pdf'),
      },
    ],
    'documento PDF',
  )
}
