import { Router } from 'express'
import { pool } from '../db/pool.js'
import { isBetaTenant } from '../services/beta.js'
import { runPipeline, type AssistantConfig } from '../agents/pipeline.js'
import { sendWhatsappMessage } from '../evolution-adapter/send.js'

export const webhookRouter = Router()

type ForwardedEvolutionPayload = {
  tenant_slug: string
  instance: string
  phone: string
  text: string
  customer_name?: string
}

/**
 * Recebe o forward que o backend Rust do Resolutoo faz do webhook da
 * Evolution API (ver AGENTS_IA_INTEGRATION.md). Não é a Evolution chamando
 * aqui diretamente — é o backend existente repassando, já com o texto da
 * mensagem e o tenant resolvido, então esse endpoint não precisa reimplementar
 * a lógica de "de qual instância veio isso".
 */
webhookRouter.post('/evolution', async (req, res) => {
  // Responde 200 sempre e rápido — isso é chamado fire-and-forget pelo
  // backend Rust; qualquer erro aqui não pode voltar a afetar quem chamou.
  res.status(200).json({ ok: true })

  try {
    await handleInbound(req.body as ForwardedEvolutionPayload)
  } catch (e) {
    console.error('erro processando mensagem encaminhada da evolution:', e)
  }
})

async function handleInbound(payload: ForwardedEvolutionPayload) {
  const { tenant_slug: tenantSlug, instance, phone, text, customer_name: customerName } = payload
  if (!tenantSlug || !phone || !text) return
  if (!isBetaTenant(tenantSlug)) return // fora do beta, ignora silenciosamente

  const configRes = await pool.query<AssistantConfig>(
    `SELECT * FROM assistant_ia.assistant_config WHERE tenant_id = $1`,
    [tenantSlug],
  )
  const config = configRes.rows[0]
  if (!config || !config.enabled) return // assistente desligado nessa loja

  const conversation = await findOrOpenConversation(tenantSlug, phone, customerName, config.window_timeout_minutes)

  const inboundMessage = await pool.query<{ id: string }>(
    `INSERT INTO assistant_ia.messages (conversation_id, tenant_id, direction, sender_type, content)
     VALUES ($1, $2, 'inbound', 'cliente', $3) RETURNING id`,
    [conversation.id, tenantSlug, text],
  )
  await pool.query(
    `UPDATE assistant_ia.conversations SET last_message_at = now() WHERE id = $1`,
    [conversation.id],
  )

  // Interrompido manualmente nessa conversa (ou globalmente) -> não chama a IA,
  // fica esperando atendimento humano. Histórico já foi salvo acima.
  if (!conversation.assistant_enabled || conversation.human_override) return

  const encerramento = (config.end_keywords ?? []).some((kw) => text.toLowerCase().includes(kw.toLowerCase()))
  if (encerramento) {
    await pool.query(`UPDATE assistant_ia.conversations SET status = 'fechada', closed_at = now() WHERE id = $1`, [
      conversation.id,
    ])
    return
  }

  const historyRes = await pool.query<{ sender_type: string; content: string }>(
    `SELECT sender_type, content FROM assistant_ia.messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 30`,
    [conversation.id],
  )

  const result = await runPipeline(config, historyRes.rows, text, phone)

  const outboundMessage = await pool.query<{ id: string }>(
    `INSERT INTO assistant_ia.messages (conversation_id, tenant_id, direction, sender_type, content)
     VALUES ($1, $2, 'outbound', 'assistente', $3) RETURNING id`,
    [conversation.id, tenantSlug, result.reply],
  )
  await pool.query(
    `INSERT INTO assistant_ia.agent_decisions (message_id, tenant_id, layer, output) VALUES
       ($1, $2, 'interpreter', $3), ($1, $2, 'validator', $4)`,
    [outboundMessage.rows[0].id, tenantSlug, result.interpreterOutput, result.validatorOutput],
  )
  await pool.query(`UPDATE assistant_ia.conversations SET last_message_at = now() WHERE id = $1`, [conversation.id])

  await sendWhatsappMessage(instance, phone, result.reply)
  void inboundMessage
}

async function findOrOpenConversation(
  tenantSlug: string,
  phone: string,
  customerName: string | undefined,
  windowTimeoutMinutes: number,
) {
  const existing = await pool.query<{
    id: string
    assistant_enabled: boolean
    human_override: boolean
  }>(
    `SELECT id, assistant_enabled, human_override FROM assistant_ia.conversations
     WHERE tenant_id = $1 AND phone = $2 AND status != 'fechada'
       AND last_message_at > now() - ($3 || ' minutes')::interval
     ORDER BY last_message_at DESC LIMIT 1`,
    [tenantSlug, phone, windowTimeoutMinutes],
  )
  if (existing.rows.length > 0) return existing.rows[0]

  // Fecha qualquer janela velha que passou do timeout, antes de abrir uma nova.
  await pool.query(
    `UPDATE assistant_ia.conversations SET status = 'fechada', closed_at = now()
     WHERE tenant_id = $1 AND phone = $2 AND status != 'fechada'`,
    [tenantSlug, phone],
  )
  const created = await pool.query<{ id: string; assistant_enabled: boolean; human_override: boolean }>(
    `INSERT INTO assistant_ia.conversations (tenant_id, phone, customer_name)
     VALUES ($1, $2, $3) RETURNING id, assistant_enabled, human_override`,
    [tenantSlug, phone, customerName ?? null],
  )
  return created.rows[0]
}
