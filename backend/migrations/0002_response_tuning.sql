SET search_path TO assistant_ia;

-- Controles ajustáveis pelo lojista em /meu-plano/assistente-ia:
-- janela de agrupamento de mensagens em sequência (debounce) e limites de
-- tamanho da resposta final (IA 3 / supervisor).
ALTER TABLE assistant_config ADD COLUMN IF NOT EXISTS message_batch_window_seconds INTEGER NOT NULL DEFAULT 8;
ALTER TABLE assistant_config ADD COLUMN IF NOT EXISTS min_response_chars INTEGER NOT NULL DEFAULT 150;
ALTER TABLE assistant_config ADD COLUMN IF NOT EXISTS max_response_chars INTEGER NOT NULL DEFAULT 300;
