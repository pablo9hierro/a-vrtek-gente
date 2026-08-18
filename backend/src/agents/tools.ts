import { sendWhatsappLocation } from '../evolution-adapter/send.js'

/**
 * Ferramentas que a IA pode chamar pra consultar/agir em dados REAIS da
 * loja — cada uma é um adapter fino pra um endpoint do backend do
 * Resolutoo (nunca acesso direto ao banco de produção a partir deste
 * módulo). Desenhado pra virar um servidor MCP de verdade depois (uma
 * tool por arquivo/capacidade); por ora são funções TypeScript chamadas
 * via tool use (formato "function calling" comum a OpenAI/OpenRouter) —
 * mesmo contrato de entrada/saída que um MCP tool teria, só sem o
 * protocolo por cima ainda.
 *
 * Quem chama essas tools é a IA 2 (validador), não a IA 3 — a IA 3 só
 * recebe o resultado já pronto.
 */

const ECOMMERCE_API_URL = process.env.ECOMMERCE_API_URL || 'https://ecommerce-api-production-d447.up.railway.app'
const STORE_BASE_URL = process.env.STORE_BASE_URL || 'https://resolutoo.com'

export type ToolDefinition = {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export const tools: ToolDefinition[] = [
  {
    name: 'buscar_produtos',
    description:
      'Busca produtos ativos no catálogo real da loja. Use sempre que o cliente perguntar o que a loja vende, pedir o cardápio/catálogo, ou perguntar sobre um produto específico. Retorna id, nome, preço, descrição e o link público (sitemap) de cada produto — id e link são necessários pra montar o carrinho depois.',
    input_schema: {
      type: 'object',
      properties: {
        termo: {
          type: 'string',
          description: 'Palavra-chave pra filtrar (nome do produto). Deixe vazio pra listar tudo.',
        },
      },
    },
  },
  {
    name: 'buscar_servicos',
    description:
      'Busca serviços reais oferecidos pela loja (reparo, troca, manutenção etc.) — nome, descrição, categoria, preço e link público (sitemap). Use sempre que o cliente perguntar sobre serviços, conserto, reparo, troca de peça, ou pedir orçamento de manutenção.',
    input_schema: {
      type: 'object',
      properties: {
        termo: {
          type: 'string',
          description: 'Palavra-chave pra filtrar (nome do serviço, aparelho ou marca). Deixe vazio pra listar tudo.',
        },
      },
    },
  },
  {
    name: 'consultar_horario_funcionamento',
    description:
      'Consulta o horário de funcionamento real da loja (dias e horas de abertura/fechamento) e se ela está atualmente aberta ou fechada manualmente. Use sempre que o cliente perguntar se a loja está aberta, até que horas funciona, ou horário de algum dia específico.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_localizacao_loja',
    description:
      'Manda a localização real da loja como PIN de localização de verdade no WhatsApp do cliente (não é só texto — a ferramenta já envia o pin sozinha). Use sempre que o cliente perguntar onde a loja fica, o endereço, ou pedir a localização pra ir buscar/entregar algo. Depois de usar, só confirme em texto que mandou.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'calcular_valor_entrega',
    description:
      'Calcula o valor REAL da entrega/coleta, usando o preço por km cadastrado pelo lojista (o mesmo valor que a loja cobra no checkout normal) e a distância até a localização que o cliente compartilhou. Use SEMPRE que o cliente pedir entrega/coleta, depois que ele já compartilhou a localização fixa no chat — nunca invente ou estime o valor da entrega de outro jeito.',
    input_schema: {
      type: 'object',
      properties: {
        localizacao_compartilhada: {
          type: 'string',
          description: 'O texto exato que apareceu no histórico como "[Cliente compartilhou localização fixa: https://maps.google.com/?q=lat,lng]".',
        },
      },
      required: ['localizacao_compartilhada'],
    },
  },
  {
    name: 'consultar_pedido',
    description:
      'Consulta os pedidos recentes do cliente na loja de verdade — por padrão usa o telefone da própria conversa. Use sempre que o cliente perguntar sobre status/andamento de um pedido já feito. Se não achar nada pelo telefone da conversa, pergunte se o pedido foi feito com outro número de WhatsApp; se o cliente informar outro número, chame de novo passando outro_telefone. Se o pedido estiver "saiu pra entrega", a resposta já vem com o tempo estimado restante — repasse isso ao cliente.',
    input_schema: {
      type: 'object',
      properties: {
        outro_telefone: {
          type: 'string',
          description: 'Só preencha se o cliente confirmar que o pedido foi feito com um número de WhatsApp diferente do desta conversa.',
        },
      },
    },
  },
  {
    name: 'montar_carrinho',
    description:
      'Monta e retorna uma PRÉVIA do carrinho (nome de cada produto/serviço + link público pra o cliente conferir), SEM criar pedido e SEM gerar cobrança. Use SEMPRE assim que entender quais produtos/serviços o cliente quer, ANTES de perguntar dados de checkout ou gerar qualquer cobrança — a prévia precisa ser confirmada pelo cliente primeiro.',
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          description: 'Itens escolhidos pelo cliente (produtos e/ou serviços).',
          items: {
            type: 'object',
            properties: {
              tipo: { type: 'string', enum: ['produto', 'servico'] },
              id: { type: 'string', description: 'id do produto (vindo de buscar_produtos) — obrigatório se tipo=produto.' },
              nome: { type: 'string', description: 'nome do item (vindo de buscar_produtos/buscar_servicos), usado na prévia.' },
              quantidade: { type: 'integer', minimum: 1 },
            },
            required: ['tipo', 'nome', 'quantidade'],
          },
        },
      },
      required: ['itens'],
    },
  },
  {
    name: 'criar_pedido_e_gerar_cobranca',
    description:
      'Cria de verdade um pedido com os produtos e/ou serviços que o cliente confirmou (depois de já ter visto e aceitado a prévia do carrinho via montar_carrinho) e gera a cobrança no método escolhido pelo cliente (pix ou link de cobrança/cartão). Use SÓ depois que o cliente: (1) confirmou os itens na prévia do carrinho, (2) informou nome e email, (3) escolheu o método de pagamento, e (4) se pediu entrega/coleta, já compartilhou a localização E você já rodou calcular_valor_entrega pra saber o valor real (passe esse valor em valor_entrega). Nunca invente nome, email, método, localização ou valor de entrega — pergunte/calcule se faltar. Se o serviço depender de peça em estoque e não tiver disponibilidade suficiente, a chamada falha — nesse caso avise que não tem peça disponível agora. Pedido sempre nasce pendente de pagamento — nunca já pago.',
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          description: 'Lista de itens do carrinho — cada um com produto_id OU servico_id (nunca os dois) e quantidade.',
          items: {
            type: 'object',
            properties: {
              produto_id: { type: 'string', description: 'id do produto, vindo de buscar_produtos.' },
              servico_id: { type: 'string', description: 'id do serviço, vindo de buscar_servicos.' },
              quantidade: { type: 'integer', minimum: 1 },
            },
            required: ['quantidade'],
          },
        },
        nome_cliente: { type: 'string', description: 'Nome completo informado pelo cliente pra finalizar o pedido.' },
        email_cliente: { type: 'string', description: 'Email informado pelo cliente pra finalizar o pedido.' },
        metodo_pagamento: {
          type: 'string',
          enum: ['pix', 'link_cobranca'],
          description: '"pix" gera código copia-e-cola. "link_cobranca" gera um link de pagamento por cartão.',
        },
        quer_entrega_ou_coleta: {
          type: 'boolean',
          description: 'true se o cliente pediu entrega (produto) ou coleta+entrega do aparelho (serviço). false pra retirada no local.',
        },
        localizacao_compartilhada: {
          type: 'string',
          description: 'O texto/link exato da localização que o cliente compartilhou no chat (aparece no histórico como "[Cliente compartilhou localização fixa: ...]"). Obrigatório se quer_entrega_ou_coleta=true.',
        },
        valor_entrega: {
          type: 'number',
          description: 'O valor de entrega/coleta que a tool calcular_valor_entrega retornou (número puro, ex: 12.50) — obrigatório se quer_entrega_ou_coleta=true. NUNCA um valor inventado/estimado por você.',
        },
      },
      required: ['itens', 'nome_cliente', 'email_cliente', 'metodo_pagamento'],
    },
  },
  {
    name: 'cancelar_pedido',
    description:
      'Cancela DE VERDADE um pedido já criado nesta conversa (identificado pelo id_pedido_interno devolvido por criar_pedido_e_gerar_cobranca). Use quando: (1) o cliente pede pra cancelar um pedido/pagamento que ele mesmo fez, ou (2) o cliente quer MUDAR o carrinho de um pedido que já tem pagamento gerado (adicionar/remover/trocar item) — nesse caso, cancele o pedido antigo com esta ferramenta e IMEDIATAMENTE chame criar_pedido_e_gerar_cobranca de novo com a lista de itens atualizada, reaproveitando nome/email/entrega já informados nesta conversa (confirme com o cliente se ele quer usar os mesmos dados de novo antes de gerar a nova cobrança). Não funciona depois que o pedido já saiu pra entrega/coleta.',
    input_schema: {
      type: 'object',
      properties: {
        id_pedido_interno: {
          type: 'string',
          description: 'O id_pedido_interno devolvido por criar_pedido_e_gerar_cobranca nesta mesma conversa — nunca um id inventado ou o número/short_id que aparece pro cliente.',
        },
      },
      required: ['id_pedido_interno'],
    },
  },
]

