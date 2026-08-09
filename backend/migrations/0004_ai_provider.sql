SET search_path TO assistant_ia;

-- Qual motor de IA usar por tenant — "anthropic" (padrão, usa
-- anthropic_api_key + SDK oficial) ou "openrouter" (chave da OpenRouter,
-- formato OpenAI-compatible, exige escolher um modelo).
ALTER TABLE assistant_config ADD COLUMN IF NOT EXISTS ai_provider TEXT NOT NULL DEFAULT 'anthropic';
ALTER TABLE assistant_config ADD COLUMN IF NOT EXISTS ai_model TEXT;
