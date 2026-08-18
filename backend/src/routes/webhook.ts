import { Router } from 'express'
import { pool } from '../db/pool.js'
import { isBetaTenant } from '../services/beta.js'
import { runPipeline, MSG_SPLIT_MARKER, INTERNAL_PROMPT_VERSION, type AssistantConfig } from '../agents/pipeline.js'
import { sendWhatsappMessage } from '../evolution-adapter/send.js'
import { transcribeAudio } from '../agents/transcription.js'

export const webhookRouter = Router()

type ForwardedEvolutionPayload = {
  tenant_slug: string
  instance: string
  phone: string
  /** Ausente quando a mensagem é de áudio (ver audio_base64) — nunca os dois ao mesmo tempo. */
  text?: string
  /** Mensagem de voz recebida no WhatsApp, já baixada em base64 pelo ecommerce-api. */
  audio_base64?: string
  /** Mimetype do áudio (ex: "audio/ogg; codecs=opus") — usado pra transcrever. */
  audio_mimetype?: string
  customer_name?: string
  /**
   * true = veio do botão "Novo Chat"/caixa de mensagem em /admin/chat
   * (ecommerce-api::simulate_assistant_ia_message), não do WhatsApp real.
   * O admin já clicou explicitamente pra simular um cliente — exigir que a
   * PRIMEIRA mensagem bata um start_keyword configurado (regra pensada pra
   * filtrar mensagem solta de desconhecido no WhatsApp de verdade) só
   * deixava "Novo Chat" quebrado sem erro nenhum pra qualquer texto que não
   * fosse literalmente a palavra configurada.
   */
  simulated?: boolean
}

