// Trava de 5 chamadas por segundo ao Kommo (padrão Kuma, 2026-11-28).
// Um Kommo falso conta as chamadas por segundo; um Redis falso (protocolo REST do Upstash) guarda o contador.
// 14 chamadas ao mesmo tempo: nenhum segundo pode passar de 5 e todas precisam terminar.
// Rodar: node node_modules/tsx/dist/cli.mjs scripts/test-kommo-limite.ts
import assert from 'node:assert'
import http from 'node:http'

const ouvir = (srv: http.Server) => new Promise<number>(r => srv.listen(0, () => r((srv.address() as { port: number }).port)))

async function main() {
  const porSegundo = new Map<number, number>()
  const kommo = http.createServer((req, res) => {
    const s = Math.floor(Date.now() / 1000)
    porSegundo.set(s, (porSegundo.get(s) || 0) + 1)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 1, pipeline_id: 1, status_id: 1 }))
  })
  const dados = new Map<string, number>()
  const upstash = http.createServer((req, res) => {
    let corpo = ''
    req.on('data', c => (corpo += c))
    req.on('end', () => {
      const rodar = ([cmd, chave]: [string, string]) => {
        const c = String(cmd).toLowerCase()
        if (c === 'incr') { dados.set(chave, (dados.get(chave) || 0) + 1); return { result: dados.get(chave) } }
        return { result: c === 'ttl' ? -2 : 'OK' }
      }
      const b = JSON.parse(corpo)
      // o cliente do Upstash manda um comando ou um lote (pipeline)
      const resposta = Array.isArray(b[0]) ? b.map(rodar) : rodar(b)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(resposta))
    })
  })
  const pk = await ouvir(kommo), pu = await ouvir(upstash)
  Object.assign(process.env, {
    KOMMO_DOMAIN: `http://127.0.0.1:${pk}`, KOMMO_TOKEN: 'teste',
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${pu}`, UPSTASH_REDIS_REST_TOKEN: 'falso',
  })
  const k = await import('../lib/kommo')

  const t0 = Date.now()
  await Promise.all(Array.from({ length: 14 }, (_, i) => k.getLead(i + 1)))
  const maximo = Math.max(...porSegundo.values())
  const total = [...porSegundo.values()].reduce((a, b) => a + b, 0)
  assert.strictEqual(total, 14, 'todas as chamadas saíram')
  assert.ok(maximo <= 5, `no máximo 5 por segundo (teve ${maximo})`)
  assert.ok(Date.now() - t0 >= 1500, 'as que passaram de 5 esperaram o segundo seguinte')

  kommo.close(); upstash.close()
  console.log(`test-kommo-limite: 14 chamadas em ${porSegundo.size} segundos, máximo ${maximo} por segundo`)
}
main().catch(e => { console.error(e); process.exit(1) })
