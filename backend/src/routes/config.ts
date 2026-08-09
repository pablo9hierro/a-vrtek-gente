import { Router } from 'express'
import { pool } from '../db/pool.js'
import { isBetaTenant } from '../services/beta.js'
import type { AssistantConfig } from '../agents/pipeline.js'

export const configRouter = Router()

function betaGate(req: any, res: any, next: any) {
  const tenantSlug = String(req.params.tenantSlug || '')
  if (!isBetaTenant(tenantSlug)) {
    res.status(404).json({ error: 'Assistente IA não disponível pra essa loja ainda.' })
    return
  }
  next()
}

configRouter.get('/:tenantSlug/config', betaGate, async (req, res) => {
  const tenantSlug = req.params.tenantSlug
  const { rows } = await pool.query<AssistantConfig>(
    `SELECT * FROM assistant_ia.assistant_config WHERE tenant_id = $1`,
    [tenantSlug],
  )
  if (rows.length === 0) {
    res.json({
      tenant_id: tenantSlug,
      enabled: false,
      prompt_interpreter: '',
      prompt_validator: '',
      start_keywords: ['oi', 'olá', 'atendimento', 'quero comprar', 'pedido'],
      end_keywords: ['tchau', 'encerrar'],
      window_timeout_minutes: 30,
      message_batch_window_seconds: 8,
      min_response_chars: 150,
      max_response_chars: 300,
      anthropic_api_key: null,
      ai_provider: 'anthropic',
      ai_model: null,
    })
    return
  }
  res.json(rows[0])
})

configRouter.put('/:tenantSlug/config', betaGate, async (req, res) => {
  const tenantSlug = req.params.tenantSlug
  const body = req.body as Partial<AssistantConfig>
  const { rows } = await pool.query<AssistantConfig>(
    `INSERT INTO assistant_ia.assistant_config
       (tenant_id, enabled, prompt_interpreter, prompt_validator, start_keywords, end_keywords, window_timeout_minutes,
        message_batch_window_seconds, min_response_chars, max_response_chars, anthropic_api_key, ai_provider, ai_model, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       prompt_interpreter = EXCLUDED.prompt_interpreter,
       prompt_validator = EXCLUDED.prompt_validator,
       start_keywords = EXCLUDED.start_keywords,
       end_keywords = EXCLUDED.end_keywords,
       window_timeout_minutes = EXCLUDED.window_timeout_minutes,
       message_batch_window_seconds = EXCLUDED.message_batch_window_seconds,
       min_response_chars = EXCLUDED.min_response_chars,
       max_response_chars = EXCLUDED.max_response_chars,
       anthropic_api_key = EXCLUDED.anthropic_api_key,
       ai_provider = EXCLUDED.ai_provider,
       ai_model = EXCLUDED.ai_model,
       updated_at = now()
     RETURNING *`,
    [
      tenantSlug,
      body.enabled ?? false,
      body.prompt_interpreter ?? '',
      body.prompt_validator ?? '',
      body.start_keywords ?? ['oi', 'olá', 'atendimento', 'quero comprar', 'pedido'],
      body.end_keywords ?? ['tchau', 'encerrar'],
      body.window_timeout_minutes ?? 30,
      body.message_batch_window_seconds ?? 8,
      body.min_response_chars ?? 150,
      body.max_response_chars ?? 300,
      body.anthropic_api_key?.trim() || null,
      body.ai_provider === 'openrouter' ? 'openrouter' : body.ai_provider === 'openai' ? 'openai' : 'anthropic',
      body.ai_model?.trim() || null,
    ],
  )
  res.json(rows[0])
})
