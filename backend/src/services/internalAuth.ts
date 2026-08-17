/**
 * Gate real (não só `betaGate`, que só checa se o slug está numa allowlist
 * hardcoded — sem nenhuma verificação criptográfica) pras rotas
 * administrativas deste serviço (config, RAG, conversas). Sem isso,
 * qualquer pessoa que soubesse o slug do tenant (público, visível em toda
 * URL da loja) conseguia ler E escrever prompt/chave de API/histórico de
 * conversa de qualquer tenant — achado real em produção, corrigido aqui.
 *
 * O segredo (`ASSISTANT_IA_INTERNAL_KEY`) nunca chega ao navegador — só os
 * backends que já autenticaram o admin/lojista de verdade (ecommerce-api
 * via AdminTenant, ufersin-api via AuthSubscriber) o conhecem, e repassam
 * a chamada pra cá depois de validar quem está pedindo. Mesmo padrão
 * `x-internal-key` já usado em `ecommerce-api` pra chamadas backend-a-backend.
 */
export function internalAuthGate(req: any, res: any, next: any) {
  const expected = process.env.ASSISTANT_IA_INTERNAL_KEY
  if (!expected) {
    console.error('ASSISTANT_IA_INTERNAL_KEY não configurada — recusando toda chamada administrativa por segurança.')
    res.status(500).json({ error: 'Serviço mal configurado.' })
    return
  }
  const provided = req.header('x-internal-key')
  if (provided !== expected) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  next()
}