/**
 * Recebe o forward que o backend Rust do Resolutoo faz do webhook da
 * Evolution API. Não é a Evolution chamando aqui diretamente — é o
 * backend existente repassando, já com o texto da mensagem e o tenant
 * resolvido.
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

// Padrão (se o lojista não configurar `message_batch_window_seconds` em
// /meu-plano/assistente-ia) — 3s era curto demais pro ritmo real de
// digitação humana, então o default subiu pra 8s.
const DEFAULT_DEBOUNCE_MS = 8000

type PendingBatch = {
  texts: string[]
  timer: ReturnType<typeof setTimeout>
  tenantSlug: string
  instance: string
  phone: string
  customerName: string | null
  conversationId: string
}

// Cliente que manda várias mensagens em sequência (comum no WhatsApp) não
// deve gerar uma resposta por mensagem — junta tudo que chegar dentro de
// uma janela de 3s numa mensagem só antes de rodar o pipeline. Estado em
// memória (só uma instância do serviço rodando no beta); se escalar pra
// múltiplas instâncias depois, isso precisa virar algo compartilhado
// (Redis, ou sticky routing por telefone).
const pendingBatches = new Map<string, PendingBatch>()

async function handleInbound(payload: ForwardedEvolutionPayload) {
  const { tenant_slug: tenantSlug, instance, phone, text: rawText, audio_base64: audioBase64, audio_mimetype: audioMimetype, customer_name: customerNameRaw, simulated } = payload
  if (!tenantSlug || !phone) return
  if (!rawText && !audioBase64) return
  if (!isBetaTenant(tenantSlug)) return // fora do beta, ignora silenciosamente
  const customerName = customerNameRaw ?? null

  const configRes = await pool.query<AssistantConfig>(
    `SELECT * FROM assistant_ia.assistant_config WHERE tenant_id = $1`,
    [tenantSlug],
  )
  const config = configRes.rows[0]
  if (!config || !config.enabled) return // assistente desligado nessa loja

  let text = rawText
  if (!text && audioBase64) {
    const transcribed = await transcribeAudio(audioBase64, audioMimetype || 'audio/ogg')
    if (!transcribed) {
      console.warn(`transcrição de áudio falhou (OpenAI + Gemini) — tenant=${tenantSlug} phone=${phone}`)
      return // mesmo tratamento de qualquer mídia que hoje não vira mensagem (imagem, sticker, etc)
    }
    text = `[Áudio transcrito]: ${transcribed}`
  }
  if (!text) return

  const conversation = await findOrOpenConversation(
    tenantSlug,
    phone,
    customerName,
    config.window_timeout_minutes,
    text,
    config.start_keywords,
    Boolean(simulated),
  )
  // Sem conversa aberta e a mensagem não bateu nenhum gatilho de início ->
  // ignora por completo (nunca cria conversa, nunca responde). O
  // assistente só atende quem de fato iniciou o atendimento com uma das
  // palavras configuradas em start_keywords.
  if (!conversation) return

  await pool.query(
    `INSERT INTO assistant_ia.messages (conversation_id, tenant_id, direction, sender_type, content)
     VALUES ($1, $2, 'inbound', 'cliente', $3)`,
    [conversation.id, tenantSlug, text],
  )
  await pool.query(`UPDATE assistant_ia.conversations SET last_message_at = now() WHERE id = $1`, [conversation.id])

  // Interrompido manualmente nessa conversa (ou globalmente) -> não chama a IA,
  // fica esperando atendimento humano. Histórico já foi salvo acima.
  if (!conversation.assistant_enabled || conversation.human_override) return

  const encerramento = (config.end_keywords ?? []).some((kw) => text.toLowerCase().includes(kw.toLowerCase()))
  if (encerramento) {
    cancelPendingBatch(conversation.id)
    await pool.query(`UPDATE assistant_ia.conversations SET status = 'fechada', closed_at = now() WHERE id = $1`, [
      conversation.id,
    ])
    return
  }

  scheduleDebouncedReply(conversation.id, { tenantSlug, instance, phone, customerName, text, config })
}

function cancelPendingBatch(conversationId: string) {
  const pending = pendingBatches.get(conversationId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingBatches.delete(conversationId)
  }
}

function scheduleDebouncedReply(
  conversationId: string,
  args: {
    tenantSlug: string
    instance: string
    phone: string
    customerName: string | null
    text: string
    config: AssistantConfig
  },
) {
  const debounceMs = args.config.message_batch_window_seconds
    ? args.config.message_batch_window_seconds * 1000
    : DEFAULT_DEBOUNCE_MS
  const existing = pendingBatches.get(conversationId)
  if (existing) {
    clearTimeout(existing.timer)
    existing.texts.push(args.text)
    existing.timer = setTimeout(() => void processBatch(conversationId, args.config), debounceMs)
    return
  }
  const batch: PendingBatch = {
    texts: [args.text],
    tenantSlug: args.tenantSlug,
    instance: args.instance,
    phone: args.phone,
    customerName: args.customerName,
    conversationId,
    timer: setTimeout(() => void processBatch(conversationId, args.config), debounceMs),
  }
  pendingBatches.set(conversationId, batch)
}

async function processBatch(conversationId: string, config: AssistantConfig) {
  const batch = pendingBatches.get(conversationId)
  if (!batch) return
  pendingBatches.delete(conversationId)

  // Várias mensagens em sequência viram uma mensagem só pra interpretação
  // das camadas de IA — o histórico já guarda cada uma separada, isso é
  // só o texto que entra no pipeline.
  const joinedText = batch.texts.join('\n')

  try {
    const historyRes = await pool.query<{ sender_type: string; content: string }>(
      `SELECT sender_type, content FROM assistant_ia.messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 30`,
      [conversationId],
    )

    const result = await runPipeline(config, historyRes.rows, joinedText, batch.phone, batch.customerName, batch.instance)

    // Código Pix/link de pagamento vem separado do aviso por um marcador
    // (ver MSG_SPLIT_MARKER) — cada lado vira uma mensagem própria no
    // WhatsApp, pro cliente conseguir copiar/tocar o código sozinho, sem
    // texto grudado. O histórico salva o texto completo (com quebra de
    // linha no lugar do marcador), só o ENVIO real que sai em duas partes.
    const replyParts = result.reply.split(MSG_SPLIT_MARKER).map((p) => p.trim()).filter(Boolean)
    const storedContent = replyParts.join('\n\n')

    const outboundMessage = await pool.query<{ id: string }>(
      `INSERT INTO assistant_ia.messages (conversation_id, tenant_id, direction, sender_type, content)
       VALUES ($1, $2, 'outbound', 'assistente', $3) RETURNING id`,
      [conversationId, batch.tenantSlug, storedContent],
    )
    await pool.query(
      `INSERT INTO assistant_ia.agent_decisions (message_id, tenant_id, layer, output) VALUES
         ($1, $2, 'interpreter', $3), ($1, $2, 'validator', $4)`,
      [
        outboundMessage.rows[0].id,
        batch.tenantSlug,
        result.interpreterOutput,
        { tool_calls: result.toolCalls, internal_prompt_version: INTERNAL_PROMPT_VERSION },
      ],
    )
    await pool.query(`UPDATE assistant_ia.conversations SET last_message_at = now() WHERE id = $1`, [conversationId])

    for (const part of replyParts) {
      await sendWhatsappMessage(batch.instance, batch.phone, part)
    }
  } catch (e) {
    console.error('erro processando lote de mensagens debounced:', e)
  }
}

async function findOrOpenConversation(
  tenantSlug: string,
  phone: string,
  customerName: string | null,
  windowTimeoutMinutes: number,
  text: string,
  startKeywords: string[],
  simulated: boolean,
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

  // Sem janela aberta -> só inicia atendimento se essa mensagem bater um
  // dos gatilhos de início configurados. Qualquer outra mensagem "do
  // nada" (sem conversa em curso) é ignorada por completo — EXCETO
  // mensagem simulada pelo admin ("Novo Chat"), que já é um pedido
  // explícito de abrir uma conversa de teste, não uma mensagem solta de
  // desconhecido no WhatsApp real.
  const iniciou = simulated || (startKeywords ?? []).some((kw) => text.toLowerCase().includes(kw.toLowerCase()))
  if (!iniciou) return null

  // Fecha qualquer janela velha que passou do timeout, antes de abrir uma nova.
  await pool.query(
    `UPDATE assistant_ia.conversations SET status = 'fechada', closed_at = now()
     WHERE tenant_id = $1 AND phone = $2 AND status != 'fechada'`,
    [tenantSlug, phone],
  )
  const created = await pool.query<{ id: string; assistant_enabled: boolean; human_override: boolean }>(
    `INSERT INTO assistant_ia.conversations (tenant_id, phone, customer_name)
     VALUES ($1, $2, $3) RETURNING id, assistant_enabled, human_override`,
    [tenantSlug, phone, customerName],
  )
  return created.rows[0]
}
