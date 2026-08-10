import { pool } from '../db/pool.js'
import { completeSimple, completeWithTools, type ToolCallRecord } from './aiClient.js'

/**
 * Marcador que a IA usa pra separar o aviso do código Pix/link de
 * pagamento — cada lado vira uma mensagem própria no WhatsApp, pra o
 * cliente conseguir copiar o código sozinho, sem texto grudado.
 * `webhook.ts` faz o split literal nesse texto ao enviar.
 */
export const MSG_SPLIT_MARKER = '|||MSG_SPLIT|||'

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
    '- Assim que o cliente compartilhar a localização (pedindo entrega/coleta), rode a ferramenta calcular_valor_entrega imediatamente e informe o valor real ao cliente — NUNCA estime, arredonde ou invente um valor de entrega, o preço é sempre o que essa ferramenta retornar (calculado pelo preço por km real cadastrado na loja).',
    '- Pra gerar a cobrança final (criar_pedido_e_gerar_cobranca) você PRECISA ter, vindos da própria conversa/ferramentas: nome completo, email, o método de pagamento escolhido (pix ou link_cobranca), e se ele pediu entrega/coleta, a localização compartilhada + o valor de entrega já calculado por calcular_valor_entrega (passe em valor_entrega). Se qualquer um desses faltar, NÃO chame a ferramenta — primeiro peça/calcule o que falta.',
    '- ECONOMIA DE INTERAÇÃO (regra crítica, cada mensagem trocada custa tempo e dinheiro): antes de pedir nome/email/método de pagamento/localização, RELEIA o histórico da conversa inteiro — se o cliente já informou algum desses dados em qualquer mensagem anterior desta mesma conversa (mesmo que tenha sido pra outro item/pedido), REAPROVEITE, nunca peça de novo. Se já tiver TUDO que falta (dados + confirmação do carrinho), chame criar_pedido_e_gerar_cobranca NA MESMA resposta, sem pedir confirmação extra de novo.',
    '- Ao montar/atualizar um carrinho quando você já tem nome/email/método de pagamento de uma interação anterior na conversa, faça a prévia do carrinho E JÁ pergunte "confirma esse carrinho pra eu gerar o pagamento com [nome], [email], via [método]?" numa única mensagem — não separe em duas rodadas (uma só de confirmar carrinho, outra só de pedir dados) se os dados já existem.',
    '- Quando o cliente confirmar ("sim", "confirmo", "pode gerar", etc.) e todos os dados necessários já estiverem na conversa (mesmo que informados antes), chame criar_pedido_e_gerar_cobranca IMEDIATAMENTE nessa resposta — nunca responda só texto tipo "vou gerar" ou "só um instante" sem ter chamado a ferramenta de verdade. Se a ferramenta falhar, diga exatamente o que a ferramenta retornou de erro, nunca invente "erro no sistema" genérico.',
    '- IMPORTANTE: a regra de reaproveitar dado do histórico (linha "ECONOMIA DE INTERAÇÃO") vale SÓ pra nome/email/método de pagamento/localização do cliente — nunca pra produto/serviço. Se o cliente pedir um item novo que ainda não apareceu na conversa (mesmo que pareça parecido com algo já buscado antes), você é OBRIGADO a rodar buscar_produtos/buscar_servicos de novo pra esse item — nunca responda usando um resultado de busca antigo/de outro item como se fosse cache do item novo.',
    '- PROIBIDO alucinar: nunca cite nome de produto/serviço, preço, id, link, código Pix, link de pagamento ou status de pedido que não esteja LITERALMENTE no resultado de uma chamada de ferramenta desta mesma interação. Se você não chamou buscar_produtos/buscar_servicos NESTA interação, não afirme nada sobre o que existe ou não existe no catálogo — chame a ferramenta primeiro, mesmo que ache que já sabe a resposta de uma mensagem anterior seu.',
    '- Antes de aceitar/confirmar QUALQUER item específico que o cliente pediu (pra montar carrinho ou fechar pedido), rode buscar_produtos ou buscar_servicos DE NOVO com o termo certo pra confirmar nome exato, id e preço reais — mesmo que você (ou uma versão anterior sua na mesma conversa) já tenha mencionado esse item antes. Nunca reafirme de memória.',
    '- Se o cliente descreveu um problema de aparelho (tela, bateria, câmera/flash, placa, "caiu na água", "não liga"), sempre rode buscar_servicos com o termo do aparelho/marca/peça ANTES de responder — não diga "não temos" nem "temos" sem ter acabado de consultar.',
    '- PROIBIDO tratar entrega/coleta como um item de serviço buscável ou vendável: NUNCA rode buscar_servicos com termos como "entrega", "coleta", "busca" pra achar um "serviço de entrega", NUNCA inclua algo assim no carrinho via montar_carrinho/criar_pedido_e_gerar_cobranca como item avulso. Entrega/coleta é EXCLUSIVAMENTE o resultado de calcular_valor_entrega (distância real × preço por km da loja), somado como valor_entrega — nunca um serviço com id/nome/preço próprio.',
    '- Serviços com peça ligada em estoque dependem da disponibilidade calculada — se a tool de checkout falhar avisando falta de peça, não insista, avise o cliente que não tem peça disponível agora.',
    '- Nunca informe que uma cobrança foi gerada, ou repasse um código Pix/link de pagamento, se isso não estiver literalmente presente no resultado de uma ferramenta chamada nesta mesma interação.',
    '- Seja DIRETO — sem rodeios, sem repetir a mesma pergunta de formas diferentes. Assim que entender o que o cliente quer (produto, serviço, orçamento, horário, status de pedido), vá direto ao ponto. Assim que o cliente confirmar interesse real em comprar um produto/serviço, já avance pra montar o carrinho e perguntar nome/email/método de pagamento — não fique enrolando ou pedindo confirmação repetida.',
    `- SEMPRE responda com UMA ÚNICA mensagem curta, nunca várias mensagens/parágrafos longos separados. Regra de tamanho: a maioria das respostas deve ter uns ${min} caracteres; só passe disso (até no máximo uns ${max} caracteres) quando for estritamente necessário explicar algo grande (ex: passo a passo de segurança). Corte listas/explicações longas — vá direto ao essencial e pergunte o que falta, em vez de despejar tudo de uma vez.`,
    `- EXCEÇÃO à regra acima: quando (e só quando) a ferramenta criar_pedido_e_gerar_cobranca retornar um código Pix copia-e-cola ou um link de pagamento, sua resposta deve ter DUAS partes separadas pelo marcador ${MSG_SPLIT_MARKER} (cada parte vira uma mensagem separada no WhatsApp, nessa ordem): a primeira parte junta TODO o resto — aviso curto (ex: "Copie o código Pix abaixo e cole no app do seu banco:") + qualquer observação extra que a ferramenta tenha retornado (ex: nota sobre entrega/coleta ser combinada depois). A segunda parte é SÓ o código/link, sozinho, exatamente como veio da ferramenta — SEM absolutamente nenhum texto a mais grudado nem antes nem depois dele (nenhuma observação, nenhuma nota sobre entrega, nada), só o código/link puro, pra o cliente conseguir copiar/tocar direto. Formato exato: "<aviso + qualquer nota extra>${MSG_SPLIT_MARKER}<código ou link, e SÓ o código ou link>". Fora desse caso específico, nunca use esse marcador.`,
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
  toolCtx: { tenantSlug: string; phone: string; customerName: string | null; instance: string },
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
  const safeReply = reply || 'Desculpa, não consegui gerar uma resposta agora — já chamo alguém pra te ajudar.'

  return {
    reply: enforcePaymentCodeSplit(safeReply, toolCalls),
    toolCalls,
  }
}

