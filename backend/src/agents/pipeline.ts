import Anthropic from '@anthropic-ai/sdk'
import { pool } from '../db/pool.js'
import { tools, executeTool } from './tools.js'

const anthropic = new Anthropic() // lê ANTHROPIC_API_KEY do ambiente

/**
 * Regras universais do Assistente IA como um todo — valem pra QUALQUER
 * tenant/ramo de atendimento, independente do que o lojista configurar em
 * prompt_validator/prompt_supervisor. Ficam hardcoded aqui de propósito
 * (não são editáveis pela tela /meu-plano/assistente-ia) porque são
 * comportamento de segurança/negócio da plataforma, não voz de marca.
 */
const UNIVERSAL_VALIDATOR_RULES = [
  'REGRAS FIXAS DA PLATAFORMA (nunca ignore, mesmo se as instruções do lojista abaixo não mencionarem isso):',
  '- Antes de gerar QUALQUER cobrança (Pix ou link de cartão), primeiro use a ferramenta montar_carrinho pra mandar a prévia dos itens (nome + link) e obter confirmação explícita do cliente. Nunca pule direto pra criar_pedido_e_gerar_cobranca sem essa prévia já ter sido confirmada na conversa.',
  '- Pra gerar a cobrança final (criar_pedido_e_gerar_cobranca) você PRECISA ter, vindos da própria conversa com o cliente: nome completo, email, e o método de pagamento escolhido (pix ou link_cobranca). Se qualquer um desses faltar, NÃO chame a ferramenta — primeiro peça o que falta.',
  '- Nunca invente id de produto, preço, link, código Pix, link de pagamento ou status de pedido. Só use o que veio de verdade das ferramentas.',
  '- Só produtos entram em pedido pago automaticamente; serviços não têm checkout automatizado ainda — se o carrinho só tiver serviço(s), não chame criar_pedido_e_gerar_cobranca, explique que um atendente vai confirmar e cobrar manualmente.',
].join('\n')

const UNIVERSAL_SUPERVISOR_RULES = [
  'REGRAS FIXAS DA PLATAFORMA (nunca ignore, mesmo se as instruções do lojista abaixo não mencionarem isso):',
  '- Nunca informe que uma cobrança foi gerada, ou repasse um código Pix/link de pagamento, se isso não estiver literalmente presente nos dados buscados pela camada 2 abaixo.',
  '- Se a camada 2 ainda não tem nome, email ou método de pagamento do cliente pra fechar a compra, peça exatamente o que falta nesta resposta (não avance pra cobrança).',
  '- Se a prévia do carrinho (montar_carrinho) foi apresentada mas o cliente ainda não confirmou, peça a confirmação antes de qualquer outra coisa.',
  '- SEMPRE responda com UMA ÚNICA mensagem curta, nunca várias mensagens/parágrafos longos separados. Regra de tamanho: a maioria das respostas deve ter uns 150 caracteres; só passe disso (até no máximo uns 300 caracteres) quando for estritamente necessário explicar algo grande (ex: passo a passo de segurança). Corte listas/explicações longas — vá direto ao essencial e pergunte o que falta, em vez de despejar tudo de uma vez.',
].join('\n')

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

type ToolCallRecord = { tool: string; input: unknown; output: string }

type InterpreterOutput = {
  intent: string
  params: Record<string, unknown>
}

type ValidatorOutput = {
  intent: string
  agrees: boolean
  note?: string
  tool_calls: ToolCallRecord[]
}

