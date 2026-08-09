import { pool } from '../db/pool.js'
import { completeSimple, completeWithTools, type ToolCallRecord } from './aiClient.js'

/**
 * Regras universais do Assistente IA como um todo — valem pra QUALQUER
 * tenant/ramo de atendimento, independente do que o lojista configurar em
 * prompt_validator. Ficam hardcoded aqui de propósito (não são editáveis
 * pela tela /meu-plano/assistente-ia) porque são comportamento de
 * segurança/negócio da plataforma, não voz de marca.
 */
function universalValidatorRules(config: AssistantConfig): string {
  const min = config.min_response_chars || 150
  const max = config.max_response_chars || 300
  return [
    'REGRAS FIXAS DA PLATAFORMA (nunca ignore, mesmo se as instruções do lojista abaixo não mencionarem isso):',
    '- Antes de gerar QUALQUER cobrança (Pix ou link de cartão), primeiro use a ferramenta montar_carrinho pra mandar a prévia dos itens (nome + link) e obter confirmação explícita do cliente. Nunca pule direto pra criar_pedido_e_gerar_cobranca sem essa prévia já ter sido confirmada na conversa.',
    '- Depois da confirmação do carrinho, pergunte se o cliente quer entrega/coleta: entrega em casa (se for produto) ou coleta e entrega do aparelho (se for serviço de reparo/manutenção). Se ele quiser, peça pra ele compartilhar a localização fixa AQUI no WhatsApp (o app tem a opção "Localização" -> "Localização atual/fixa") ANTES de gerar a cobrança — nunca aceite endereço só escrito por texto, precisa ser o compartilhamento de localização mesmo.',
    '- Pra gerar a cobrança final (criar_pedido_e_gerar_cobranca) você PRECISA ter, vindos da própria conversa com o cliente: nome completo, email, o método de pagamento escolhido (pix ou link_cobranca), e se ele pediu entrega/coleta, a localização compartilhada (aparece na conversa como "[Cliente compartilhou localização fixa: ...]"). Se qualquer um desses faltar, NÃO chame a ferramenta — primeiro peça o que falta.',
    '- PROIBIDO alucinar: nunca cite nome de produto/serviço, preço, id, link, código Pix, link de pagamento ou status de pedido que não esteja LITERALMENTE no resultado de uma chamada de ferramenta desta mesma interação. Se você não chamou buscar_produtos/buscar_servicos NESTA interação, não afirme nada sobre o que existe ou não existe no catálogo — chame a ferramenta primeiro, mesmo que ache que já sabe a resposta de uma mensagem anterior seu.',
    '- Antes de aceitar/confirmar QUALQUER item específico que o cliente pediu (pra montar carrinho ou fechar pedido), rode buscar_produtos ou buscar_servicos DE NOVO com o termo certo pra confirmar nome exato, id e preço reais — mesmo que você (ou uma versão anterior sua na mesma conversa) já tenha mencionado esse item antes. Nunca reafirme de memória.',
    '- Se o cliente descreveu um problema de aparelho (tela, bateria, câmera/flash, placa, "caiu na água", "não liga"), sempre rode buscar_servicos com o termo do aparelho/marca/peça ANTES de responder — não diga "não temos" nem "temos" sem ter acabado de consultar.',
    '- A loja pode oferecer coleta e entrega do aparelho pra reparo, e entrega de produto comprado — isso também é um serviço real, então quando fizer sentido (cliente quer levar o aparelho pra reparo, ou comprou um produto), rode buscar_servicos com o termo "entrega" ou "coleta" pra ver se a loja oferece, e ofereça proativamente se existir.',
    '- Serviços com peça ligada em estoque dependem da disponibilidade calculada — se a tool de checkout falhar avisando falta de peça, não insista, avise o cliente que não tem peça disponível agora.',
    '- Nunca informe que uma cobrança foi gerada, ou repasse um código Pix/link de pagamento, se isso não estiver literalmente presente no resultado de uma ferramenta chamada nesta mesma interação.',
    '- Seja DIRETO — sem rodeios, sem repetir a mesma pergunta de formas diferentes. Assim que entender o que o cliente quer (produto, serviço, orçamento, horário, status de pedido), vá direto ao ponto. Assim que o cliente confirmar interesse real em comprar um produto/serviço, já avance pra montar o carrinho e perguntar nome/email/método de pagamento — não fique enrolando ou pedindo confirmação repetida.',
    `- SEMPRE responda com UMA ÚNICA mensagem curta, nunca várias mensagens/parágrafos longos separados. Regra de tamanho: a maioria das respostas deve ter uns ${min} caracteres; só passe disso (até no máximo uns ${max} caracteres) quando for estritamente necessário explicar algo grande (ex: passo a passo de segurança). Corte listas/explicações longas — vá direto ao essencial e pergunte o que falta, em vez de despejar tudo de uma vez.`,
  ].join('\n')
}

