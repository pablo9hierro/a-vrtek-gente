import { Router } from 'express'
import { pool } from '../db/pool.js'
import { checkAssistantAccess } from '../services/access.js'
import { runPipeline, MSG_SPLIT_MARKER, INTERNAL_PROMPT_VERSION, type AssistantConfig } from '../agents/pipeline.js'
import { sendWhatsappMessage } from '../evolution-adapter/send.js'
import { transcribeAudio } from '../agents/transcription.js'

export const webhookRouter = Router()

/**
 * BUG-019 (rede de segurança): o prompt já proíbe markdown de link/imagem,
 * mas LLM às vezes ignora instrução -- WhatsApp não renderiza
 * `[texto](url)` nem `![alt](url)`, aparece literal e quebrado pro
 * cliente. Corrige na saída, sempre, antes de qualquer envio real.
 */
function sanitizeForWhatsapp(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]+\)\s*/g, '') // imagem markdown -> some (nunca deveria estar na resposta pro cliente)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2') // link markdown -> "texto: url" (WhatsApp deixa a URL clicável sozinho)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeForKeywordMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos (ola/olá batem igual)
}

/**
 * BUG-019: start_keywords/end_keywords eram comparados com `.includes()`
 * (substring cru) -- uma keyword de 2-3 letras como "oi" batia dentro de
 * QUALQUER palavra que contivesse essa sequência, mesmo sem ser a palavra
 * inteira: "depois", "noite", "apoio" todas contêm "oi". Isso disparava o
 * atendimento (ou reabria depois de "encerrar") em mensagens que não
 * tinham nenhuma saudação/gatilho real. Agora exige a palavra inteira
 * (fronteira de palavra), não só a sequência de caracteres em qualquer
 * lugar do texto.
 */
function matchesKeyword(text: string, keywords: string[] | null | undefined): boolean {
  if (!keywords?.length) return false
  const normalizedText = normalizeForKeywordMatch(text)
  return keywords.some((kw) => {
    const nkw = normalizeForKeywordMatch(kw.trim())
    if (!nkw) return false
    // Keyword pode ser uma frase ("quero comprar") -- escapa regex e usa
    // fronteira de palavra nas duas pontas da frase inteira.
    const escaped = nkw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, 'i').test(normalizedText)
  })
}

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
   * true = mensagem escrita pela PRÓPRIA loja (lojista respondendo na mão
   * pelo WhatsApp dele, com ou sem a IA interrompida em /admin/chat). Entra
   * no histórico como sender_type=humano e NUNCA aciona a IA — serve só pra
   * manter o contexto da conversa completo, pra IA enxergar tudo que foi
   * combinado se voltar a atender depois.
   */
  from_lojista?: boolean
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

/**
 * POST /webhook/presence — cliente digitando/gravando áudio no WhatsApp
 * (encaminhado pelo ecommerce-api). Se já existe um lote pendente pra essa
 * conversa (mensagem de texto aguardando o debounce normal), estende o
 * timer pela janela de tolerância inteira de novo -- efeito prático:
 * enquanto o cliente continuar sinalizando que está digitando, a resposta
 * não sai. Sem lote pendente (cliente só digitando, ainda não mandou nada)
 * não há o que segurar, ignora.
 */
