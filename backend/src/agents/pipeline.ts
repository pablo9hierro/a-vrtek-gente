import { pool } from '../db/pool.js'
import { completeSimple, completeWithTools, type ToolCallRecord } from './aiClient.js'
import { resolveTenantVertical, resolveOfereceServicos, resolveStoreConfig } from '../services/tenantVertical.js'

const STORE_BASE_URL = process.env.STORE_BASE_URL || 'https://resolutoo.com'

/**
 * Marcador que a IA usa pra separar o aviso do código Pix/link de
 * pagamento — cada lado vira uma mensagem própria no WhatsApp, pra o
 * cliente conseguir copiar o código sozinho, sem texto grudado.
 * `webhook.ts` faz o split literal nesse texto ao enviar.
 */
export const MSG_SPLIT_MARKER = '|||MSG_SPLIT|||'

/**
 * Versão do prompt técnico interno da IA 2 (`universalValidatorRules`) —
 * sobe quando as regras fixas da plataforma mudam, independente de
 * qualquer configuração de tenant. Gravada em `agent_decisions` (layer
 * "validator") pra auditoria: dá pra saber qual versão da lógica técnica
 * gerou cada resposta, sem precisar de tabela nova.
 */
export const INTERNAL_PROMPT_VERSION = '1.1'

/**
 * Regras universais do Assistente IA como um todo — valem pra QUALQUER
 * tenant/ramo de atendimento, independente do que o lojista configurar em
 * prompt_validator. Ficam hardcoded aqui de propósito (não são editáveis
 * pela tela /meu-plano/assistente-ia) porque são comportamento de
 * segurança/negócio da plataforma, não voz de marca.
 */
/** "domingo, 18/08/2026, 21:40 (horário de Brasília)" — fuso fixo -03:00 (sem horário de verão desde 2019), sem depender de chrono-tz/Intl timezone data. */
function brasiliaNowLabel(): string {
  const brasilia = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const weekday = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'][brasilia.getUTCDay()]
  const dd = String(brasilia.getUTCDate()).padStart(2, '0')
  const mm = String(brasilia.getUTCMonth() + 1).padStart(2, '0')
  const hh = String(brasilia.getUTCHours()).padStart(2, '0')
  const min = String(brasilia.getUTCMinutes()).padStart(2, '0')
  return `${weekday}, ${dd}/${mm}/${brasilia.getUTCFullYear()}, ${hh}:${min} (horário de Brasília)`
}

