import Anthropic from '@anthropic-ai/sdk'
import { tools, executeTool } from './tools.js'
import type { AssistantConfig } from './pipeline.js'

const defaultAnthropic = new Anthropic() // lê ANTHROPIC_API_KEY do ambiente

export type ToolCallRecord = { tool: string; input: unknown; output: string }
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ToolCtx = { tenantSlug: string; phone: string; customerName: string | null }

/**
 * Chama a IA e resolve tool calling — abstrai o provedor (Anthropic ou
 * OpenRouter) por trás de uma única assinatura, pra `pipeline.ts` nunca
 * precisar saber qual dos dois está em uso. `history` é a conversa (sem
 * incluir `userMessage`, que entra à parte).
 */
export async function completeWithTools(
  config: AssistantConfig,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  if (config.ai_provider === 'openrouter') {
    return completeWithToolsOpenRouter(config, system, history, userMessage, toolCtx)
  }
  return completeWithToolsAnthropic(config, system, history, userMessage, toolCtx)
}

/** Sem ferramentas — usado só pela IA 1 (interpretação de intenção). */
export async function completeSimple(config: AssistantConfig, system: string, userMessage: string): Promise<string> {
  if (config.ai_provider === 'openrouter') {
    const res = await openRouterFetch(config, {
      model: openRouterModel(config),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
    })
    return res.choices?.[0]?.message?.content ?? ''
  }
  const client = anthropicClient(config)
  const res = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: userMessage }],
  })
  return res.content.find((b) => b.type === 'text')?.text ?? ''
}

function anthropicClient(config: AssistantConfig): Anthropic {
  const key = config.anthropic_api_key?.trim()
  return key ? new Anthropic({ apiKey: key }) : defaultAnthropic
}

async function completeWithToolsAnthropic(
  config: AssistantConfig,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const client = anthropicClient(config)
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }))
  messages.push({ role: 'user', content: userMessage })

  const toolCalls: ToolCallRecord[] = []
  let finalText = ''
  for (let i = 0; i < 4; i++) {
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system,
      tools,
      messages,
    })
    if (res.stop_reason !== 'tool_use') {
      finalText = res.content.find((b) => b.type === 'text')?.text ?? ''
      break
    }
    messages.push({ role: 'assistant', content: res.content })
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue
      const output = await executeTool(block.name, block.input as Record<string, unknown>, toolCtx)
      toolCalls.push({ tool: block.name, input: block.input, output })
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output })
    }
    messages.push({ role: 'user', content: toolResults })
  }
  return { reply: finalText, toolCalls }
}

// ---------- OpenRouter (formato compatível com a API de chat da OpenAI) ----------

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

function openRouterModel(config: AssistantConfig): string {
  return config.ai_model?.trim() || 'anthropic/claude-3.5-sonnet'
}

type OrToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type OrMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OrToolCall[]
  tool_call_id?: string
}
type OrResponse = {
  choices?: { message: OrMessage; finish_reason: string }[]
}

async function openRouterFetch(config: AssistantConfig, body: Record<string, unknown>): Promise<OrResponse> {
  const key = config.anthropic_api_key?.trim()
  if (!key) throw new Error('chave da OpenRouter não configurada pra essa loja')
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`openrouter retornou ${res.status}: ${text}`)
  }
  return (await res.json()) as OrResponse
}

/** Mesmo formato de `tools` (Anthropic) convertido pra "function calling" da OpenAI, que a OpenRouter espera. */
const openRouterTools = tools.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))

async function completeWithToolsOpenRouter(
  config: AssistantConfig,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const messages: OrMessage[] = [
    { role: 'system', content: system },
    ...history.map((m): OrMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  const toolCalls: ToolCallRecord[] = []
  let finalText = ''
  for (let i = 0; i < 4; i++) {
    const res = await openRouterFetch(config, {
      model: openRouterModel(config),
      messages,
      tools: openRouterTools,
    })
    const choice = res.choices?.[0]
    const message = choice?.message
    if (!message?.tool_calls?.length) {
      finalText = message?.content ?? ''
      break
    }
    messages.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls })
    for (const call of message.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(call.function.arguments)
      } catch {
        // argumentos malformados — segue com objeto vazio, a tool trata a ausência de campos
      }
      const output = await executeTool(call.function.name, input, toolCtx)
      toolCalls.push({ tool: call.function.name, input, output })
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }
  return { reply: finalText, toolCalls }
}
