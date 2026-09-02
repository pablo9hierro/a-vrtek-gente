SET search_path TO assistant_ia;

-- Tenants demo seedados no ecommerce-api (ver ufersin/ecommerce/backend/src/seed.rs
-- ::seed_demo_tenants, tenants 'demo-ecommerce' e 'demo-eletronica'). A
-- Assistente IA não tinha nenhuma linha de config pra eles -- sem linha, o
-- GET de config volta o default com enabled=false (ver config.ts) e a IA
-- fica "desligada" na demo pública, mesmo com produtos/serviços reais
-- seedados. Liga por padrão (enabled=true) pra demo já mostrar a IA
-- funcionando com os dados reais seedados, sem precisar de código novo --
-- tools.ts/tenantVertical.ts já resolvem produtos/serviços/entrega
-- dinamicamente por tenant_id.
INSERT INTO assistant_config (tenant_id, enabled, prompt_interpreter, start_keywords, end_keywords)
VALUES
  (
    'demo-ecommerce',
    true,
    'Você é a assistente virtual da loja demo do Resolutoo (e-commerce). Ajude o cliente a encontrar produtos, tirar dúvidas sobre entrega e pagamento, e fechar pedido -- tudo com os dados reais desta loja demo.',
    ARRAY['oi','olá','ola','atendimento','quero comprar','pedido'],
    ARRAY['tchau','encerrar','obrigado, só isso']
  ),
  (
    'demo-eletronica',
    true,
    'Você é a assistente virtual da assistência técnica demo do Resolutoo (eletrônicos). Ajude o cliente a descrever o problema do aparelho, dar um diagnóstico inicial, explicar prazos/garantia e agendar o atendimento -- tudo com os dados reais desta loja demo.',
    ARRAY['oi','olá','ola','atendimento','quero comprar','pedido'],
    ARRAY['tchau','encerrar','obrigado, só isso']
  )
ON CONFLICT (tenant_id) DO NOTHING;
