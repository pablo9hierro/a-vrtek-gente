SET search_path TO assistant_ia;

-- Motores de IA da plataforma, em ranking de prioridade — controlados pelo
-- dono da plataforma (superadmin), não pelo lojista. completeWithTools/
-- completeSimple (aiClient.ts) tentam cada um em ordem até um responder;
-- se o motor de topo (priority=1) cair/não responder, cai automaticamente
-- pro próximo. Substitui a antiga seleção por tenant (assistant_config.
-- ai_provider/ai_model/anthropic_api_key) como fonte de verdade de QUAL
-- motor responde — essas colunas continuam existindo (não é destrutivo)
-- mas não são mais lidas pra essa decisão.
CREATE TABLE IF NOT EXISTS platform_ai_engines (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  label TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai','openrouter')),
  model TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_ai_engines_priority ON platform_ai_engines(priority);

-- Seed inicial: o motor que já roda hoje (Claude Opus 5, era o default
-- hardcoded) primeiro, GPT-4o mini em seguida (era o default da OpenAI),
-- depois os dois modelos via OpenRouter que o dono da plataforma pediu
-- como fallback adicional. Só popula se a tabela estiver vazia — não
-- sobrescreve reordenação feita depois pelo superadmin em boots seguintes
-- (migrations rodam em todo boot, ver db/migrate.ts).
INSERT INTO platform_ai_engines (label, provider, model, priority, enabled)
SELECT * FROM (VALUES
  ('Claude Opus 5 (Anthropic)', 'anthropic', 'claude-opus-5', 1, true),
  ('GPT-4o mini (OpenAI)', 'openai', 'gpt-4o-mini', 2, true),
  ('GPT-5.4 Nano (OpenRouter)', 'openrouter', 'openai/gpt-5.4-nano', 3, true),
  ('DeepSeek V3.2 (OpenRouter)', 'openrouter', 'deepseek/deepseek-v3.2', 4, true)
) AS seed(label, provider, model, priority, enabled)
WHERE NOT EXISTS (SELECT 1 FROM platform_ai_engines);
