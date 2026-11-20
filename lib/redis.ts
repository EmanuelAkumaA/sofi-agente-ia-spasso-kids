import { Redis } from '@upstash/redis'
import { CONFIG } from './config'

/** Banco próprio da Sofi. Histórico, buffer, dedup e diário moram aqui (prefixo "ak:"). */
export const redis = new Redis({ url: CONFIG.upstashUrl, token: CONFIG.upstashToken })