type ToolCtx = { tenantSlug: string; phone: string; customerName: string | null; instance: string }

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  try {
    if (name === 'buscar_produtos') return await buscarProdutos(ctx.tenantSlug, String(input.termo ?? ''))
    if (name === 'buscar_servicos') return await buscarServicos(ctx.tenantSlug, String(input.termo ?? ''))
    if (name === 'consultar_horario_funcionamento') return await consultarHorario(ctx.tenantSlug)
    if (name === 'consultar_localizacao_loja') return await consultarLocalizacao(ctx)
    if (name === 'calcular_valor_entrega') return await calcularValorEntrega(ctx.tenantSlug, String(input.localizacao_compartilhada ?? ''))
    if (name === 'consultar_pedido')
      return await consultarPedido(ctx.tenantSlug, ctx.phone, input.outro_telefone ? String(input.outro_telefone) : undefined)
    if (name === 'montar_carrinho') {
      const itens = Array.isArray(input.itens)
        ? (input.itens as { tipo: 'produto' | 'servico'; id?: string; nome: string; quantidade: number }[])
        : []
      return montarCarrinho(ctx.tenantSlug, itens)
    }
    if (name === 'criar_pedido_e_gerar_cobranca') {
      const itens = Array.isArray(input.itens)
        ? (input.itens as { produto_id?: string; servico_id?: string; quantidade: number }[])
        : []
      return await criarPedidoEGerarCobranca(ctx, itens, {
        nomeCliente: String(input.nome_cliente ?? ''),
        emailCliente: String(input.email_cliente ?? ''),
        metodoPagamento: input.metodo_pagamento === 'link_cobranca' ? 'link_cobranca' : 'pix',
        querEntregaOuColeta: Boolean(input.quer_entrega_ou_coleta),
        localizacaoCompartilhada: input.localizacao_compartilhada ? String(input.localizacao_compartilhada) : null,
        valorEntrega: typeof input.valor_entrega === 'number' ? input.valor_entrega : null,
      })
    }
    if (name === 'cancelar_pedido') return await cancelarPedido(ctx.phone, String(input.id_pedido_interno ?? ''))
    return `Ferramenta desconhecida: ${name}`
  } catch (e) {
    return `Erro ao consultar: ${e instanceof Error ? e.message : String(e)}`
  }
}

