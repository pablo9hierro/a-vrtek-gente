/**
 * Resolve o RAMO (vertical) de um tenant consultando o registro público do
 * ecommerce-api (única fonte de verdade — a tabela `tenants` de lá cobre
 * TODOS os ramos, inclusive eletrônica, mesmo os tenants eletrônica não
 * usando o motor de e-commerce pra nada além de existir nesse registro).
 * Nunca acessa banco de outro serviço direto — HTTP, mesmo padrão do
 * resto da plataforma. Cache em memória curto: essa informação muda raras
 * vezes (troca de plano), não vale bater rede a cada mensagem de WhatsApp.
 */

const ECOMMERCE_API_URL = process.env.ECOMMERCE_API_URL || 'https://ecommerce-api-production-d447.up.railway.app'
const CACHE_TTL_MS = 5 * 60 * 1000

export type Vertical = 'ecommerce' | 'eletronica'

const cache = new Map<string, { vertical: Vertical | null; expiresAt: number }>()

function normalizeVertical(raw: string): Vertical | null {
  if (raw === 'eletronicos' || raw === 'eletronica') return 'eletronica'
  if (raw === 'ecommerce') return 'ecommerce'
  return null
}

export async function resolveTenantVertical(tenantSlug: string): Promise<Vertical | null> {
  const cached = cache.get(tenantSlug)
  if (cached && cached.expiresAt > Date.now()) return cached.vertical

  let vertical: Vertical | null = null
  try {
    const res = await fetch(`${ECOMMERCE_API_URL}/api/public/tenant-vertical/${encodeURIComponent(tenantSlug)}`)
    if (res.ok) {
      const body = (await res.json()) as { vertical: string }
      vertical = normalizeVertical(body.vertical)
    }
  } catch (e) {
    console.error('[tenantVertical] falha ao resolver vertical de', tenantSlug, e)
  }

  cache.set(tenantSlug, { vertical, expiresAt: Date.now() + CACHE_TTL_MS })
  return vertical
}
