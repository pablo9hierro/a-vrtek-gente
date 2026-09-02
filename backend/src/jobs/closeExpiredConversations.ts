import { pool } from '../db/pool.js'

const ECOMMERCE_API_URL = process.env.ECOMMERCE_API_URL || 'https://ecommerce-api-production-d447.up.railway.app'

/**
 * Fecha ativamente conversa que passou do tempo limite sem interação
 * (`assistant_config.window_timeout_minutes`, por tenant).
 *
 * Antes disso o encerramento era PREGUIÇOSO: a janela só era marcada
 * `fechada` quando o MESMO cliente mandava uma mensagem nova (ver
 * findOrOpenConversation em routes/webhook.ts, que fechava a janela velha
 * só na hora de abrir a próxima). Cliente que simplesmente sumia deixava a
 * conversa "aberta" pra sempre: aparecia em atendimento no /admin/chat sem
 * nunca encerrar, e `closed_at` ficava NULL eternamente.
 *
 * Roda um tick por minuto — mesmo padrão dos workers do ecommerce-api
 * (appointment_reminders.rs / order_expiration.rs).
 */
const TICK_MS = 60_000

// Pedido em andamento = qualquer status que não seja terminal.
const ORDER_TERMINAL_STATUSES = new Set(['concluido', 'cancelado'])
// Agendamento em andamento = status 'agendado' (ver 0023_service_appointments.sql).
const APPOINTMENT_IN_PROGRESS = 'agendado'

/** Só chamado pra conversas que JÁ passaram do timeout — nunca pra todas as
 * conversas abertas, então o custo extra de HTTP fica raro na prática. */
async function hasAttendanceInProgress(tenantSlug: string, phone: string): Promise<boolean> {
  try {
    const [ordersRes, apptsRes] = await Promise.all([
      fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${encodeURIComponent(tenantSlug)}/orders-by-phone/${encodeURIComponent(phone)}`),
      fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${encodeURIComponent(tenantSlug)}/appointments/by-phone/${encodeURIComponent(phone)}`),
    ])
    if (ordersRes.ok) {
      const orders = (await ordersRes.json()) as { status?: string }[]
      if (Array.isArray(orders) && orders.some((o) => o.status && !ORDER_TERMINAL_STATUSES.has(o.status))) return true
    }
    if (apptsRes.ok) {
      const appts = (await apptsRes.json()) as { status?: string }[]
      if (Array.isArray(appts) && appts.some((a) => a.status === APPOINTMENT_IN_PROGRESS)) return true
    }
  } catch (e) {
    // Falha de rede não deve travar conversa fechando pra sempre nem deixar
    // aberta pra sempre — na dúvida, NÃO fecha agora (tenta de novo no
    // próximo tick, 60s depois, é barato e mais seguro que fechar errado
    // no meio de um pedido real).
    console.error('[janela] falha ao checar pedido/agendamento em andamento:', tenantSlug, e)
    return true
  }
  return false
}

export async function closeExpiredConversationsOnce(): Promise<number> {
  // O timeout é por tenant, então o JOIN com assistant_config é o que
  // decide o prazo de cada conversa — não existe valor global aqui.
  // COALESCE cobre tenant sem config salva (usa o mesmo default 30 do schema).
  const { rows: candidates } = await pool.query<{ id: string; tenant_id: string; phone: string }>(
    `SELECT c.id, c.tenant_id, c.phone
       FROM assistant_ia.conversations c
       JOIN assistant_ia.assistant_config cfg ON cfg.tenant_id = c.tenant_id
      WHERE c.status <> 'fechada'
        AND c.last_message_at < now() - (COALESCE(cfg.window_timeout_minutes, 30) || ' minutes')::interval`,
  )
  if (candidates.length === 0) return 0

  const idsToClose: string[] = []
  for (const c of candidates) {
    const inProgress = await hasAttendanceInProgress(c.tenant_id, c.phone)
    if (!inProgress) idsToClose.push(c.id)
  }
  if (idsToClose.length === 0) return 0

  const { rowCount } = await pool.query(
    `UPDATE assistant_ia.conversations SET status = 'fechada', closed_at = now() WHERE id = ANY($1::uuid[])`,
    [idsToClose],
  )
  return rowCount ?? 0
}

export function startCloseExpiredConversationsJob() {
  const run = async () => {
    try {
      const fechadas = await closeExpiredConversationsOnce()
      if (fechadas > 0) console.log(`[janela] ${fechadas} conversa(s) encerrada(s) por inatividade`)
    } catch (e) {
      console.error('[janela] falha ao encerrar conversas expiradas:', e)
    }
  }
  // `unref` pra esse timer não segurar o processo vivo num shutdown.
  setInterval(run, TICK_MS).unref()
  void run()
}
