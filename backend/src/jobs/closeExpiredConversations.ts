import { pool } from '../db/pool.js'

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

export async function closeExpiredConversationsOnce(): Promise<number> {
  // O timeout é por tenant, então o JOIN com assistant_config é o que
  // decide o prazo de cada conversa — não existe valor global aqui.
  // COALESCE cobre tenant sem config salva (usa o mesmo default 30 do schema).
  const { rowCount } = await pool.query(
    `UPDATE assistant_ia.conversations c
        SET status = 'fechada', closed_at = now()
       FROM assistant_ia.assistant_config cfg
      WHERE cfg.tenant_id = c.tenant_id
        AND c.status <> 'fechada'
        AND c.last_message_at < now() - (COALESCE(cfg.window_timeout_minutes, 30) || ' minutes')::interval`,
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
