import { pool } from '../db/pool.js'

// Anthropic removida por decisão explícita do dono da plataforma — a
// chave da Anthropic console não é mais usada em lugar nenhum. Só os dois
// provedores abaixo, ambos "OpenAI-compatible" (mesmo formato de chat
// completions + function calling), são suportados.
export type PlatformAiProvider = 'openai' | 'openrouter'

export type PlatformEngine = {
  id: string
  label: string
  provider: PlatformAiProvider
  model: string
  priority: number
  enabled: boolean
}

/**
 * Motores de IA da plataforma, em ordem de prioridade (1 = tentado
 * primeiro) — controlados pelo dono da plataforma via painel superadmin
 * (não pelo lojista). `completeWithTools`/`completeSimple` (aiClient.ts)
 * tentam cada um destes em ordem até um responder com sucesso; se todos
 * falharem, propaga o erro do último.
 */
export async function getEnabledPlatformEngines(): Promise<PlatformEngine[]> {
  const { rows } = await pool.query<PlatformEngine>(
    `SELECT id, label, provider, model, priority, enabled
     FROM assistant_ia.platform_ai_engines
     WHERE enabled = true
     ORDER BY priority ASC`,
  )
  return rows
}

export async function listAllPlatformEngines(): Promise<PlatformEngine[]> {
  const { rows } = await pool.query<PlatformEngine>(
    `SELECT id, label, provider, model, priority, enabled
     FROM assistant_ia.platform_ai_engines
     ORDER BY priority ASC`,
  )
  return rows
}

export async function createPlatformEngine(label: string, provider: PlatformAiProvider, model: string): Promise<PlatformEngine> {
  const { rows } = await pool.query<PlatformEngine>(
    `INSERT INTO assistant_ia.platform_ai_engines (label, provider, model, priority, enabled)
     VALUES ($1, $2, $3, COALESCE((SELECT MAX(priority) FROM assistant_ia.platform_ai_engines), 0) + 1, true)
     RETURNING id, label, provider, model, priority, enabled`,
    [label, provider, model],
  )
  return rows[0]
}

export async function updatePlatformEngine(
  id: string,
  patch: { label?: string; model?: string; enabled?: boolean },
): Promise<PlatformEngine | null> {
  const { rows } = await pool.query<PlatformEngine>(
    `UPDATE assistant_ia.platform_ai_engines SET
       label = COALESCE($2, label),
       model = COALESCE($3, model),
       enabled = COALESCE($4, enabled),
       updated_at = now()
     WHERE id = $1
     RETURNING id, label, provider, model, priority, enabled`,
    [id, patch.label ?? null, patch.model ?? null, patch.enabled ?? null],
  )
  return rows[0] ?? null
}

export async function deletePlatformEngine(id: string): Promise<void> {
  await pool.query(`DELETE FROM assistant_ia.platform_ai_engines WHERE id = $1`, [id])
}

/** Reordena a lista inteira — `orderedIds` já vem na ordem de prioridade desejada (índice 0 = priority 1). */
export async function reorderPlatformEngines(orderedIds: string[]): Promise<PlatformEngine[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Passo intermediário (prioridades negativas) evita colisão com a
    // constraint UNIQUE(priority) enquanto reordena em cima da mesma linha.
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE assistant_ia.platform_ai_engines SET priority = $2, updated_at = now() WHERE id = $1`, [
        orderedIds[i],
        -(i + 1),
      ])
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE assistant_ia.platform_ai_engines SET priority = $2 WHERE id = $1`, [orderedIds[i], i + 1])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  return listAllPlatformEngines()
}