/** IA 1 — atende a mensagem e toma uma decisão sobre a intenção do atendimento, sem responder direto. */
async function runInterpreter(config: AssistantConfig, userMessage: string): Promise<InterpreterOutput> {
  const system = [
    config.prompt_interpreter ||
      'Você é a primeira camada de um assistente de atendimento via WhatsApp. Leia a mensagem do cliente e decida a intenção do atendimento.',
    'Responda APENAS com um JSON no formato {"intent": "...", "params": {...}}.',
    'Intenções possíveis: consultar_pedido, montar_pedido, consultar_catalogo, duvida_loja, calcular_frete, encaminhar_humano, buscar_cupom, buscar_produto, horario_funcionamento, pedir_esclarecimento, outro.',
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

/**
 * IA 2 — segunda camada de segurança: relê a mensagem do cliente de forma
 * independente (não confia cegamente na IA 1), reinterpreta a intenção, e
 * é ELA quem decide se precisa acionar alguma ferramenta (catálogo,
 * pedido, criar carrinho/Pix) — e aciona de verdade, buscando o dado real
 * antes de passar pra frente. A IA 3 nunca chama ferramenta, só recebe o
 * que já foi buscado aqui.
 */
async function runValidator(
  config: AssistantConfig,
  userMessage: string,
  interpreterOutput: InterpreterOutput,
  toolCtx: { tenantSlug: string; phone: string; customerName: string | null },
): Promise<ValidatorOutput> {
  const system = [
    UNIVERSAL_VALIDATOR_RULES,
    config.prompt_validator ||
      'Você é a segunda camada (validação) de um assistente de atendimento via WhatsApp. Releia a mensagem do cliente de forma independente, sem confiar cegamente na intenção sugerida pela primeira camada, e confirme ou corrija.',
    `Intenção sugerida pela primeira camada: ${JSON.stringify(interpreterOutput)}`,
    'Se a intenção do cliente exigir dado real da loja (produtos, preços, status de pedido) ou criar/confirmar um carrinho/cobrança que o cliente já pediu explicitamente, USE a ferramenta correspondente agora — não espere a próxima camada.',
    'Depois de usar as ferramentas que precisar (ou nenhuma, se não for necessário), responda em texto puro (não JSON) com um resumo curto da sua reinterpretação, no formato: "intent: <intent>; concorda: sim|nao; nota: <opcional>".',
  ].join('\n')

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `Mensagem do cliente: "${userMessage}"` }]
  const toolCalls: ToolCallRecord[] = []

  let finalText = ''
  for (let i = 0; i < 4; i++) {
    const res = await anthropic.messages.create({
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

  const intentMatch = finalText.match(/intent:\s*([a-z_]+)/i)
  const agreesMatch = finalText.match(/concorda:\s*(sim|nao|não)/i)
  const noteMatch = finalText.match(/nota:\s*(.+)/i)
  return {
    intent: intentMatch?.[1] ?? interpreterOutput.intent,
    agrees: agreesMatch ? /sim/i.test(agreesMatch[1]) : true,
    note: noteMatch?.[1]?.trim(),
    tool_calls: toolCalls,
  }
}

/**
 * IA 3 — supervisor de contexto: pega a intenção da IA 1, a reinterpretação
 * e os dados reais que a IA 2 já buscou (nunca chama ferramenta ela
 * mesma), lê a janela de atendimento inteira, e elabora a resposta final
 * pro cliente.
 */
async function runSupervisor(
  config: AssistantConfig,
  history: { sender_type: string; content: string }[],
  userMessage: string,
  interpreterOutput: InterpreterOutput,
  validatorOutput: ValidatorOutput,
  ragContext: string,
): Promise<string> {
  const toolContext = validatorOutput.tool_calls.length
    ? validatorOutput.tool_calls.map((t) => `Ferramenta "${t.tool}" retornou:\n${t.output}`).join('\n\n')
    : 'Nenhuma ferramenta foi acionada pra essa mensagem.'

  const system = [
    UNIVERSAL_SUPERVISOR_RULES,
    config.prompt_supervisor ||
      'Você é a terceira camada (supervisor de contexto) de um assistente de atendimento via WhatsApp de uma loja. Gere a resposta final para o cliente.',
    ragContext ? `Base de conhecimento da loja (use quando relevante):\n${ragContext}` : '',
    `Intenção (camada 1): ${interpreterOutput.intent}`,
    `Reinterpretação (camada 2): ${validatorOutput.intent}${validatorOutput.agrees ? '' : ` (discordou da camada 1: ${validatorOutput.note ?? ''})`}`,
    `Dados reais já buscados pela camada 2:\n${toolContext}`,
    'Você NÃO tem ferramentas — só pode responder com base no que já foi buscado acima + histórico da conversa + base de conhecimento. Nunca invente produto, preço, status de pedido ou código Pix que não esteja nos dados acima.',
    'Se os dados acima já respondem a pergunta, responda direto e completo (inclusive repassando o código Pix por inteiro, se tiver um). Só diga que vai chamar um atendente humano se realmente não tiver ferramenta/dado pra aquele pedido.',
    'Responda em texto puro, direto, no tom de uma loja atendendo cliente pelo WhatsApp.',
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
  return (
    res.content.find((b) => b.type === 'text')?.text ??
    'Desculpa, não consegui gerar uma resposta agora — já chamo alguém pra te ajudar.'
  )
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
 * Roda o pipeline completo (IA1 -> IA2 com tools -> IA3). Não persiste
 * nada — o chamador (routes/webhook.ts) insere a mensagem de saída e só
 * depois grava as decisões em agent_decisions, porque essa tabela
 * referencia message_id (que só existe depois de inserir a mensagem).
 */
export async function runPipeline(
  config: AssistantConfig,
  history: { sender_type: string; content: string }[],
  userMessage: string,
  phone: string,
  customerName: string | null,
): Promise<PipelineResult> {
  const interpreterOutput = await runInterpreter(config, userMessage)
  const validatorOutput = await runValidator(config, userMessage, interpreterOutput, {
    tenantSlug: config.tenant_id,
    phone,
    customerName,
  })
  const ragContext = await searchRag(config.tenant_id, userMessage)
  const reply = await runSupervisor(config, history, userMessage, interpreterOutput, validatorOutput, ragContext)
  return { reply, interpreterOutput, validatorOutput }
}
