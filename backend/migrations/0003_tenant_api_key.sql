SET search_path TO assistant_ia;

-- Permite o lojista trocar a chave da API do motor de IA usado por essa
-- loja específica (fallback pra ANTHROPIC_API_KEY global do processo
-- quando NULL/vazia) — usado quando o crédito da chave global acabar.
ALTER TABLE assistant_config ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT;
