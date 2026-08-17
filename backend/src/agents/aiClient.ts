import Anthropic from '@anthropic-ai/sdk'
import { tools, executeTool } from './tools.js'
import type { AssistantConfig } from './pipeline.js'

const defaultAnthropic = new Anthropic() // lê ANTHROPIC_API_KEY do ambiente

export type ToolCallRecord = { tool: string; input: unknown; output: string }
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ToolCtx = { tenantSlug: string; phone: string; customerName: string | null; instance: string }

/**
 * Chama a IA e resolve tool calling — abstrai o provedor (Anthropic,
 * OpenAI ou OpenRouter) por trás de uma única assinatura, pra
 * `pipeline.ts` nunca precisar saber qual dos três está em uso. `history`
 * é a conversa (sem incluir `userMessage`, que entra à parte).
 */
export async function completeWithTools(
  config: AssistantConfig,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  if (config.ai_provider === 'openrouter') {
    return completeWithToolsOpenAiCompatible(config, OPENROUTER_URL, 'anthropic/claude-3.5-sonnet', system, history, userMessage, toolCtx)
  }
  if (config.ai_provider === 'openai') {
    return completeWithToolsOpenAiCompatible(config, OPENAI_URL, 'gpt-4o-mini', system, history, userMessage, toolCtx)
  }
  return completeWithToolsAnthropic(config, system, history, userMessage, toolCtx)
}

/** Sem ferramentas — usado só pela IA 1 (interpretação de intenção). */
export async function completeSimple(config: AssistantConfig, system: string, userMessage: string): Promise<string> {
  if (config.ai_provider === 'openrouter' || config.ai_provider === 'openai') {
    const url = config.ai_provider === 'openai' ? OPENAI_URL : OPENROUTER_URL
    const defaultModel = config.ai_provider === 'openai' ? 'gpt-4o-mini' : 'anthropic/claude-3.5-sonnet'
    const res = await openAiCompatibleFetch(config, url, {
      model: config.ai_model?.trim() || defaultModel,
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
  // O mesmo campo guarda a chave de qualquer provedor escolhido — se o
  // lojista trocou de outro provedor pra Anthropic sem limpar o campo, a
  // chave antiga não tem o formato certo (sk-ant-...) e quebraria com
  // 401; nesse caso ignora e cai no fallback global, em vez de falhar.
  return key && key.startsWith('sk-ant-') ? new Anthropic({ apiKey: key }) : defaultAnthropic
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
  for (let i = 0; i < 6; i++) {
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system,
      tools,
      // Regra de negócio: toda resposta precisa vir de pelo menos 1 tool
      // call real — nunca responder "de memória"/genérico sem ter
      // consultado nada. Só força na 1ª rodada; depois de já ter pelo
      // menos um resultado de ferramenta, o modelo decide livremente se
      // precisa de mais alguma (pode encadear quantas quiser) ou já
      // responder o texto final.
      ...(i === 0 ? { tool_choice: { type: 'any' as const } } : {}),
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

// ---------- OpenAI / OpenRouter (mesmo formato de chat completions + function calling) ----------

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

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

async function openAiCompatibleFetch(config: AssistantConfig, url: string, body: Record<string, unknown>): Promise<OrResponse> {
  const key = config.anthropic_api_key?.trim()
  if (!key) throw new Error(`chave da API não configurada pra essa loja (provedor: ${config.ai_provider})`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${config.ai_provider} retornou ${res.status}: ${text}`)
  }
  return (await res.json()) as OrResponse
}

/** Mesmo formato de `tools` (Anthropic) convertido pra "function calling" da OpenAI — usado tanto pra OpenAI quanto OpenRouter (mesmo schema). */
const openAiTools = tools.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))

async function completeWithToolsOpenAiCompatible(
  config: AssistantConfig,
  url: string,
  defaultModel: string,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const model = config.ai_model?.trim() || defaultModel
  const messages: OrMessage[] = [
    { role: 'system', content: system },
    ...history.map((m): OrMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  const toolCalls: ToolCallRecord[] = []
  let finalText = ''
  for (let i = 0; i < 6; i++) {
    const res = await openAiCompatibleFetch(config, url, {
      model,
      messages,
      tools: openAiTools,
      // Mesma regra de negócio do lado Anthropic — ver comentário lá.
      ...(i === 0 ? { tool_choice: 'required' } : {}),
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