function produtoLink(tenantSlug: string, id: string): string {
  return `${STORE_BASE_URL}/loja/produto/${id}?tenant=${tenantSlug}`
}

function servicoLink(tenantSlug: string, id: string): string {
  return `${STORE_BASE_URL}/loja/servico/${id}?tenant=${tenantSlug}`
}

/**
 * Busca por PALAVRA, não frase exata — "reparo de câmera" precisa achar
 * "Troca de Flash (Câmera) iPhone" mesmo sem a frase inteira bater como
 * substring. Ignora palavras curtas/comuns (de, do, da, pra...) que só
 * atrapalhariam o match. Casa se QUALQUER palavra relevante do termo
 * aparecer em algum dos campos buscáveis do item.
 */
const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'a', 'o', 'e', 'pra', 'para', 'com', 'um', 'uma'])
function matchesTermo(termo: string, ...campos: (string | undefined)[]): boolean {
  const palavras = termo
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  if (palavras.length === 0) return true
  const alvo = campos.filter(Boolean).join(' ').toLowerCase()
  return palavras.some((w) => alvo.includes(w))
}

async function buscarProdutos(tenantSlug: string, termo: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/products`)
  if (!res.ok) return 'Não foi possível consultar o catálogo agora.'
  const products = (await res.json()) as { id: string; name: string; price: number; description?: string; image_url?: string }[]
  const filtered = termo ? products.filter((p) => matchesTermo(termo, p.name, p.description)) : products
  if (filtered.length === 0) return termo ? `Nenhum produto encontrado pra "${termo}".` : 'A loja não tem produtos cadastrados no catálogo ainda.'
  return filtered
    .slice(0, 20)
    .map(
      (p) =>
        `- id=${p.id} | ${p.name}: R$ ${p.price.toFixed(2).replace('.', ',')}${p.description ? ` — ${p.description}` : ''} | link=${produtoLink(tenantSlug, p.id)}${p.image_url ? ` | foto=${p.image_url}` : ''}`,
    )
    .join('\n')
}

async function buscarServicos(tenantSlug: string, termo: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/services`)
  if (!res.ok) return 'Não foi possível consultar os serviços agora.'
  const services = (await res.json()) as { id: string; name: string; description: string; category_name?: string; price: number }[]
  const filtered = termo ? services.filter((s) => matchesTermo(termo, s.name, s.category_name, s.description)) : services
  if (filtered.length === 0) return termo ? `Nenhum serviço encontrado pra "${termo}".` : 'A loja não tem serviços cadastrados ainda.'
  return filtered
    .slice(0, 20)
    .map(
      (s) =>
        `- id=${s.id} | ${s.name}${s.category_name ? ` (${s.category_name})` : ''}: R$ ${s.price.toFixed(2).replace('.', ',')}${s.description ? ` — ${s.description}` : ''} | link=${servicoLink(tenantSlug, s.id)}`,
    )
    .join('\n')
}