webhookRouter.post('/presence', async (req, res) => {
  res.status(200).json({ ok: true })
  try {
    const { tenant_slug: tenantSlug, phone } = req.body as { tenant_slug?: string; phone?: string }
    if (!tenantSlug || !phone) return
    const configRes = await pool.query<AssistantConfig>(
      `SELECT message_batch_window_seconds FROM assistant_ia.assistant_config WHERE tenant_id = $1`,
      [tenantSlug],
    )
    const debounceMs = configRes.rows[0]?.message_batch_window_seconds
      ? configRes.rows[0].message_batch_window_seconds * 1000
      : DEFAULT_DEBOUNCE_MS
    const conv = await pool.query<{ id: string }>(
      `SELECT id FROM assistant_ia.conversations
       WHERE tenant_id = $1 AND phone = $2 AND status != 'fechada'
       ORDER BY last_message_at DESC LIMIT 1`,
      [tenantSlug, phone],
    )
    const conversationId = conv.rows[0]?.id
    if (!conversationId) return
    const pending = pendingBatches.get(conversationId)
    if (!pending) return // nada aguardando resposta ainda, não há o que estender
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => void processBatch(conversationId, pending.config), debounceMs)
  } catch (e) {
    console.error('erro processando presence.update:', e)
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
  config: AssistantConfig
}

// Cliente que manda várias mensagens em sequência (comum no WhatsApp) não
// deve gerar uma resposta por mensagem — junta tudo que chegar dentro de
// uma janela de 3s numa mensagem só antes de rodar o pipeline. Estado em
// memória (só uma instância do serviço rodando no beta); se escalar pra
// múltiplas instâncias depois, isso precisa virar algo compartilhado
// (Redis, ou sticky routing por telefone).
const pendingBatches = new Map<string, PendingBatch>()

async function handleInbound(payload: ForwardedEvolutionPayload) {
  const { tenant_slug: tenantSlug, instance, phone, text: rawText, audio_base64: audioBase64, audio_mimetype: audioMimetype, customer_name: customerNameRaw, simulated, from_lojista: fromLojista } = payload
  if (!tenantSlug || !phone) return
  if (!rawText && !audioBase64) return
  const access = await checkAssistantAccess(tenantSlug)
  if (!access.allowed) return // sem acesso ao assistente (fora do plano/sem add-on), ignora silenciosamente
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

  // Mensagem escrita pela própria loja: entra no histórico como 'humano' e
  // para por aqui — nunca aciona a IA, nunca abre conversa nova (uma
  // mensagem da loja pra alguém sem atendimento em curso não é atendimento).
  if (fromLojista) {
    await recordLojistaMessage(tenantSlug, phone, text)
    return
  }

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

  const encerramento = matchesKeyword(text, config.end_keywords)
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
    config: args.config,
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
    const replyParts = result.reply
      .split(MSG_SPLIT_MARKER)
      .map((p) => sanitizeForWhatsapp(p.trim()))
      .filter(Boolean)
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

/**
 * Grava no histórico uma mensagem que a LOJA mandou (lojista digitando no
 * WhatsApp dele), pra IA ter o contexto completo do que foi combinado
 * enquanto ela estava fora — seja porque o lojista interrompeu o
 * atendimento em /admin/chat, seja porque ele só respondeu por cima.
 *
 * A própria IA envia pela mesma instância da Evolution, então TODA resposta
 * dela também volta como fromMe — sem deduplicar, cada resposta da IA
 * seria gravada duas vezes (uma como 'assistente', outra como 'humano').
 * Por isso ignora o eco: mensagem idêntica (ou contida) numa resposta da
 * assistente nos últimos 5 minutos nessa mesma conversa. Resposta com
 * Pix/link sai partida em duas mensagens (MSG_SPLIT_MARKER) mas é gravada
 * junta, então o eco de cada parte casa por `position(...)`, não por
 * igualdade — daí o LIKE. Texto curto (< 20 chars) exige igualdade exata,
 * senão um "ok" do lojista sumiria por acaso dentro de qualquer resposta.
 */
async function recordLojistaMessage(tenantSlug: string, phone: string, text: string) {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM assistant_ia.conversations
     WHERE tenant_id = $1 AND phone = $2 AND status != 'fechada'
     ORDER BY last_message_at DESC LIMIT 1`,
    [tenantSlug, phone],
  )
  const conversation = existing.rows[0]
  if (!conversation) return

  const echo = await pool.query<{ id: string }>(
    `SELECT id FROM assistant_ia.messages
     WHERE conversation_id = $1 AND sender_type = 'assistente'
       AND created_at > now() - interval '5 minutes'
       AND (content = $2 OR (length($2) >= 20 AND position($2 in content) > 0))
     LIMIT 1`,
    [conversation.id, text],
  )
  if (echo.rows.length > 0) return // eco do envio da própria IA, não é o lojista

  await pool.query(
    `INSERT INTO assistant_ia.messages (conversation_id, tenant_id, direction, sender_type, content)
     VALUES ($1, $2, 'outbound', 'humano', $3)`,
    [conversation.id, tenantSlug, text],
  )
  await pool.query(`UPDATE assistant_ia.conversations SET last_message_at = now() WHERE id = $1`, [conversation.id])
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
  const iniciou = simulated || matchesKeyword(text, startKeywords)
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
