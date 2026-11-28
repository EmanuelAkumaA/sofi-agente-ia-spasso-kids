// Trava do bloqueio de 27/11/2026: rajada → 429 → o Kommo bloqueou a API (403). Confere:
// 1) 429 repetido puxa o freio e a chamada seguinte nem chega ao Kommo; 2) 403 do nginx puxa o freio na hora;
// 3) leadsPorId busca vários cards num pedido só e fica só com os funis pedidos.
// Redis falso de propósito: o freio de verdade (ak:kommo:freio) não pode ser puxado por um teste.
// Rodar: node node_modules/tsx/dist/cli.mjs scripts/test-kommo-freio.ts
import assert from 'node:assert'
import http from 'node:http'

async function main() {
  let modo: '429' | '403' | 'ok' = '429'
  const pedidos: string[] = []
  const srv = http.createServer((req, res) => {
    pedidos.push(req.url || '')
    if (modo === '429') return res.writeHead(429, { 'content-type': 'text/html' }).end('<html>429 Too Many Requests nginx</html>')
    if (modo === '403') return res.writeHead(403, { 'content-type': 'text/html' }).end('<html><title>403 Forbidden</title>nginx</html>')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ _embedded: { leads: [
      { id: 3, pipeline_id: 10, status_id: 1 }, { id: 2, pipeline_id: 99, status_id: 1 }, { id: 1, pipeline_id: 10, status_id: 142 },
    ] } }))
  })
  await new Promise<void>(r => srv.listen(0, r))
  const porta = (srv.address() as { port: number }).port
  Object.assign(process.env, {
    KOMMO_DOMAIN: `http://127.0.0.1:${porta}`, KOMMO_TOKEN: 'teste',
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9', UPSTASH_REDIS_REST_TOKEN: 'falso',
  })
  const k = await import('../lib/kommo')

  // 1) 429: uma nova tentativa, depois freio
  await assert.rejects(k.getLead(1), /429/)
  assert.strictEqual(pedidos.length, 2, '429 tenta só mais uma vez')
  await assert.rejects(k.getLead(2), (e: unknown) => e instanceof k.KommoEmFreio)
  assert.strictEqual(pedidos.length, 2, 'com o freio puxado, nada chega ao Kommo')

  // 2) 403 do nginx: freio na hora, sem nova tentativa
  k.soltarFreioLocal(); modo = '403'; pedidos.length = 0
  await assert.rejects(k.getLead(3), /403/)
  assert.strictEqual(pedidos.length, 1, '403 não tenta de novo')
  await assert.rejects(k.getLead(4), (e: unknown) => e instanceof k.KommoEmFreio)
  assert.strictEqual(pedidos.length, 1)

  // 3) vários cards num pedido só, só dos funis pedidos
  k.soltarFreioLocal(); modo = 'ok'; pedidos.length = 0
  const leads = await k.leadsPorId([1, 2, 3], [10])
  assert.strictEqual(pedidos.length, 1, 'um pedido para os 3 cards')
  assert.deepStrictEqual(new URL('http://x' + pedidos[0]).searchParams.getAll('filter[id][]'), ['1', '2', '3'])
  assert.deepStrictEqual(leads.map(l => l.id).sort(), [1, 3], 'card do funil 99 fica de fora')

  srv.close()
  console.log('test-kommo-freio: 429 repetido e 403 puxam o freio; cards vêm num pedido só')
}
main().catch(e => { console.error(e); process.exit(1) })
