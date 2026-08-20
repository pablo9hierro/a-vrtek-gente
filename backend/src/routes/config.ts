import { Router } from 'express'
import { pool } from '../db/pool.js'
import { checkAssistantAccess } from '../services/access.js'
import { internalAuthGate } from '../services/internalAuth.js'
import type { AssistantConfig } from '../agents/pipeline.js'

export const configRouter = Router()

const VRTECH_BASE_URL = process.env.VRTECH_BASE_URL || 'https://vrtech-jp.vercel.app'

/**
 * O ramo eletrônica ainda roda o pipeline/tools local do vrtech (agenda,
 * catálogo próprio) -- só a config (prompt, gatilhos, timeouts) passou a
 * ser editada aqui. Sem esse write-through, editar em /meu-plano não teria
 * nenhum efeito nas conversas reais de WhatsApp do vrtech. Best-effort: se
 * o vrtech estiver fora do ar, a config aqui já foi salva de qualquer forma.
 */
async function syncToVrtech(config: Partial<AssistantConfig>): Promise<void> {
  const secret = process.env.ASSISTANT_SYNC_SECRET
  if (!secret) {
    console.error('[config] ASSISTANT_SYNC_SECRET não configurado — sync com vrtech pulado')
    return
  }
  try {
    const res = await fetch(`${VRTECH_BASE_URL}/api/assistant/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
      body: JSON.stringify(config),
    })
    if (!res.ok) console.error('[config] sync com vrtech falhou:', res.status, await res.text().catch(() => ''))
  } catch (e) {
    console.error('[config] sync com vrtech falhou:', e)
  }
}

async function betaGate(req: any, res: any, next: any) {
  const tenantSlug = String(req.params.tenantSlug || '')
  const access = await checkAssistantAccess(tenantSlug)
  if (!access.allowed) {
    res.status(404).json({ error: 'reason' in access ? access.reason : 'Assistente IA não disponível pra essa loja.' })
    return
  }
  req.vertical = access.vertical
  next()
}

configRouter.use('/:tenantSlug/config', internalAuthGate)

// prompt_validator saiu do controle do tenant (virou parte fixa de
// universalValidatorRules, ver pipeline.ts) — nunca mais lido nem escrito
// aqui, mesmo que a coluna ainda exista no banco com dado antigo. Idem
// pra ai_provider/ai_model/anthropic_api_key: qual motor de IA responde
// deixou de ser escolha do tenant — agora é 100% ranking do superadmin
// (ver platformEngines.ts/aiClient.ts). Colunas continuam existindo no
// banco (não é destrutivo) mas saem da lista explícita — nunca mais lidas
// nem escritas por aqui, mesmo que alguém reintroduza SELECT *.
const CONFIG_COLUMNS = `tenant_id, enabled, prompt_interpreter, start_keywords, end_keywords, window_timeout_minutes,
  message_batch_window_seconds, min_response_chars, max_response_chars, updated_at`

configRouter.get('/:tenantSlug/config', betaGate, async (req, res) => {
  const tenantSlug = req.params.tenantSlug
  const { rows } = await pool.query<AssistantConfig>(
    `SELECT ${CONFIG_COLUMNS} FROM assistant_ia.assistant_config WHERE tenant_id = $1`,
    [tenantSlug],
  )
  if (rows.length === 0) {
    res.json({
      tenant_id: tenantSlug,
      enabled: false,
      prompt_interpreter: '',
      start_keywords: ['oi', 'olá', 'atendimento', 'quero comprar', 'pedido'],
      end_keywords: ['tchau', 'encerrar'],
      window_timeout_minutes: 30,
      message_batch_window_seconds: 8,
      min_response_chars: 150,
      max_response_chars: 300,
    })
    return
  }
  res.json(rows[0])
})

configRouter.put('/:tenantSlug/config', betaGate, async (req, res) => {
  const tenantSlug = req.params.tenantSlug
  const body = req.body as Partial<AssistantConfig>
  // prompt_validator e ai_provider/ai_model/anthropic_api_key nunca são
  // lidos do body, mesmo que o cliente mande — não são mais campos que o
  // tenant controla (ver pipeline.ts e aiClient.ts/platformEngines.ts).
  const { rows } = await pool.query<AssistantConfig>(
    `INSERT INTO assistant_ia.assistant_config
       (tenant_id, enabled, prompt_interpreter, start_keywords, end_keywords, window_timeout_minutes,
        message_batch_window_seconds, min_response_chars, max_response_chars, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       prompt_interpreter = EXCLUDED.prompt_interpreter,
       start_keywords = EXCLUDED.start_keywords,
       end_keywords = EXCLUDED.end_keywords,
       window_timeout_minutes = EXCLUDED.window_timeout_minutes,
       message_batch_window_seconds = EXCLUDED.message_batch_window_seconds,
       min_response_chars = EXCLUDED.min_response_chars,
       max_response_chars = EXCLUDED.max_response_chars,
       updated_at = now()
     RETURNING ${CONFIG_COLUMNS}`,
    [
      tenantSlug,
      body.enabled ?? false,
      body.prompt_interpreter ?? '',
      body.start_keywords ?? ['oi', 'olá', 'atendimento', 'quero comprar', 'pedido'],
      body.end_keywords ?? ['tchau', 'encerrar'],
      body.window_timeout_minutes ?? 30,
      body.message_batch_window_seconds ?? 8,
      body.min_response_chars ?? 150,
      body.max_response_chars ?? 300,
    ],
  )
  res.json(rows[0])

  if ((req as any).vertical === 'eletronica') void syncToVrtech(rows[0])
})
