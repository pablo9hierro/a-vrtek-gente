import { tools, executeTool, type ToolDefinition } from './tools.js'
import type { AssistantConfig } from './pipeline.js'
import { getEnabledPlatformEngines, type PlatformEngine } from './platformEngines.js'
import { resolveTenantVertical, resolveOfereceServicos } from '../services/tenantVertical.js'

/** Tools que só fazem sentido pra quem cadastrou serviço/agendamento --
 * fora dessa lista, tudo (produto, pedido, entrega, localização) é comum
 * a qualquer tenant. Ver `resolveOfereceServicos`. */
const SERVICE_TOOL_NAMES = new Set([
  'buscar_servicos',
  'agendar_horario',
  'desmarcar_horario',
  'editar_horario',
  'consultar_agendamentos',
])

export type ToolCallRecord = { tool: string; input: unknown; output: string }
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ToolCtx = { tenantSlug: string; phone: string; customerName: string | null; instance: string }

/**
 * Qual motor de IA responde é decisão exclusiva do superadmin (painel
 * /motores-ia, ranking em platform_ai_engines) — nunca do tenant, nunca
 * hardcoded aqui. Cascateia pela lista em ordem de prioridade até um
 * responder com sucesso; se o motor do topo cair/não responder, tenta o
 * próximo automaticamente, sem o cliente perceber.
 */
function platformKeyFor(engine: PlatformEngine): string | undefined {
  if (engine.provider === 'openai') return process.env.OPENAI_API_KEY?.trim() || undefined
  if (engine.provider === 'openrouter') return process.env.OPENROUTER_API_KEY?.trim() || undefined
  return undefined
}

export async function completeWithTools(
  config: AssistantConfig,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const engines = await getEnabledPlatformEngines()
  if (engines.length === 0) throw new Error('nenhum motor de IA habilitado no ranking da plataforma (ver painel superadmin /motores-ia)')

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
export async function completeSimple(_config: AssistantConfig, system: string, userMessage: string): Promise<string> {
  const engines = await getEnabledPlatformEngines()
  if (engines.length === 0) throw new Error('nenhum motor de IA habilitado no ranking da plataforma (ver painel superadmin /motores-ia)')

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
  const url = engine.provider === 'openai' ? OPENAI_URL : OPENROUTER_URL
  return runToolsOpenAiCompatible(engine, url, system, history, userMessage, toolCtx)
}

// ---------- OpenAI / OpenRouter (mesmo formato de chat completions + function calling) — únicos provedores suportados ----------

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
    const which = engine.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'
    throw new Error(`${which} não configurada na plataforma (motor "${engine.label}")`)
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

/** Mesmo formato de `tools` convertido pra "function calling" (OpenAI/OpenRouter usam o mesmo schema). */
function toOpenAiTool(t: ToolDefinition) {
  return {
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }
}

/** Set completo (usado sempre que não dá pra resolver o tenant -- nunca
 * trava o assistente por causa disso, só não filtra). */
const openAiToolsAll = tools.map(toOpenAiTool)

async function toolsForTenant(tenantSlug: string) {
  const vertical = await resolveTenantVertical(tenantSlug)
  const ofereceServicos = await resolveOfereceServicos(tenantSlug, vertical)
  if (ofereceServicos) return openAiToolsAll
  return tools.filter((t: ToolDefinition) => !SERVICE_TOOL_NAMES.has(t.name)).map(toOpenAiTool)
}

async function runToolsOpenAiCompatible(
  engine: PlatformEngine,
  url: string,
  system: string,
  history: ChatMessage[],
  userMessage: string,
  toolCtx: ToolCtx,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const key = platformKeyFor(engine)
  const openAiTools = await toolsForTenant(toolCtx.tenantSlug)
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
      // Regra de negócio: toda resposta precisa vir de pelo menos 1 tool
      // call real — nunca responder "de memória"/genérico sem ter
      // consultado nada. Só força na 1ª rodada; depois de já ter pelo
      // menos um resultado de ferramenta, o modelo decide livremente se
      // precisa de mais alguma (pode encadear quantas quiser) ou já
      // responder o texto final.
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
