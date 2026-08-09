import Anthropic from '@anthropic-ai/sdk'
import { pool } from '../db/pool.js'

const anthropic = new Anthropic() // lê ANTHROPIC_API_KEY do ambiente

export type AssistantConfig = {
  tenant_id: string
  enabled: boolean
  prompt_interpreter: string
  prompt_validator: string
  prompt_supervisor: string
  start_keywords: string[]
  end_keywords: string[]
  window_timeout_minutes: number
}

type InterpreterOutput = {
  intent: string
  params: Record<string, unknown>
}

type ValidatorOutput = {
  intent: string
  agrees: boolean
  note?: string
}

/** IA 1 — interpreta a mensagem e decide a intenção, sem responder direto. */
async function runInterpreter(config: AssistantConfig, userMessage: string): Promise<InterpreterOutput> {
  const system = [
    config.prompt_interpreter ||
      'Você é a camada de interpretação de um assistente de atendimento via WhatsApp. Leia a mensagem do cliente e identifique a intenção dele.',
    'Responda APENAS com um JSON no formato {"intent": "...", "params": {...}}.',
    'Intenções possíveis: consultar_pedido, rastrear_entrega, consultar_catalogo, duvida_loja, calcular_frete, encaminhar_humano, buscar_cupom, buscar_produto, horario_funcionamento, pedir_esclarecimento, outro.',
  ].join('\n')

  const res = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: userMessage }],
  })
  const text = res.content.find((b) => b.type === 'text')?.text ?? '{}'
  return safeParseJson<InterpreterOutput>(text, { intent: 'outro', params: {} })
}

/** IA 2 — revisa a decisão da IA 1 de forma independente (não só repete). */
async function runValidator(
  config: AssistantConfig,
  userMessage: string,
  interpreterOutput: InterpreterOutput,
): Promise<ValidatorOutput> {
  const system = [
    config.prompt_validator ||
      'Você é a camada de validação de um assistente de atendimento. Releia a mensagem do cliente de forma independente, sem confiar cegamente na intenção sugerida, e confirme ou corrija.',
    'Responda APENAS com um JSON no formato {"intent": "...", "agrees": true|false, "note": "..."}.',
  ].join('\n')

  const res = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 512,
    system,
    messages: [
      {
        role: 'user',
        content: `Mensagem do cliente: "${userMessage}"\nIntenção sugerida pela camada anterior: ${JSON.stringify(interpreterOutput)}`,
      },
    ],
  })
  const text = res.content.find((b) => b.type === 'text')?.text ?? '{}'
  return safeParseJson<ValidatorOutput>(text, { intent: interpreterOutput.intent, agrees: true })
}

/** IA 3 — supervisor de contexto: lê o histórico do chat inteiro + RAG e gera a resposta final. */
async function runSupervisor(
  config: AssistantConfig,
  history: { sender_type: string; content: string }[],
  userMessage: string,
  interpreterOutput: InterpreterOutput,
  validatorOutput: ValidatorOutput,
  ragContext: string,
): Promise<string> {
  const system = [
    config.prompt_supervisor ||
      'Você é o supervisor de contexto de um assistente de atendimento via WhatsApp de uma loja. Gere a resposta final para o cliente, considerando todo o histórico da conversa e a base de conhecimento da loja.',
    ragContext ? `Base de conhecimento da loja (use quando relevante):\n${ragContext}` : '',
    `Intenção identificada: ${validatorOutput.intent}${validatorOutput.agrees ? '' : ` (revisor discordou: ${validatorOutput.note ?? ''})`}`,
    'Responda em texto puro, direto, no tom de uma loja atendendo cliente pelo WhatsApp. Não invente informação que não está no contexto — se não souber, diga que vai verificar e chamar um atendente humano.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const conversationMessages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.sender_type === 'cliente' ? 'user' : 'assistant',
    content: m.content,
  }))
  conversationMessages.push({ role: 'user', content: userMessage })

  const res = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system,
    messages: conversationMessages,
  })
  return res.content.find((b) => b.type === 'text')?.text ?? 'Desculpa, não consegui gerar uma resposta agora — já chamo alguém pra te ajudar.'
}

function safeParseJson<T>(text: string, fallback: T): T {
  try {
    const match = text.match(/\{[\s\S]*\}/)
    return match ? { ...fallback, ...JSON.parse(match[0]) } : fallback
  } catch {
    return fallback
  }
}

async function searchRag(tenantId: string, query: string): Promise<string> {
  const { rows } = await pool.query<{ content: string }>(
    `SELECT content FROM assistant_ia.rag_chunks
     WHERE tenant_id = $1 AND content_tsv @@ plainto_tsquery('portuguese', $2)
     ORDER BY ts_rank(content_tsv, plainto_tsquery('portuguese', $2)) DESC
     LIMIT 5`,
    [tenantId, query],
  )
  return rows.map((r) => r.content).join('\n---\n')
}

export type PipelineResult = {
  reply: string
  interpreterOutput: InterpreterOutput
  validatorOutput: ValidatorOutput
}

/**
 * Roda o pipeline completo (IA1 -> IA2 -> IA3). Não persiste nada — o
 * chamador (routes/webhook.ts) insere a mensagem de saída e só depois grava
 * as decisões em agent_decisions, porque essa tabela referencia message_id
 * (que só existe depois de inserir a mensagem).
 */
export async function runPipeline(
  config: AssistantConfig,
  history: { sender_type: string; content: string }[],
  userMessage: string,
): Promise<PipelineResult> {
  const interpreterOutput = await runInterpreter(config, userMessage)
  const validatorOutput = await runValidator(config, userMessage, interpreterOutput)
  const ragContext = await searchRag(config.tenant_id, userMessage)
  const reply = await runSupervisor(config, history, userMessage, interpreterOutput, validatorOutput, ragContext)
  return { reply, interpreterOutput, validatorOutput }
}
