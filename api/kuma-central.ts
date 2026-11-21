import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { redis } from '../lib/redis'
import { listExec } from '../lib/execlog'
import { getHistory } from '../lib/history'
import { gravarLiberacao, liberacaoAtual, pausaGeral } from '../lib/liberados'

/**
 * Rota da Central IAs Kuma (contrato em SISTEMAS/Central IAs Kuma/CONTRATO-AGENTE.md).
 * Cabeçalho x-kuma-central = KUMA_CENTRAL_SECRET. GET ?r=estado|diario|conversas|ensinar · POST ?r=pausa-geral|liberacao|ensinar
 */
function autorizado(req: VercelRequest): boolean {
  const s = process.env.KUMA_CENTRAL_SECRET || ''
  const v = String(req.headers['x-kuma-central'] || '')
  if (s.length < 32 || v.length !== s.length) return false
  return timingSafeEqual(Buffer.from(v), Buffer.from(s))
}

const versao = (() => {
  try { return 'prompt ' + createHash('sha1').update(fs.readFileSync(path.join(process.cwd(), 'prompt.md'))).digest('hex').slice(0, 7) } catch { return null }
})()

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'não autorizado' })
  const r = String(req.query.r || '')
  try {
    if (req.method === 'GET' && r === 'estado') {
      return res.json({ ia: 'Sofi', pausaGeral: await pausaGeral(), liberacao: await liberacaoAtual(), versao, testes: '18/18' })
    }
    if (req.method === 'GET' && r === 'diario') {
      const desde = Date.parse(String(req.query.desde || '')) || 0
      const limite = Math.min(500, Number(req.query.limite) || 200)
      const execucoes = (await listExec(limite)).filter(e => Date.parse(e.ts) >= desde).map(e => {
        const c = e.custo
        return {
          em: e.ts, leadId: e.leadId, resultado: e.resultado, detalhe: e.detalhe, ms: e.duracaoMs, tools: e.tools,
          cliente: e.turnoLead, resposta: e.resposta,
          custo: c ? { total: c.totalBrl, respostas: c.llmUsd * c.usdBrl, audio: c.sttUsd * c.usdBrl, midia: 0 } : undefined,
        }
      })
      return res.json({ execucoes })
    }
    if (req.method === 'GET' && r === 'conversas') {
      const leads = String(req.query.leads || '').split(',').map(Number).filter(Boolean).slice(0, 50)
      const out: Record<number, unknown> = {}
      await Promise.all(leads.map(async id => {
        const h = await getHistory(id)
        const u = h[h.length - 1]
        if (u) out[id] = { ultima: { dir: u.dir, texto: u.text.slice(0, 300), em: new Date(u.ts).toISOString() } }
      }))
      return res.json(out)
    }
    if (req.method === 'GET' && r === 'ensinar') {
      const raw = await redis.lrange<string | object>('ak:ensinar', 0, 99)
      return res.json({ pedidos: raw.map(x => (typeof x === 'string' ? JSON.parse(x) : x)) })
    }
    const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {}
    if (req.method === 'POST' && r === 'pausa-geral') {
      if (b.ligar) await redis.set('ak:pausa:geral', JSON.stringify({ por: b.por, em: new Date().toISOString() }))
      else await redis.del('ak:pausa:geral')
      return res.json({ ok: true })
    }
    if (req.method === 'POST' && r === 'liberacao') {
      if (b.modo !== 'teste' && b.modo !== 'todos') return res.status(400).json({ erro: 'modo inválido' })
      await gravarLiberacao({ modo: b.modo, numeros: Array.isArray(b.numeros) ? b.numeros.map(String) : [] })
      return res.json({ ok: true })
    }
    if (req.method === 'POST' && r === 'ensinar') {
      const pedido = { id: Date.now().toString(36), em: new Date().toISOString(), tipo: b.tipo === 'correcao' ? 'correcao' : 'informacao', texto: String(b.texto || '').slice(0, 4000), conversa: String(b.conversa || '').slice(0, 4000), por: String(b.por || ''), situacao: 'novo' }
      await redis.lpush('ak:ensinar', JSON.stringify(pedido))
      await redis.ltrim('ak:ensinar', 0, 199)
      return res.json({ ok: true, id: pedido.id })
    }
    return res.status(400).json({ erro: 'pedido desconhecido' })
  } catch (e) {
    console.error('[kuma-central]', e)
    return res.status(500).json({ erro: 'falha interna' })
  }
}