const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']

async function consultarHorario(tenantSlug: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/store-status`)
  if (!res.ok) return 'Não foi possível consultar o horário de funcionamento agora.'
  const status = (await res.json()) as {
    hours: { day_of_week: number; is_open: boolean; intervals: { opens_at: string; closes_at: string }[] }[]
    manually_closed: boolean
    manual_closed_reason?: string | null
  }
  const lines = status.hours.map((h) => {
    const dayName = WEEKDAY_NAMES[h.day_of_week] ?? `dia ${h.day_of_week}`
    if (!h.is_open || h.intervals.length === 0) return `${dayName}: fechado`
    return `${dayName}: ${h.intervals.map((i) => `${i.opens_at}–${i.closes_at}`).join(', ')}`
  })
  const closedNote = status.manually_closed
    ? `\nAVISO: a loja está fechada manualmente agora${status.manual_closed_reason ? ` (${status.manual_closed_reason})` : ''}, independente do horário normal.`
    : ''
  return lines.join('\n') + closedNote
}

async function consultarLocalizacao(ctx: ToolCtx): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${ctx.tenantSlug}/store-status`)
  if (!res.ok) return 'Não foi possível consultar a localização da loja agora.'
  const status = (await res.json()) as { pickup_address?: string; pickup_lat?: number | null; pickup_lng?: number | null }
  if (!status.pickup_address) return 'A loja ainda não cadastrou o endereço de retirada.'
  if (status.pickup_lat != null && status.pickup_lng != null) {
    const sent = await sendWhatsappLocation(ctx.instance, ctx.phone, status.pickup_lat, status.pickup_lng, 'Localização da loja', status.pickup_address)
    if (sent) return `Localização da loja enviada como PIN no WhatsApp (endereço: ${status.pickup_address}).`
  }
  return `Endereço da loja: ${status.pickup_address}`
}

