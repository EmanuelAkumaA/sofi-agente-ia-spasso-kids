import { CONFIG } from './config'

/**
 * Ouvido da Sofi: transcreve o áudio da cliente com a OpenAI (mesma conta do
 * cérebro — simplicidade da casa). No Kommo o link do anexo chega direto no
 * webhook add_message (message[add][0][attachment][link]) — transcrevemos
 * ANTES de gravar no histórico (o dedup por msgId garante 1 transcrição/áudio).
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
const MAX_AUDIO_BYTES = 20 * 1024 * 1024
const STT_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe'

export function sttEnabled(): boolean {
  return !!CONFIG.openaiApiKey
}

export async function transcribeUrl(url: string): Promise<string | null> {
  if (!sttEnabled() || !url.startsWith('http')) return null
  try {
    const audioRes = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!audioRes.ok) return null
    const audio = await audioRes.arrayBuffer()
    if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) return null

    // 🩸 18/09/2026: a uazapi entrega o áudio numa URL SEM extensão e o formato só
    // aparece no content-type. Sem ele, um mp3 era enviado como "audio.ogg" e a
    // OpenAI recusava ("file might be corrupted"): a cliente ficava com
    // "[áudio recebido sem transcrição]" e a Sofi sem entender o que ela disse.
    const tipoDaResposta = (audioRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const extPeloTipo = ({ 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/opus': 'ogg' } as Record<string, string>)[tipoDaResposta]
    const ext = (extPeloTipo || url.match(/\.(mp3|m4a|ogg|oga|opus|wav|webm)(?:$|\?)/i)?.[1] || 'ogg').toLowerCase()
    const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm' }[ext] || 'audio/ogg'

    const form = new FormData()
    form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`)
    form.append('model', STT_MODEL)
    form.append('language', 'pt')
    form.append('response_format', 'json')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.openaiApiKey}`, 'User-Agent': UA },
      body: form,
    })
    if (!res.ok) {
      console.log(`[stt] transcrição falhou (${res.status}) — anexo provavelmente não é áudio`)
      return null
    }
    const d = (await res.json()) as { text?: string }
    return (d.text || '').trim() || null
  } catch (e) {
    console.error('[stt] erro (placeholder será usado):', e)
    return null
  }
}