export type AssistantConfig = {
  tenant_id: string
  enabled: boolean
  prompt_interpreter: string
  prompt_validator: string
  start_keywords: string[]
  end_keywords: string[]
  window_timeout_minutes: number
  /** Quantos segundos esperar mensagens em sequência antes de processar como uma única interação. */
  message_batch_window_seconds: number
  min_response_chars: number
  max_response_chars: number
  /** Chave própria da loja pro motor de IA escolhido — null/vazia usa a global do processo (só vale pra "anthropic"; "openrouter" exige chave própria). */
  anthropic_api_key: string | null
  /** "anthropic" (padrão) ou "openrouter". */
  ai_provider: string
  /** Só relevante/obrigatório pra "openrouter" — ex: "anthropic/claude-3.5-sonnet". */
  ai_model: string | null
}

type InterpreterOutput = {
  intent: string
  params: Record<string, unknown>
}

/** IA 1 — atende a mensagem e toma uma decisão sobre a intenção do atendimento, sem responder direto. */
async function runInterpreter(config: AssistantConfig, userMessage: string): Promise<InterpreterOutput> {
  const system = [
    config.prompt_interpreter ||
      'Você é a primeira camada de um assistente de atendimento via WhatsApp. Leia a mensagem do cliente e decida a intenção do atendimento.',
    'Responda APENAS com um JSON no formato {"intent": "...", "params": {...}}.',
    'Intenções possíveis: consultar_pedido, montar_pedido, consultar_catalogo, duvida_loja, calcular_frete, encaminhar_humano, buscar_cupom, buscar_produto, horario_funcionamento, pedir_esclarecimento, outro.',
  ].join('\n')

  const text = await completeSimple(config, system, userMessage)
  return safeParseJson<InterpreterOutput>(text, { intent: 'outro', params: {} })
}

/**
 * IA 2 — reavalia a decisão da IA 1 de forma independente, aciona as
 * ferramentas necessárias (catálogo, pedido, carrinho/cobrança) buscando
 * dado real, e ELA MESMA já elabora e devolve a resposta final pro
 * cliente (não existe uma terceira camada separada pra isso).
 */
async function runValidatorAndRespond(
  config: AssistantConfig,
  history: { sender_type: string; content: string }[],
  userMessage: string,
  interpreterOutput: InterpreterOutput,
  toolCtx: { tenantSlug: string; phone: string; customerName: string | null },
  ragContext: string,
): Promise<{ reply: string; toolCalls: ToolCallRecord[] }> {
  const system = [
    universalValidatorRules(config),
    config.prompt_validator ||
      'Você é a camada de atendimento via WhatsApp de uma loja. Releia a mensagem do cliente de forma independente da intenção sugerida, confirme ou corrija, use as ferramentas necessárias pra buscar dado real, e elabore a resposta final pro cliente.',
    `Intenção sugerida por uma leitura anterior: ${JSON.stringify(interpreterOutput)}`,
    ragContext ? `Base de conhecimento da loja (use quando relevante):\n${ragContext}` : '',
    'Se a intenção do cliente exigir dado real da loja (produtos, preços, status de pedido) ou criar/confirmar um carrinho/cobrança que o cliente já pediu explicitamente, USE a ferramenta correspondente agora.',
    'Depois de usar as ferramentas que precisar (ou nenhuma, se não for necessário), sua ÚLTIMA resposta em texto puro (não JSON) É a mensagem final que vai direto pro cliente no WhatsApp — capriche, é a resposta de verdade, não um resumo interno.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const chatHistory = history.map((m) => ({ role: m.sender_type === 'cliente' ? ('user' as const) : ('assistant' as const), content: m.content }))
  const { reply, toolCalls } = await completeWithTools(config, system, chatHistory, userMessage, toolCtx)

  return {
    reply: reply || 'Desculpa, não consegui gerar uma resposta agora — já chamo alguém pra te ajudar.',
    toolCalls,
  }
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
  toolCalls: ToolCallRecord[]
}

/**
 * Roda o pipeline (IA1 -> IA2 com tools + resposta final). Não persiste
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
  const ragContext = await searchRag(config.tenant_id, userMessage)
  const { reply, toolCalls } = await runValidatorAndRespond(
    config,
    history,
    userMessage,
    interpreterOutput,
    { tenantSlug: config.tenant_id, phone, customerName },
    ragContext,
  )
  return { reply, interpreterOutput, toolCalls }
}