/** Extrai lat/lng do texto "[Cliente compartilhou localização fixa: https://maps.google.com/?q=lat,lng]". */
function parseLatLngFromLocationText(text: string): { lat: number; lng: number } | null {
  const match = text.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/)
  if (!match) return null
  const lat = Number(match[1])
  const lng = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

async function calcularValorEntrega(tenantSlug: string, localizacaoCompartilhada: string): Promise<string> {
  const coords = parseLatLngFromLocationText(localizacaoCompartilhada)
  if (!coords) return 'Preciso que o cliente compartilhe a localização fixa no chat antes de calcular o valor da entrega.'
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/estimate-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: coords.lat, lng: coords.lng }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return `Não consegui calcular o valor da entrega agora: ${body || res.status}`
  }
  const data = (await res.json()) as { km: number; price: number; within_range: boolean; eta_minutes: number }
  const priceFmt = data.price.toFixed(2).replace('.', ',')
  const kmFmt = data.km.toFixed(1).replace('.', ',')
  if (!data.within_range) {
    return `O endereço fica a ${kmFmt} km da loja, fora da área de entrega. Avise o cliente que essa entrega não é possível — só retirada no local.`
  }
  return `Valor real da entrega/coleta: R$ ${priceFmt} (${kmFmt} km até a loja, tempo estimado de trajeto ${data.eta_minutes} min, calculado pelo preço por km cadastrado na loja).`
}

/** Minutos entre um timestamp ISO passado e agora — nunca negativo. */
function minutesSince(isoTimestamp: string): number {
  const then = new Date(isoTimestamp).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.max(0, Math.round((Date.now() - then) / 60000))
}

/**
 * Pra pedido em rota de entrega com localização do cliente já salva,
 * recalcula a rota real (mesmo endpoint de calcular_valor_entrega) e
 * subtrai o tempo já passado desde a última mudança de status — dá o
 * "faltam X minutos" real que o cliente quer saber, nunca chutado. Sem
 * coluna dedicada de "despachado em", `updated_at` é a melhor referência
 * real disponível (a última mudança de status quase sempre É o despacho,
 * pra pedido que está em em_rota_de_entrega agora).
 */
async function estimateRemainingMinutes(
  tenantSlug: string,
  lat: number,
  lng: number,
  dispatchedAtIso: string,
): Promise<number | null> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/estimate-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { eta_minutes: number }
  const elapsed = minutesSince(dispatchedAtIso)
  return Math.max(0, data.eta_minutes - elapsed)
}

async function consultarPedido(tenantSlug: string, phone: string, outroTelefone?: string): Promise<string> {
  const phoneToUse = outroTelefone?.trim() || phone
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/orders-by-phone/${phoneToUse}`)
  if (!res.ok) return 'Não foi possível consultar pedidos agora.'
  const orders = (await res.json()) as {
    short_id: string
    status: string
    payment_status: string
    payment_method: string
    delivery_type: string
    total: number
    created_at: string
    updated_at: string
    customer_lat: number | null
    customer_lng: number | null
  }[]
  if (orders.length === 0) {
    return outroTelefone
      ? `Não encontrei nenhum pedido pro número ${outroTelefone} nessa loja.`
      : 'Não encontrei nenhum pedido desse telefone (o número desta conversa) nessa loja — pergunte ao cliente se o pedido foi feito com outro número de WhatsApp; se ele confirmar outro número, chame esta ferramenta de novo passando outro_telefone.'
  }
  const linhas: string[] = []
  for (const o of orders) {
    let linha = `Pedido #${o.short_id} — status: ${o.status}, pagamento: ${o.payment_status} (${o.payment_method}), ${o.delivery_type}, total R$ ${o.total.toFixed(2).replace('.', ',')}, feito em ${o.created_at}`
    if (o.status === 'em_rota_de_entrega' && o.customer_lat != null && o.customer_lng != null) {
      const restante = await estimateRemainingMinutes(tenantSlug, o.customer_lat, o.customer_lng, o.updated_at)
      linha +=
        restante == null
          ? ' — saiu pra entrega, não consegui recalcular o tempo restante agora'
          : restante === 0
            ? ' — saiu pra entrega, deve chegar a qualquer momento'
            : ` — saiu pra entrega, faltam aproximadamente ${restante} minuto${restante === 1 ? '' : 's'} pra chegar`
    }
    linhas.push(linha)
  }
  return linhas.join('\n')
}

