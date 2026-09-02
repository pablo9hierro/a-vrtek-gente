import { resolveTenantVertical, type Vertical } from './tenantVertical.js'

/**
 * Assistente IA sai do beta: vem incluso em todo plano (ecommerce e
 * eletrônica), sem allowlist. Ligar/desligar é o toggle "Ativar Assistente
 * IA" do próprio tenant (`assistant_config.enabled`, controlado pelo
 * lojista) — nunca gate nesta camada.
 */
export type AccessResult =
  | { allowed: true; vertical: Vertical }
  | { allowed: false; vertical: Vertical | null; reason: string }

export async function checkAssistantAccess(tenantSlug: string): Promise<AccessResult> {
  const vertical = await resolveTenantVertical(tenantSlug)
  if (!vertical) {
    return { allowed: false, vertical: null, reason: 'tenant não encontrado no registro da plataforma' }
  }
  return { allowed: true, vertical }
}
