import { Router } from 'express'
import { pool } from '../db/pool.js'
import { isBetaTenant } from '../services/beta.js'

export const conversationsRouter = Router()

function betaGate(req: any, res: any, next: any) {
  if (!isBetaTenant(String(req.params.tenantSlug || ''))) {
    res.status(404).json({ error: 'Assistente IA não disponível pra essa loja ainda.' })
    return
  }
  next()
}

conversationsRouter.get('/:tenantSlug/conversations', betaGate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, phone, customer_name, status, assistant_enabled, human_override, started_at, last_message_at, closed_at
     FROM assistant_ia.conversations WHERE tenant_id = $1 ORDER BY last_message_at DESC LIMIT 100`,
    [req.params.tenantSlug],
  )
  res.json(rows)
})

conversationsRouter.get('/:tenantSlug/conversations/:id/messages', betaGate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, direction, sender_type, content, created_at
     FROM assistant_ia.messages WHERE conversation_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
    [req.params.id, req.params.tenantSlug],
  )
  res.json(rows)
})

/** Apaga o histórico de uma conversa (mensagens e decisões dos agentes vão junto via ON DELETE CASCADE). */
conversationsRouter.delete('/:tenantSlug/conversations/:id', betaGate, async (req, res) => {
  const result = await pool.query(`DELETE FROM assistant_ia.conversations WHERE id = $1 AND tenant_id = $2`, [
    req.params.id,
    req.params.tenantSlug,
  ])
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Conversa não encontrada.' })
    return
  }
  res.status(204).end()
})

/** Interromper/retomar o assistente NUMA conversa específica (não afeta o resto da loja). */
conversationsRouter.put('/:tenantSlug/conversations/:id/assistant-enabled', betaGate, async (req, res) => {
  const enabled = Boolean(req.body?.enabled)
  const { rows } = await pool.query(
    `UPDATE assistant_ia.conversations SET assistant_enabled = $1, human_override = NOT $1
     WHERE id = $2 AND tenant_id = $3 RETURNING id, assistant_enabled, human_override`,
    [enabled, req.params.id, req.params.tenantSlug],
  )
  if (rows.length === 0) {
    res.status(404).json({ error: 'Conversa não encontrada.' })
    return
  }
  res.json(rows[0])
})
