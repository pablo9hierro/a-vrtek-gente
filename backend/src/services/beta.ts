/**
 * Allowlist de lojas que podem ver/usar o Assistente IA enquanto ele está
 * em beta. Fora dessa lista, os endpoints tratam a loja como se o módulo
 * não existisse (404) — nada de vazar a feature pra quem não deve ter
 * acesso ainda. Pedido explícito: primeiro só a loja do e-mail
 * mulekinrx1v9@gmail.com (slug "resusu"), depois libera geral removendo
 * daqui ou trocando por `enabled: true` para todo mundo.
 */
const BETA_TENANT_SLUGS = new Set(['resusu'])

export function isBetaTenant(tenantSlugOrId: string): boolean {
  return BETA_TENANT_SLUGS.has(tenantSlugOrId)
}
