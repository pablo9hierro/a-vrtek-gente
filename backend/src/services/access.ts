import { resolveTenantVertical, type Vertical } from './tenantVertical.js'

/**
 * Regra de acesso ao Assistente IA, por ramo — substitui o antigo
 * `beta.ts` (allowlist única e cega). Duas regras completamente
 * diferentes:
 *
 * - Ramo ELETRÔNICA: o Assistente IA vem NATIVO no plano, incluso, sem
 *   assinatura acessória — todo tenant desse ramo tem acesso por padrão.
 *   Ligar/desligar é o toggle "Ativar Assistente IA" do próprio tenant
 *   (`assistant_config.enabled`, controlado pelo lojista), NUNCA gate
 *   nesta camada.
 * - Ramo ECOMMERCE: o Assistente IA é produto ACESSÓRIO — só funciona pra
 *   quem pagou a assinatura extra. Cobrança/assinatura desse acessório
 *   ainda não está implementada (plano futuro), então por enquanto é uma
 *   allowlist manual dos tenants que "compraram" (hoje só `resusu`, tenant
 *   de desenvolvimento/validação). Quando a assinatura acessória existir
 *   de verdade, ECOMMERCE_ADDON_TENANTS vira uma consulta real de
 *   assinatura em vez de um Set fixo — o resto do código (todo o pipeline,
 *   tools, adapters) já não muda nada, só esta função.
 */
const ECOMMERCE_ADDON_TENANTS = new Set(['resusu'])

export type AccessResult =
  | { allowed: true; vertical: Vertical }
  | { allowed: false; vertical: Vertical | null; reason: string }

export async function checkAssistantAccess(tenantSlug: string): Promise<AccessResult> {
  const vertical = await resolveTenantVertical(tenantSlug)
  if (!vertical) {
    return { allowed: false, vertical: null, reason: 'tenant não encontrado no registro da plataforma' }
  }
  if (vertical === 'eletronica') {
    return { allowed: true, vertical }
  }
  // ecommerce
  if (ECOMMERCE_ADDON_TENANTS.has(tenantSlug)) {
    return { allowed: true, vertical }
  }
  return { allowed: false, vertical, reason: 'Assistente IA é um acessório pago pra lojas do ramo ecommerce — este tenant não tem a assinatura acessória ativa.' }
}
