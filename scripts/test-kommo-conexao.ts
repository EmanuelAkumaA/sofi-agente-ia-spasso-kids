// Trava do erro de 20/11/2026 (Zaya): o Kommo fecha a conexão ("fetch failed", UND_ERR_SOCKET).
// Um servidor local derruba a 1ª conexão de cada pedido: GET e PATCH precisam passar na 2ª tentativa; POST não repete.
// Rodar: node node_modules/tsx/dist/cli.mjs scripts/test-kommo-conexao.ts
import assert from 'node:assert'
import http from 'node:http'

const vistos = new Map<string, number>()
const srv = http.createServer((req, res) => {
  const k = `${req.method} ${req.url}`
  const n = (vistos.get(k) || 0) + 1
  vistos.set(k, n)
  if (n === 1) { req.socket.destroy(); return } // "other side closed"
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 1, ok: true }))
})
async function main() {
await new Promise<void>(r => srv.listen(0, r))
const porta = (srv.address() as { port: number }).port
process.env.KOMMO_DOMAIN = `http://127.0.0.1:${porta}`
process.env.KOMMO_TOKEN ||= 'teste'

const k = await import('../lib/kommo')

const lead = await k.getLead(123)
assert.strictEqual((lead as { id: number }).id, 1, 'GET passa na 2ª tentativa')
assert.strictEqual([...vistos.entries()].find(([x]) => x.startsWith('GET'))?.[1], 2, 'foram 2 tentativas')

let postFalhou = false
try { await k.addLeadNote(123, 'nota de teste') } catch (e) { postFalhou = k.falhaDeConexao(e) }
assert.ok(postFalhou, 'POST não repete: a falha de conexão sobe')
assert.strictEqual([...vistos.entries()].find(([x]) => x.startsWith('POST'))?.[1], 1)

srv.close()
console.log('test-kommo-conexao: GET e PATCH repetem na queda de conexão; POST não repete')
}
main().catch(e => { console.error(e); process.exit(1) })