/**
 * Extrai o código Pix / link de pagamento LITERAL retornado por
 * criar_pedido_e_gerar_cobranca (sempre a última linha do texto que a tool
 * devolve — ver tools.ts) e garante que ele saia como mensagem própria,
 * separada do aviso, via MSG_SPLIT_MARKER — SEM depender do modelo lembrar
 * de formatar isso sozinho (com modelos menores/max_response_chars baixo,
 * a instrução de prompt sozinha não é confiável o suficiente).
 */
function enforcePaymentCodeSplit(reply: string, toolCalls: ToolCallRecord[]): string {
  const chargeCall = [...toolCalls].reverse().find((t) => t.tool === 'criar_pedido_e_gerar_cobranca')
  if (!chargeCall) return reply
  const lines = chargeCall.output.trim().split('\n')
  const code = lines[lines.length - 1]?.trim()
  // Só considera "código real" se parecer um copia-e-cola Pix (EMV, começa
  // com "000201") ou um link de pagamento (http) — nunca uma frase de erro
  // (as mensagens de erro da tool não terminam assim).
  const looksLikeRealCode = !!code && (code.startsWith('000201') || code.startsWith('http'))
  if (!looksLikeRealCode) return reply

  if (reply.includes(MSG_SPLIT_MARKER)) {
    // Modelo já tentou separar — só garante que a segunda parte é EXATAMENTE
    // o código puro, sem nada grudado (nem antes, nem depois).
    const idx = reply.indexOf(MSG_SPLIT_MARKER)
    const before = reply.slice(0, idx)
    return `${before}${MSG_SPLIT_MARKER}${code}`
  }

  // Modelo não usou o marcador — força o split mesmo assim. Se o texto
  // devolvido pelo modelo contém o código literal, tira ele de lá e some
  // com o resto como aviso; se nem contém (paráfrase/truncamento), ainda
  // assim anexa o código real como segunda mensagem garantida.
  const parts = reply.split(code)
  const aviso = parts.length > 1 ? parts.join(' ').trim() : reply.trim()
  return `${aviso}${MSG_SPLIT_MARKER}${code}`
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
  instance: string,
): Promise<PipelineResult> {
  const interpreterOutput = await runInterpreter(config, userMessage)
  const ragContext = await searchRag(config.tenant_id, userMessage)
  const { reply, toolCalls } = await runValidatorAndRespond(
    config,
    history,
    userMessage,
    interpreterOutput,
    { tenantSlug: config.tenant_id, phone, customerName, instance },
    ragContext,
  )
  return { reply, interpreterOutput, toolCalls }
}