function montarCarrinho(
  tenantSlug: string,
  itens: { tipo: 'produto' | 'servico'; id?: string; nome: string; quantidade: number }[],
): string {
  if (itens.length === 0) return 'Preciso de pelo menos um item pra montar o carrinho.'
  const linhas = itens.map((i) => {
    const link = i.id ? (i.tipo === 'servico' ? servicoLink(tenantSlug, i.id) : produtoLink(tenantSlug, i.id)) : null
    const qtd = i.quantidade > 1 ? ` (x${i.quantidade})` : ''
    return `${i.nome}${qtd}${link ? ` — ${link}` : ''}`
  })
  return (
    'Prévia do carrinho (envie essa lista pro cliente e peça confirmação antes de qualquer cobrança):\n' +
    linhas.join(',\n') +
    '\n\nSó depois que o cliente confirmar que é isso mesmo, peça nome, email e método de pagamento (pix ou link de cobrança) pra finalizar.'
  )
}

async function criarPedidoEGerarCobranca(
  ctx: ToolCtx,
  itens: { produto_id?: string; servico_id?: string; quantidade: number }[],
  opts: {
    nomeCliente: string
    emailCliente: string
    metodoPagamento: 'pix' | 'link_cobranca'
    querEntregaOuColeta: boolean
    localizacaoCompartilhada: string | null
    valorEntrega: number | null
  },
): Promise<string> {
  if (itens.length === 0) return 'Preciso de pelo menos um item pra criar o pedido.'
  if (itens.some((i) => !i.produto_id && !i.servico_id)) return 'Cada item precisa ter produto_id ou servico_id.'
  if (!opts.nomeCliente.trim()) return 'Preciso do nome completo do cliente antes de gerar a cobrança.'
  if (!opts.emailCliente.trim() || !opts.emailCliente.includes('@')) return 'Preciso de um email válido do cliente antes de gerar a cobrança.'
  if (opts.querEntregaOuColeta && !opts.localizacaoCompartilhada?.trim()) {
    return 'Preciso que o cliente compartilhe a localização fixa no chat antes de gerar a cobrança, já que ele pediu entrega/coleta.'
  }
  if (opts.querEntregaOuColeta && (opts.valorEntrega == null || opts.valorEntrega < 0)) {
    return 'Preciso rodar calcular_valor_entrega antes de gerar a cobrança, já que o cliente pediu entrega/coleta — não posso cobrar entrega sem o valor real calculado.'
  }

  const paymentMethod = opts.metodoPagamento === 'link_cobranca' ? 'cartao' : 'pix'
  const orderRes = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${ctx.tenantSlug}/assistant-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: opts.nomeCliente,
      customer_whatsapp: ctx.phone,
      items: itens.map((i) => ({ product_id: i.produto_id, service_id: i.servico_id, quantity: i.quantidade })),
      payment_method: paymentMethod,
      shipping_price: opts.querEntregaOuColeta ? opts.valorEntrega : null,
    }),
  })
  if (!orderRes.ok) {
    const body = await orderRes.text().catch(() => '')
    return `Não consegui criar o pedido: ${body || orderRes.status}`
  }
  const order = (await orderRes.json()) as { id: string; total: number }
  const totalFmt = order.total.toFixed(2).replace('.', ',')

  if (paymentMethod === 'pix') {
    const pixRes = await fetch(
      `${ECOMMERCE_API_URL}/api/orders/${order.id}/create-pix-payment?customer_email=${encodeURIComponent(opts.emailCliente)}`,
      { method: 'POST' },
    )
    if (!pixRes.ok) {
      return `Pedido criado (total R$ ${totalFmt}), mas não consegui gerar o Pix agora. Avise que um atendente vai mandar o pagamento.`
    }
    const paid = (await pixRes.json()) as { pix_copia_cola?: string | null }
    if (!paid.pix_copia_cola) {
      return `Pedido criado (total R$ ${totalFmt}), mas o Pix ainda não veio pronto. Avise que um atendente vai mandar o pagamento.`
    }
    const entregaNote = opts.querEntregaOuColeta
      ? ' A entrega/coleta no endereço compartilhado será combinada por um atendente assim que o pagamento for confirmado.'
      : ''
    // IMPORTANTE pra IA: o código Pix abaixo vai SOZINHO na segunda parte da
    // mensagem (depois do marcador de split) — nenhum outro texto (nem esse
    // aviso de entrega, nem mais nada) pode vir grudado nele. id_pedido_interno
    // NUNCA vai pro cliente — é só pra você (IA) guardar no histórico e usar
    // depois em cancelar_pedido, se o cliente quiser mudar/cancelar isso.
    return `Pedido criado com sucesso! Total: R$ ${totalFmt}.${entregaNote} id_pedido_interno=${order.id} (guarde esse id — use em cancelar_pedido se o cliente quiser mudar item ou cancelar depois; NUNCA mencione esse id pro cliente). Código Pix copia-e-cola pra mandar EXATO e SOZINHO pro cliente (sem nenhum texto antes/depois grudado):\n${paid.pix_copia_cola}`
  }

  const linkRes = await fetch(`${ECOMMERCE_API_URL}/api/orders/${order.id}/card-link`, { method: 'POST' })
  if (!linkRes.ok) {
    return `Pedido criado (total R$ ${totalFmt}), mas não consegui gerar o link de cobrança agora. Avise que um atendente vai mandar o pagamento.`
  }
  const paid = (await linkRes.json()) as { card_payment_link_url?: string | null }
  if (!paid.card_payment_link_url) {
    return `Pedido criado (total R$ ${totalFmt}), mas o link de cobrança ainda não veio pronto. Avise que um atendente vai mandar o pagamento.`
  }
  const entregaNote = opts.querEntregaOuColeta
    ? ' A entrega/coleta no endereço compartilhado será combinada por um atendente assim que o pagamento for confirmado.'
    : ''
  // IMPORTANTE pra IA: o link abaixo vai SOZINHO na segunda parte da mensagem
  // (depois do marcador de split) — nenhum outro texto grudado nele.
  return `Pedido criado com sucesso! Total: R$ ${totalFmt}.${entregaNote} id_pedido_interno=${order.id} (guarde esse id — use em cancelar_pedido se o cliente quiser mudar item ou cancelar depois; NUNCA mencione esse id pro cliente). Link de pagamento por cartão pra mandar EXATO e SOZINHO pro cliente (sem nenhum texto antes/depois grudado):\n${paid.card_payment_link_url}`
}

/**
 * Cancela um pedido já criado (ownership verificada pelo telefone da
 * própria conversa, mesmo modelo de confiança de consultar_pedido — sem
 * JWT). Bloqueado pelo backend depois que o pedido já saiu pra entrega.
 * Usada tanto pra um cancelamento de verdade quanto como primeiro passo
 * de uma "edição": cliente muda de ideia sobre o carrinho de um pedido
 * com pagamento já gerado → cancela o antigo → cria um novo com os itens
 * certos (ver descrição da tool e universalValidatorRules).
 */
async function cancelarPedido(phone: string, idPedidoInterno: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/orders/${idPedidoInterno}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp: phone }),
  })
  if (res.ok) return 'Pedido cancelado com sucesso.'
  if (res.status === 400) {
    return 'Não foi possível cancelar — esse pedido já saiu pra entrega/coleta, não dá mais pra cancelar por aqui. Avise que um atendente humano precisa resolver.'
  }
  if (res.status === 403 || res.status === 404) {
    return 'Não encontrei esse pedido pra cancelar (id inválido ou não pertence a esse telefone) — confira o id_pedido_interno guardado no histórico desta conversa.'
  }
  const body = await res.text().catch(() => '')
  return `Não consegui cancelar agora: ${body || res.status}`
}
