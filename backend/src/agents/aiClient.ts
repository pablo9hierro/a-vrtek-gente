import Anthropic from '@anthropic-ai/sdk'
import { tools, executeTool } from './tools.js'
import type { AssistantConfig } from './pipeline.js'
import { getEnabledPlatformEngines, type PlatformEngine } from './platformEngines.js'

const defaultAnthropic = new Anthropic() // lê ANTHROPIC_API_KEY do ambiente

export type ToolCallRecord = { tool: string; input: unknown; output: string }
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ToolCtx = { tenantSlug: string; phone: string; customerName: string | null; instance: string }

/**
 * Chave de PLATAFORMA pro provedor do motor — nunca a chave própria do
 * tenant (essa seleção de motor é 100% controlada pelo superadmin, ver
 * platformEngines.ts). Anthropic não precisa disso (usa `defaultAnthropic`
 * direto, que já lê ANTHROPIC_API_KEY do ambiente).
 */
function platformKeyFor(engine: PlatformEngine): string | undefined {
  if (engine.provider === 'openai') return process.env.OPENAI_API_KEY?.trim() || undefined
  if (engine.provider === 'openrouter') return process.env.OPENROUTER_API_KEY?.trim() || undefined
  return undefined
}

/**
 * Chama a IA e resolve tool calling, cascateando pela lista de motores da
 * plataforma (ranking definido pelo superadmin) até um responder com
 * sucesso — se o motor de topo cair/não responder, tenta o próximo
 * automaticamente, sem o cliente perceber. `config` continua recebido
 * (prompt/regras do tenant já estão embutidos em `system`) mas não decide
 * mais QUAL motor é usado — isso agora é 100% platformEngines.ts.
 */
export async function completeWithTools(
  config: AssistantConfig,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const engines = await getEnabledPlatformEngines()
  if (engines.length === 0) throw new Error('nenhum motor de IA da plataforma habilitado (ver painel superadmin)')

  let lastErr: unknown
  for (const engine of engines) {
    try {
      return await runWithTools(engine, system, history, userMessage, toolCtx)
    } catch (err) {
      lastErr = err
      console.warn(`[ai-fallback] motor "${engine.label}" falhou, tentando o próximo do ranking:`, err)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('todos os motores de IA da plataforma falharam')
}

/** Sem ferramentas — usado só pela IA 1 (interpretação de intenção). Mesmo ranking/fallback de completeWithTools. */
export async function completeSimple(config: AssistantConfig, system: string, userMessage: string): Promise<string> {
  const engines = await getEnabledPlatformEngines()
  if (engines.length === 0) throw new Error('nenhum motor de IA da plataforma habilitado (ver painel superadmin)')

  let lastErr: unknown
  for (const engine of engines) {
    try {
      return await runSimple(engine, system, userMessage)
    } catch (err) {
      lastErr = err
      console.warn(`[ai-fallback] motor "${engine.label}" falhou (interpretação), tentando o próximo do ranking:`, err)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('todos os motores de IA da plataforma falharam')
}

async function runSimple(engine: PlatformEngine, system: string, userMessage: string): Promise<string> {
  if (engine.provider === 'anthropic') {
    const res = await defaultAnthropic.messages.create({
      model: engine.model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userMessage }],
    })
    return res.content.find((b) => b.type === 'text')?.text ?? ''
  }
  const url = engine.provider === 'openai' ? OPENAI_URL : OPENROUTER_URL
  const res = await openAiCompatibleFetch(platformKeyFor(engine), engine, url, {
    model: engine.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ],
  })
  return res.choices?.[0]?.message?.content ?? ''
}

async function runWithTools(
  engine: PlatformEngine,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  if (engine.provider === 'anthropic') {
    return runToolsAnthropic(engine, system, history, userMessage, toolCtx)
  }
  const url = engine.provider === 'openai' ? OPENAI_URL : OPENROUTER_URL
  return runToolsOpenAiCompatible(engine, url, system, history, userMessage, toolCtx)
}

async function runToolsAnthropic(
  engine: PlatformEngine,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }))
  messages.push({ role: 'user', content: userMessage })

  const toolCalls: ToolCallRecord[] = []
  let finalText = ''
  for (let i = 0; i < 6; i++) {
    const res = await defaultAnthropic.messages.create({
      model: engine.model,
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

async function openAiCompatibleFetch(
  key: string | undefined,
  engine: PlatformEngine,
  url: string,
  body: Record<string, unknown>,
): Promise<OrResponse> {
  if (!key) {
    throw new Error(
      `${engine.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'} não configurada na plataforma (motor "${engine.label}")`,
    )
  }
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
    throw new Error(`${engine.provider} (${engine.label}) retornou ${res.status}: ${text}`)
  }
  return (await res.json()) as OrResponse
}

/** Mesmo formato de `tools` (Anthropic) convertido pra "function calling" da OpenAI — usado tanto pra OpenAI quanto OpenRouter (mesmo schema). */
const openAiTools = tools.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))

async function runToolsOpenAiCompatible(
  engine: PlatformEngine,
  url: string,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const key = platformKeyFor(engine)
  const messages: OrMessage[] = [
    { role: 'system', content: system },
    ...history.map((m): OrMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  const toolCalls: ToolCallRecord[] = []
  let finalText = ''
  for (let i = 0; i < 6; i++) {
    const res = await openAiCompatibleFetch(key, engine, url, {
      model: engine.model,
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
