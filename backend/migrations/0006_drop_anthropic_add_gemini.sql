SET search_path TO assistant_ia;

-- Decisão explícita do dono da plataforma: a chave da Anthropic console
-- nunca mais é usada, em lugar nenhum. Remove o motor Anthropic do
-- ranking e a constraint volta a aceitar só os provedores realmente
-- suportados (aiClient.ts não tem mais nenhum código pra "anthropic").
DELETE FROM platform_ai_engines WHERE provider = 'anthropic';

ALTER TABLE platform_ai_engines DROP CONSTRAINT IF EXISTS platform_ai_engines_provider_check;
ALTER TABLE platform_ai_engines ADD CONSTRAINT platform_ai_engines_provider_check CHECK (provider IN ('openai','openrouter'));

-- Gemini 3.7 Flash via OpenRouter — pedido explícito do dono da
-- plataforma como mais uma opção no ranking (mesma chave OPENROUTER_API_KEY
-- que já cobre GPT-5.4 Nano e DeepSeek V3.2, nenhuma chave nova).
INSERT INTO platform_ai_engines (label, provider, model, priority, enabled)
SELECT 'Gemini 3.7 Flash (OpenRouter)', 'openrouter', 'google/gemini-3.7-flash',
  COALESCE((SELECT MAX(priority) FROM platform_ai_engines), 0) + 1, true
WHERE NOT EXISTS (SELECT 1 FROM platform_ai_engines WHERE model = 'google/gemini-3.7-flash');

-- Renormaliza prioridades pra 1..N sem buracos (idempotente — roda em todo
-- boot, ver db/migrate.ts — reordenar em cima do próprio ranking atual
-- sempre converge pro mesmo resultado, nunca "soma" nada a cada boot).
-- Passo intermediário negativo evita colisão com a UNIQUE INDEX(priority).
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY priority) AS rn FROM platform_ai_engines
)
UPDATE platform_ai_engines e SET priority = -r.rn FROM ranked r WHERE r.id = e.id;
UPDATE platform_ai_engines SET priority = -priority WHERE priority < 0;