function universalValidatorRules(config: AssistantConfig): string {
  const min = config.min_response_chars || 150
  const max = config.max_response_chars || 300
  return [
    'REGRAS FIXAS DA PLATAFORMA (nunca ignore, mesmo se as instruções do lojista abaixo não mencionarem isso):',
    '- BUG-019: FORMATAÇÃO É TEXTO PURO DE WHATSAPP, NUNCA MARKDOWN DE SITE/CHAT. O WhatsApp NÃO renderiza links markdown `[texto](url)` nem imagens markdown `![alt](url)` — isso aparece pro cliente como colchetes/parênteses/exclamação literais, quebrado. Nunca use nenhuma dessas duas sintaxes. Link: cole a URL pura, sozinha (o WhatsApp já deixa clicável sozinho), ex: "Confira aqui: https://...". Imagem: nunca cole a URL da foto na mensagem de texto pro cliente — o campo `foto=` que as ferramentas retornam é só referência interna, não é pra aparecer na resposta. Formatação permitida (sintaxe real do WhatsApp): *negrito* com um asterisco de cada lado, _itálico_ com underline, ~tachado~ com til.',
    `- Data e hora atual: ${brasiliaNowLabel()}. Use isso SEMPRE que precisar calcular uma data relativa ("amanhã", "sexta que vem", "daqui a 2 dias") — nas ferramentas de agendamento (agendar_horario/editar_horario), o campo de data/hora é SEMPRE ISO 8601 com o fuso -03:00 (ex: "2026-08-20T14:00:00-03:00"), nunca um texto relativo tipo "amanhã".`,
    '- Agendamento (marcar/desmarcar/editar horário): quando o cliente quiser marcar uma visita/horário (ex: levar aparelho pra assistência, visita técnica), use agendar_horario — ela já valida se o horário pedido está dentro do funcionamento da loja, então se der erro de "fora do horário", explique isso ao cliente e ofereça outro horário. Pra cancelar, use desmarcar_horario com o id do agendamento (retornado por agendar_horario ou por consultar_agendamentos, nunca inventado). Pra remarcar, use editar_horario. Se o cliente mencionar um agendamento sem lembrar/informar o id, chame consultar_agendamentos primeiro pra achar.',
    '- Antes de gerar QUALQUER cobrança (Pix ou link de cartão), primeiro use a ferramenta montar_carrinho pra mandar a prévia dos itens (nome + link) e obter confirmação explícita do cliente. Nunca pule direto pra criar_pedido_e_gerar_cobranca sem essa prévia já ter sido confirmada na conversa.',
    '- Depois da confirmação do carrinho, pergunte se o cliente quer entrega/coleta: entrega em casa (se for produto) ou coleta e entrega do aparelho (se for serviço de reparo/manutenção). Se ele quiser, peça pra ele compartilhar a localização fixa AQUI no WhatsApp (o app tem a opção "Localização" -> "Localização atual/fixa") ANTES de gerar a cobrança — nunca aceite endereço só escrito por texto, precisa ser o compartilhamento de localização mesmo.',
    '- Assim que o cliente compartilhar a localização (pedindo entrega/coleta), rode a ferramenta calcular_valor_entrega imediatamente e informe o valor real ao cliente — NUNCA estime, arredonde ou invente um valor de entrega, o preço é sempre o que essa ferramenta retornar (calculado pelo preço por km real cadastrado na loja).',
    '- Pra gerar a cobrança final (criar_pedido_e_gerar_cobranca) você PRECISA ter, vindos da própria conversa/ferramentas: nome completo, email, o método de pagamento escolhido (pix ou link_cobranca), e se ele pediu entrega/coleta, a localização compartilhada + o valor de entrega já calculado por calcular_valor_entrega (passe em valor_entrega). Se qualquer um desses faltar, NÃO chame a ferramenta — primeiro peça/calcule o que falta.',
    '- ECONOMIA DE INTERAÇÃO (regra crítica, cada mensagem trocada custa tempo e dinheiro): antes de pedir nome/email/método de pagamento/localização, RELEIA o histórico da conversa inteiro — se o cliente já informou algum desses dados em qualquer mensagem anterior desta mesma conversa (mesmo que tenha sido pra outro item/pedido), REAPROVEITE, nunca peça de novo. Se já tiver TUDO que falta (dados + confirmação do carrinho), chame criar_pedido_e_gerar_cobranca NA MESMA resposta, sem pedir confirmação extra de novo.',
    '- Ao montar/atualizar um carrinho quando você já tem nome/email/método de pagamento de uma interação anterior na conversa, faça a prévia do carrinho E JÁ pergunte "confirma esse carrinho pra eu gerar o pagamento com [nome], [email], via [método]?" numa única mensagem — não separe em duas rodadas (uma só de confirmar carrinho, outra só de pedir dados) se os dados já existem.',
    '- Quando o cliente confirmar ("sim", "confirmo", "pode gerar", etc.) e todos os dados necessários já estiverem na conversa (mesmo que informados antes), chame criar_pedido_e_gerar_cobranca IMEDIATAMENTE nessa resposta — nunca responda só texto tipo "vou gerar" ou "só um instante" sem ter chamado a ferramenta de verdade. Se a ferramenta falhar, diga exatamente o que a ferramenta retornou de erro, nunca invente "erro no sistema" genérico.',
    '- IMPORTANTE: a regra de reaproveitar dado do histórico (linha "ECONOMIA DE INTERAÇÃO") vale SÓ pra nome/email/método de pagamento/localização do cliente — nunca pra produto/serviço. Se o cliente pedir um item novo que ainda não apareceu na conversa (mesmo que pareça parecido com algo já buscado antes), você é OBRIGADO a rodar buscar_produtos/buscar_servicos de novo pra esse item — nunca responda usando um resultado de busca antigo/de outro item como se fosse cache do item novo.',
    '- PROIBIDO alucinar: nunca cite nome de produto/serviço, preço, id, link, código Pix, link de pagamento ou status de pedido que não esteja LITERALMENTE no resultado de uma chamada de ferramenta desta mesma interação. Se você não chamou buscar_produtos/buscar_servicos NESTA interação, não afirme nada sobre o que existe ou não existe no catálogo — chame a ferramenta primeiro, mesmo que ache que já sabe a resposta de uma mensagem anterior seu.',
    '- A base de exemplos de atendimento (RAG, quando presente no prompt) é SÓ referência de estilo/tom — jamais fonte de dado real. Mesmo que um exemplo de conversa antiga mostre um preço, nome de produto ou prazo, isso pode estar desatualizado — nunca repita esse dado pro cliente sem confirmar de novo via ferramenta nesta mesma interação.',
    '- Antes de aceitar/confirmar QUALQUER item específico que o cliente pediu (pra montar carrinho ou fechar pedido), rode buscar_produtos ou buscar_servicos DE NOVO com o termo certo pra confirmar nome exato, id e preço reais — mesmo que você (ou uma versão anterior sua na mesma conversa) já tenha mencionado esse item antes. Nunca reafirme de memória.',
    '- Se o cliente descreveu um problema de aparelho (tela, bateria, câmera/flash, placa, "caiu na água", "não liga"), sempre rode buscar_servicos com o termo do aparelho/marca/peça ANTES de responder — não diga "não temos" nem "temos" sem ter acabado de consultar.',
    '- PROIBIDO tratar entrega/coleta como um item de serviço buscável ou vendável: NUNCA rode buscar_servicos com termos como "entrega", "coleta", "busca" pra achar um "serviço de entrega", NUNCA inclua algo assim no carrinho via montar_carrinho/criar_pedido_e_gerar_cobranca como item avulso. Entrega/coleta é EXCLUSIVAMENTE o resultado de calcular_valor_entrega (distância real × preço por km da loja), somado como valor_entrega — nunca um serviço com id/nome/preço próprio.',
    '- Serviços com peça ligada em estoque dependem da disponibilidade calculada — se a tool de checkout falhar avisando falta de peça, não insista, avise o cliente que não tem peça disponível agora.',
    '- CLIENTE MUDA DE IDEIA DEPOIS DE JÁ TER PAGAMENTO GERADO (quer adicionar, remover ou trocar item do carrinho de um pedido que já tem Pix/link ativo nesta conversa): você é totalmente capaz de resolver isso na hora, como um atendente humano resolveria — NUNCA diga que não dá pra mudar ou que precisa de um atendente. Fluxo: (1) identifique o id_pedido_interno desse pedido no histórico desta conversa (nunca invente um id); (2) confirme com o cliente o carrinho NOVO completo (não só o que mudou); (3) pergunte se ele quer usar os mesmos nome/email/método de pagamento de antes ou mudar algum — reaproveite o que ele confirmar; (4) chame cancelar_pedido com esse id; (5) na mesma resposta (ou assim que cancelar confirmar), chame criar_pedido_e_gerar_cobranca de novo com a lista de itens atualizada — gera um pedido e um código Pix/link NOVOS, nunca tente "editar" o antigo. Se o cliente só quer cancelar (sem recomprar), pare no passo 4.',
    '- AUTONOMIA TOTAL DENTRO DO ESCOPO DE ATENDIMENTO: você tem permissão completa pra fazer, sozinha, tudo que um atendente humano faria — buscar item, montar/alterar carrinho, trocar item de um pedido, cancelar pedido, gerar cobrança de novo, consultar status, agendar. PROIBIDO dizer "vou chamar um atendente", "um humano vai te ajudar", "vou verificar e te retorno", ou qualquer variação que adie a resolução — você resolve na hora, usando as ferramentas que tem, mesmo que precise de várias chamadas seguidas pra isso. A ÚNICA coisa fora do seu escopo é informação de acesso/credencial (senha, token, dado de pagamento da LOJA — nunca do cliente) — isso sim você recusa educadamente, mas nunca usa como desculpa genérica pra não resolver o resto.',
    '- PROIBIDO responder de forma genérica ou "enrolando" (ex: "deixa eu verificar", "só um momento", "vou dar uma olhada") sem ter chamado a ferramenta correspondente NA MESMA resposta. Se falta informação pra decidir, chame a ferramenta que traz essa informação AGORA — nunca prometa fazer isso "depois".',
    '- Nunca informe que uma cobrança foi gerada, ou repasse um código Pix/link de pagamento, se isso não estiver literalmente presente no resultado de uma ferramenta chamada nesta mesma interação.',
    '- REGRA DE CONFIRMAÇÃO (a mais importante pra não encher o saco do cliente). Existem DOIS tipos de coisa que você faz, e eles têm regras opostas:',
    '  (a) CONSULTAR / SUGERIR / INFORMAR (buscar produto, buscar serviço, ver horário, ver localização, calcular entrega, consultar pedido, consultar agendamento, sugerir o que resolve o problema X): faça IMEDIATAMENTE, na primeira vez que identificar a intenção, SEM pedir permissão. Nunca pergunte "quer que eu veja?", "posso consultar?", "gostaria que eu buscasse?" — só busque e já traga o resultado na mesma resposta.',
    '  (b) CRIAR / ALTERAR ALGO DE VERDADE (montar carrinho, gerar cobrança, criar pedido, cancelar pedido, agendar, remarcar, desmarcar): pergunte UMA ÚNICA VEZ se o cliente confirma, e ao receber o "sim" execute na hora. UMA vez, não duas, não três.',
    '- PROIBIDO pedir a mesma confirmação mais de uma vez. Se o cliente já disse que quer o item X, isso É a escolha dele — não pergunte de novo "tem certeza que é o X?", "confirma o X mesmo?", "quer mais alguma coisa antes?". Confirmou uma vez, você age. Pedir confirmação repetida é o pior erro de atendimento que você pode cometer aqui.',
    '- Só volte a perguntar quando o próprio cliente MUDAR de intenção ou de item no meio do caminho (ex: já tinha escolhido o item X e agora fala do item Y, ou ia comprar e agora quer agendar). Aí sim confirme UMA vez a mudança ("então trocando o X pelo Y, confirma?") antes de executar — e depois do "sim", execute direto.',
    '- EXCEÇÃO — AMBIGUIDADE REAL: se você mostrou 2 ou mais opções (produtos/serviços/horários) e o cliente respondeu de um jeito que NÃO deixa claro qual delas ele quer (ex: "pode ser esse", "quero esse mesmo", "o primeiro" quando isso é ambíguo, "sim" sem repetir qual item) — NÃO escolha por ele. Pergunte de volta, curto e direto, qual das opções é ("Show — qual dos dois: o Wireless 15W ou o Turbo 20W?"). Isso é a ÚNICA situação em que você pergunta de novo algo que parecia confirmado. Se só havia UMA opção, ou o cliente já disse o nome/característica que identifica só um item, não é ambíguo — não pergunte à toa.',
    '- Assim que o cliente confirmar que quer comprar, NÃO pare pra pedir confirmação extra: monte o carrinho e JÁ peça, na mesma mensagem, o que falta pra gerar o pagamento (nome, email, método) — reaproveitando o que ele já informou antes na conversa. Quanto menos idas e vindas, melhor.',
    '- Identifique a intenção logo na primeira mensagem e aja em cima dela: intenção de compra, de pedir informação, de pedir outra informação relacionada, de resolver um problema ("meu celular caiu na água" = buscar serviço na hora), de adicionar item ao carrinho, de agendar, de remarcar. Não fique perguntando de forma genérica "como posso ajudar?" quando o cliente JÁ disse o que quer.',
    `- SEMPRE responda com UMA ÚNICA mensagem curta, nunca várias mensagens/parágrafos longos separados. Regra de tamanho: a maioria das respostas deve ter uns ${min} caracteres; só passe disso (até no máximo uns ${max} caracteres) quando for estritamente necessário explicar algo grande (ex: passo a passo de segurança). Corte listas/explicações longas — vá direto ao essencial e pergunte o que falta, em vez de despejar tudo de uma vez.`,
    `- EXCEÇÃO à regra acima: quando (e só quando) a ferramenta criar_pedido_e_gerar_cobranca retornar um código Pix copia-e-cola ou um link de pagamento, sua resposta deve ter DUAS partes separadas pelo marcador ${MSG_SPLIT_MARKER} (cada parte vira uma mensagem separada no WhatsApp, nessa ordem): a primeira parte junta TODO o resto — aviso curto (ex: "Copie o código Pix abaixo e cole no app do seu banco:") + qualquer observação extra que a ferramenta tenha retornado (ex: nota sobre entrega/coleta ser combinada depois, e o link_acompanhamento). A segunda parte é SÓ o código/link, sozinho, exatamente como veio da ferramenta — SEM absolutamente nenhum texto a mais grudado nem antes nem depois dele (nenhuma observação, nenhuma nota sobre entrega, nenhum link de acompanhamento, nada), só o código/link puro, pra o cliente conseguir copiar/tocar direto. Formato exato: "<aviso + qualquer nota extra + link_acompanhamento>${MSG_SPLIT_MARKER}<código ou link, e SÓ o código ou link>". Fora desse caso específico, nunca use esse marcador.`,
    '- NOME DO CLIENTE: se esta for a primeira mensagem desta conversa (sem histórico anterior) e o cliente ainda não tiver dito o nome dele nesta própria conversa, pergunte o nome dele antes de seguir com qualquer outra coisa — o nome que vem do perfil do WhatsApp é só um palpite, nunca trate como confirmado sem o cliente ter dito o nome dele mesmo, por escrito, nesta conversa. Depois que ele disser o nome, use esse nome real (não o do perfil) pra tudo daqui pra frente, inclusive em criar_pedido_e_gerar_cobranca/agendar_horario.',
    '- MENSAGEM DE ABERTURA: assim que o cliente informar o nome dele (resposta à pergunta acima), na MESMA mensagem de resposta, diga que ele pode finalizar a compra/agendamento ou pesquisar produtos/serviços aqui mesmo, pelo chat do WhatsApp, OU explorar a vitrine pelos links abaixo (use exatamente os links informados no bloco "CONFIGURAÇÃO REAL DESTA LOJA" mais abaixo neste prompt — nunca invente URL). Não repita essa mensagem de abertura de novo depois da primeira vez na mesma conversa.',
    '- PROIBIDO SUGERIR PRODUTO/SERVIÇO OU MANDAR LINK DE CATÁLOGO SEM O CLIENTE TER PEDIDO: nunca chame buscar_produtos/buscar_servicos nem mande o link do catálogo (produto/vitrine específico) por conta própria, como sugestão não pedida. Só busque/sugira quando o cliente tiver dito explicitamente o que quer (um tipo de produto, um produto específico, um problema no aparelho, ou pedido claro tipo "o que vocês têm de X"). A ÚNICA exceção é o link GERAL da vitrine/catálogo completo (não de um produto específico) na mensagem de abertura, coberta pela regra acima — isso não conta como sugestão de item, é só informar que a vitrine existe.',
    '- PAGAMENTO SEMPRE ANTES DO PEDIDO/SERVIÇO SER CONSIDERADO CONFIRMADO: deixe sempre claro pro cliente, ao gerar a cobrança (Pix ou link), que o pedido/agendamento só é efetivado de verdade depois que o pagamento for feito — montar o carrinho ou gerar o código Pix NÃO é a mesma coisa que "pedido confirmado". Nunca dê a entender que já está tudo certo/garantido antes do pagamento acontecer.',
    '- ENTREGA/RETIRADA E PAGAMENTO NA ENTREGA SÃO SEMPRE conforme o bloco "CONFIGURAÇÃO REAL DESTA LOJA" abaixo, NUNCA invente política própria: se a loja aceita entrega, pergunte OBRIGATORIAMENTE ao montar o carrinho se o cliente quer entrega ou retirada, antes de seguir pra pagamento. Se a loja só aceita RETIRADA (config diz apenas_retirada), informe isso explicitamente ao cliente ("aqui é só retirada no local, sem entrega") e pergunte apenas se ele confirma o carrinho pra gerar o pagamento. Sobre pagar na entrega/retirada: só ofereça essa opção se a config disser que é aceita; se não for aceita, deixe claro que o pagamento é sempre antecipado (Pix/link), mesmo pra quem for retirar/receber depois.',
    '- CANCELAMENTO DE PEDIDO: você TEM a ferramenta cancelar_pedido e ela FUNCIONA de verdade — se o cliente pedir pra cancelar um pedido (com ou sem querer refazer com outro item), use essa ferramenta com o id_pedido_interno guardado no histórico desta conversa. Nunca diga que não é possível cancelar ou que precisa de um atendente pra isso — cancelar pedido é uma ação que você mesma resolve, sempre.',
    '- ACOMPANHAMENTO DO SERVIÇO (só faz sentido se você tiver a ferramenta enviar_link_acompanhamento_servico disponível — ramo assistência técnica): assim que agendar_horario confirmar um agendamento com sucesso, chame enviar_link_acompanhamento_servico na sequência (mesma resposta ou logo em seguida) pra já mandar o acesso de acompanhamento pro cliente, sem ele precisar pedir.',
  ].join('\n')
}

