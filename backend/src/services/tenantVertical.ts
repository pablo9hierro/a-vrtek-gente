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
// BUG-018: `oferece_servicos` NUNCA mora no ecommerce-api -- é config da
// assinatura/plano, dona da plataforma (ufersin-api/"Resolutoo"), não do
// motor de e-commerce. `resolveOfereceServicos` batia em
// `${ECOMMERCE_API_URL}/api/public/tenant-config/...`, rota que nunca
// existiu ali (404 sempre) -- por isso `oferece_servicos` sempre resolvia
// `false` silenciosamente e a Assistente IA nunca via as tools de serviço,
// mesmo em lojas com serviço cadastrado e a preferência ligada.
const PLATFORM_API_URL = process.env.PLATFORM_API_URL || 'https://ufersin-api-production.up.railway.app'
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

/**
 * Motor ecommerce genérico (opcional): o lojista oferece serviços além de
 * produtos? Controla se as tools de serviço/agendamento entram no set que
 * a IA recebe (`aiClient.ts`) e se o prompt menciona serviço — sem isso,
 * um tenant só-produto ficaria com a IA tentando oferecer/agendar serviço
 * que ele nem cadastrou. Ramo eletrônica sempre `true` (não usa esta
 * coluna, é obrigatório lá — ver `oferece_servicos` no backend Rust).
 */
const offerCache = new Map<string, { value: boolean; expiresAt: number }>()

export async function resolveOfereceServicos(tenantSlug: string, vertical: Vertical | null): Promise<boolean> {
  if (vertical === 'eletronica') return true
  const cached = offerCache.get(tenantSlug)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let value = false
  try {
    const res = await fetch(`${PLATFORM_API_URL}/api/public/tenant-config/${encodeURIComponent(tenantSlug)}`)
    if (res.ok) {
      const body = (await res.json()) as { oferece_servicos?: boolean }
      value = Boolean(body.oferece_servicos)
    } else {
      console.error(
        `[tenantVertical] tenant-config de ${tenantSlug} respondeu ${res.status} (${PLATFORM_API_URL}) -- oferece_servicos ficando false por segurança, mas isso NÃO deveria acontecer`,
      )
    }
  } catch (e) {
    console.error('[tenantVertical] falha ao resolver oferece_servicos de', tenantSlug, e)
  }

  offerCache.set(tenantSlug, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  return value
}
