import Anthropic from '@anthropic-ai/sdk'
import { tools, executeTool } from './tools.js'
import type { AssistantConfig } from './pipeline.js'
import { getEnabledPlatformEngines, type PlatformAiProvider, type PlatformEngine } from './platformEngines.js'

const defaultAnthropic = new Anthropic() // lê ANTHROPIC_API_KEY do ambiente

export type ToolCallRecord = { tool: string; input: unknown; output: string }
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ToolCtx = { tenantSlug: string; phone: string; customerName: string | null; instance: string }

const TENANT_OWN_ENGINE_ID = '__tenant_own__'

/**
 * Se o tenant configurou motor+chave próprios (tela /meu-plano/
 * assistente-ia), isso vira uma "tentativa 0" antes do ranking da
 * plataforma — preserva o comportamento de quem já pagava pelo próprio
 * uso (ex: loja com chave OpenAI própria) mesmo depois do ranking global
 * existir. Sem isso, um tenant que sempre funcionou com sua própria chave
 * ficaria refém do ranking da plataforma estar com chave configurada.
 */
function tenantOwnEngine(config: AssistantConfig): PlatformEngine | null {
  const key = config.anthropic_api_key?.trim()
  if (!key) return null
  const provider: PlatformAiProvider =
    config.ai_provider === 'openai' || config.ai_provider === 'openrouter' ? config.ai_provider : 'anthropic'
  const model =
    config.ai_model?.trim() ||
    (provider === 'anthropic' ? 'claude-opus-5' : provider === 'openai' ? 'gpt-4o-mini' : 'anthropic/claude-3.5-sonnet')
  return { id: TENANT_OWN_ENGINE_ID, label: `motor próprio do tenant (${provider})`, provider, model, priority: 0, enabled: true }
}

function anthropicClientFor(engine: PlatformEngine, tenantKey?: string): Anthropic {
  if (engine.id === TENANT_OWN_ENGINE_ID && tenantKey?.startsWith('sk-ant-')) return new Anthropic({ apiKey: tenantKey })
  return defaultAnthropic
}

/**
 * Chave pro provedor do motor. Pra "motor próprio do tenant" usa a chave
 * que o próprio tenant cadastrou; pra motores do ranking da plataforma usa
 * SEMPRE chave de plataforma (nunca a de um tenant) — essa seleção é
 * 100% controlada pelo superadmin, ver platformEngines.ts.
 */
function keyFor(engine: PlatformEngine, tenantKey?: string): string | undefined {
  if (engine.id === TENANT_OWN_ENGINE_ID && tenantKey) return tenantKey
  if (engine.provider === 'openai') return process.env.OPENAI_API_KEY?.trim() || undefined
  if (engine.provider === 'openrouter') return process.env.OPENROUTER_API_KEY?.trim() || undefined
  return undefined
}

/** Motor próprio do tenant (se configurado) primeiro, depois o ranking da plataforma em ordem — cascateia até um responder. */
async function attemptOrder(config: AssistantConfig): Promise<{ engine: PlatformEngine; tenantKey?: string }[]> {
  const attempts: { engine: PlatformEngine; tenantKey?: string }[] = []
  const own = tenantOwnEngine(config)
  if (own) attempts.push({ engine: own, tenantKey: config.anthropic_api_key?.trim() })
  for (const engine of await getEnabledPlatformEngines()) attempts.push({ engine })
  return attempts
}

/**
 * Chama a IA e resolve tool calling, tentando primeiro o motor próprio do
 * tenant (se configurado) e depois cascateando pelo ranking da plataforma
 * até um responder com sucesso — se um motor cair/não responder, tenta o
 * próximo automaticamente, sem o cliente perceber.
 */
export async function completeWithTools(
  config: AssistantConfig,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const attempts = await attemptOrder(config)
  if (attempts.length === 0) throw new Error('nenhum motor de IA disponível (nem tenant, nem ranking da plataforma)')

  let lastErr: unknown
  for (const { engine, tenantKey } of attempts) {
    try {
      return await runWithTools(engine, system, history, userMessage, toolCtx, tenantKey)
    } catch (err) {
      lastErr = err
      console.warn(`[ai-fallback] motor "${engine.label}" falhou, tentando o próximo:`, err)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('todos os motores de IA falharam')
}

/** Sem ferramentas — usado só pela IA 1 (interpretação de intenção). Mesma ordem/fallback de completeWithTools. */
export async function completeSimple(config: AssistantConfig, system: string, userMessage: string): Promise<string> {
  const attempts = await attemptOrder(config)
  if (attempts.length === 0) throw new Error('nenhum motor de IA disponível (nem tenant, nem ranking da plataforma)')

  let lastErr: unknown
  for (const { engine, tenantKey } of attempts) {
    try {
      return await runSimple(engine, system, userMessage, tenantKey)
    } catch (err) {
      lastErr = err
      console.warn(`[ai-fallback] motor "${engine.label}" falhou (interpretação), tentando o próximo:`, err)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('todos os motores de IA falharam')
}

async function runSimple(engine: PlatformEngine, system: string, userMessage: string, tenantKey?: string): Promise<string> {
  if (engine.provider === 'anthropic') {
    const res = await anthropicClientFor(engine, tenantKey).messages.create({
      model: engine.model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userMessage }],
    })
    return res.content.find((b) => b.type === 'text')?.text ?? ''
  }
  const url = engine.provider === 'openai' ? OPENAI_URL : OPENROUTER_URL
  const res = await openAiCompatibleFetch(keyFor(engine, tenantKey), engine, url, {
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
  tenantKey?: string,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  if (engine.provider === 'anthropic') {
    return runToolsAnthropic(engine, system, history, userMessage, toolCtx, tenantKey)
  }
  const url = engine.provider === 'openai' ? OPENAI_URL : OPENROUTER_URL
  return runToolsOpenAiCompatible(engine, url, system, history, userMessage, toolCtx, tenantKey)
}

async function runToolsAnthropic(
  engine: PlatformEngine,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
  tenantKey?: string,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const client = anthropicClientFor(engine, tenantKey)
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }))
  messages.push({ role: 'user', content: userMessage })

  const toolCalls: ToolCallRecord[] = []
  let finalText = ''
  for (let i = 0; i < 6; i++) {
    const res = await client.messages.create({
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
    const which = engine.id === TENANT_OWN_ENGINE_ID ? 'chave própria do tenant' : engine.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'
    throw new Error(`${which} não configurada (motor "${engine.label}")`)
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
  tenantKey?: string,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const key = keyFor(engine, tenantKey)
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