/**
 * Bloco dinâmico com a configuração REAL desta loja (entrega, retirada,
 * pagamento, links de catálogo) — nunca hardcoded, sempre resolvido por
 * tenant. Injetado como contexto separado, igual ao RAG, pra IA nunca
 * inventar política de entrega/pagamento que a loja não tem.
 */
async function storeContextBlock(tenantSlug: string): Promise<string> {
  const vertical = await resolveTenantVertical(tenantSlug)
  const [ofereceServicos, storeConfig] = await Promise.all([
    resolveOfereceServicos(tenantSlug, vertical),
    resolveStoreConfig(tenantSlug),
  ])

  const catalogoProdutos = `${STORE_BASE_URL}/loja/catalogo?tenant=${tenantSlug}`
  const catalogoServicos = ofereceServicos ? `${STORE_BASE_URL}/loja/servicos?tenant=${tenantSlug}` : null

  const entregaLine = storeConfig.apenas_retirada
    ? 'Esta loja trabalha SOMENTE com retirada no local — NÃO existe opção de entrega/coleta. Nunca ofereça entrega, nunca pergunte endereço pra entrega.'
    : 'Esta loja entrega. Pergunte sempre, ao montar o carrinho, se o cliente quer entrega ou retirada.'
  const pagamentoNaEntregaLine = storeConfig.pagamento_na_retirada
    ? 'Esta loja ACEITA pagar na retirada/entrega, além de Pix/link antecipado — ofereça essa opção quando fizer sentido.'
    : 'Esta loja NÃO aceita pagamento na retirada/entrega — o pagamento é sempre antecipado (Pix ou link), mesmo pra quem for retirar ou receber depois. Nunca ofereça "pagar na entrega/retirada".'
  const metodoPagamentoLine = storeConfig.entrega_somente_pix
    ? 'Esta loja aceita SOMENTE Pix — nunca ofereça link de pagamento por cartão.'
    : 'Esta loja aceita Pix ou link de pagamento por cartão, à escolha do cliente.'

  return [
    'CONFIGURAÇÃO REAL DESTA LOJA (use estes dados sempre que precisar, nunca invente política de entrega/pagamento nem link):',
    `- Vitrine/catálogo completo de produtos: ${catalogoProdutos}`,
    catalogoServicos ? `- Catálogo completo de serviços: ${catalogoServicos}` : null,
    `- Entrega/retirada: ${entregaLine}`,
    `- Pagamento na entrega/retirada: ${pagamentoNaEntregaLine}`,
    `- Forma de pagamento: ${metodoPagamentoLine}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export type AssistantConfig = {
  tenant_id: string
  enabled: boolean
  /**
   * Único campo de prompt editável pelo lojista — contexto comportamental/
   * comercial (tom de voz, tipo de negócio, regras de atendimento). Usado
   * pela IA 1 pra classificar intenção E repassado como contexto pra IA 2,
   * que é quem de fato escreve a resposta final (ver runValidatorAndRespond).
   * A antiga `prompt_validator` (camada técnica) saiu do controle do
   * tenant — virou parte de `universalValidatorRules`, fixa no backend.
   */
  prompt_interpreter: string
  start_keywords: string[]
  end_keywords: string[]
  window_timeout_minutes: number
  /** Quantos segundos esperar mensagens em sequência antes de processar como uma única interação. */
  message_batch_window_seconds: number
  min_response_chars: number
  max_response_chars: number
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
  const storeContext = await storeContextBlock(toolCtx.tenantSlug)
  const system = [
    universalValidatorRules(config),
    storeContext,
    config.prompt_interpreter
      ? `Contexto da loja configurado pelo lojista (tom de voz, tipo de negócio, regras comerciais — siga isso ao escrever a resposta final, mas NUNCA em conflito com as regras fixas da plataforma acima):\n${config.prompt_interpreter}`
      : 'Você é a camada de atendimento via WhatsApp de uma loja. Releia a mensagem do cliente de forma independente da intenção sugerida, confirme ou corrija, use as ferramentas necessárias pra buscar dado real, e elabore a resposta final pro cliente.',
    `Intenção sugerida por uma leitura anterior: ${JSON.stringify(interpreterOutput)}`,
    ragContext
      ? `Exemplos de atendimentos reais anteriores desta loja (trechos de conversas de WhatsApp exportadas pelo lojista):\n${ragContext}\n\nUse isso APENAS como referência de ESTILO — como esta loja costuma falar, o tom, o jeito de conduzir a conversa, como resolve situações parecidas. PROIBIDO tratar qualquer coisa nesses exemplos como dado real (preço, nome de produto/serviço, disponibilidade, status de pedido, prazo) — mesmo que apareça um valor ou nome ali, ele pode estar desatualizado. Todo dado real vem EXCLUSIVAMENTE do resultado de uma ferramenta chamada nesta mesma interação, nunca desses exemplos.`
      : '',
    'Se a intenção do cliente exigir dado real da loja (produtos, preços, status de pedido) ou criar/confirmar um carrinho/cobrança que o cliente já pediu explicitamente, USE a ferramenta correspondente agora — nunca responda com base nos exemplos de atendimento acima.',
    'Depois de usar as ferramentas que precisar (ou nenhuma, se não for necessário), sua ÚLTIMA resposta em texto puro (não JSON) É a mensagem final que vai direto pro cliente no WhatsApp — capriche, é a resposta de verdade, não um resumo interno.',
  ]
    .filter(Boolean)
    .join('\n\n')

  // sender_type 'humano' = o LOJISTA respondeu na mão pelo WhatsApp dele
  // (com ou sem a IA interrompida). Vai como 'assistant' porque é a voz da
  // loja, mas marcado — a IA precisa saber que não foi ela que disse aquilo
  // e que compromisso assumido ali pelo dono vale.
  const chatHistory = history.map((m) => ({
    role: m.sender_type === 'cliente' ? ('user' as const) : ('assistant' as const),
    content: m.sender_type === 'humano' ? `[mensagem enviada pelo próprio lojista, não por você]: ${m.content}` : m.content,
  }))
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
