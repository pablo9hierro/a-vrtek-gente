import type Anthropic from '@anthropic-ai/sdk'

/**
 * Ferramentas que a IA pode chamar pra consultar/agir em dados REAIS da
 * loja — cada uma é um adapter fino pra um endpoint do backend do
 * Resolutoo (nunca acesso direto ao banco de produção a partir deste
 * módulo). Desenhado pra virar um servidor MCP de verdade depois (uma
 * tool por arquivo/capacidade); por ora são funções TypeScript chamadas
 * via tool use da Anthropic — mesmo contrato de entrada/saída que um MCP
 * tool teria, só sem o protocolo por cima ainda.
 *
 * Quem chama essas tools é a IA 2 (validador), não a IA 3 — a IA 3 só
 * recebe o resultado já pronto.
 */

const ECOMMERCE_API_URL = process.env.ECOMMERCE_API_URL || 'https://ecommerce-api-production-d447.up.railway.app'
const STORE_BASE_URL = process.env.STORE_BASE_URL || 'https://resolutoo.com'

export const tools: Anthropic.Tool[] = [
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
      'Consulta o endereço/localização real da loja. Use sempre que o cliente perguntar onde a loja fica, o endereço, ou pedir a localização pra ir buscar/entregar algo.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_pedido',
    description:
      'Consulta os pedidos recentes do cliente (pelo telefone da própria conversa) na loja de verdade. Use sempre que o cliente perguntar sobre status/andamento de um pedido já feito.',
    input_schema: {
      type: 'object',
      properties: {},
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
      'Cria de verdade um pedido com os PRODUTOS que o cliente confirmou (depois de já ter visto e aceitado a prévia do carrinho via montar_carrinho) e gera a cobrança no método escolhido pelo cliente (pix ou link de cobrança/cartão). Use SÓ depois que o cliente: (1) confirmou os itens na prévia do carrinho, (2) informou nome e email, (3) escolheu o método de pagamento. Nunca invente nome, email ou método — pergunte se faltar. Só produtos entram no pedido de verdade (serviços ainda não têm checkout automatizado — se o cliente só quiser serviço, avise que um atendente vai confirmar e cobrar manualmente). Pedido sempre nasce como retirada no local (esse atendimento por WhatsApp ainda não coleta endereço/entrega) e pendente de pagamento — nunca já pago.',
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          description: 'Lista de PRODUTOS do carrinho (id vindo de buscar_produtos) e quantidade.',
          items: {
            type: 'object',
            properties: {
              produto_id: { type: 'string' },
              quantidade: { type: 'integer', minimum: 1 },
            },
            required: ['produto_id', 'quantidade'],
          },
        },
        nome_cliente: { type: 'string', description: 'Nome completo informado pelo cliente pra finalizar o pedido.' },
        email_cliente: { type: 'string', description: 'Email informado pelo cliente pra finalizar o pedido.' },
        metodo_pagamento: {
          type: 'string',
          enum: ['pix', 'link_cobranca'],
          description: '"pix" gera código copia-e-cola. "link_cobranca" gera um link de pagamento por cartão.',
        },
      },
      required: ['itens', 'nome_cliente', 'email_cliente', 'metodo_pagamento'],
    },
  },
]

type ToolCtx = { tenantSlug: string; phone: string; customerName: string | null }

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  try {
    if (name === 'buscar_produtos') return await buscarProdutos(ctx.tenantSlug, String(input.termo ?? ''))
    if (name === 'buscar_servicos') return await buscarServicos(ctx.tenantSlug, String(input.termo ?? ''))
    if (name === 'consultar_horario_funcionamento') return await consultarHorario(ctx.tenantSlug)
    if (name === 'consultar_localizacao_loja') return await consultarLocalizacao(ctx.tenantSlug)
    if (name === 'consultar_pedido') return await consultarPedido(ctx.tenantSlug, ctx.phone)
    if (name === 'montar_carrinho') {
      const itens = Array.isArray(input.itens)
        ? (input.itens as { tipo: 'produto' | 'servico'; id?: string; nome: string; quantidade: number }[])
        : []
      return montarCarrinho(ctx.tenantSlug, itens)
    }
    if (name === 'criar_pedido_e_gerar_cobranca') {
      const itens = Array.isArray(input.itens) ? (input.itens as { produto_id: string; quantidade: number }[]) : []
      return await criarPedidoEGerarCobranca(ctx, itens, {
        nomeCliente: String(input.nome_cliente ?? ''),
        emailCliente: String(input.email_cliente ?? ''),
        metodoPagamento: input.metodo_pagamento === 'link_cobranca' ? 'link_cobranca' : 'pix',
      })
    }
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

async function buscarProdutos(tenantSlug: string, termo: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/products`)
  if (!res.ok) return 'Não foi possível consultar o catálogo agora.'
  const products = (await res.json()) as { id: string; name: string; price: number; description?: string; image_url?: string }[]
  const filtered = termo ? products.filter((p) => p.name.toLowerCase().includes(termo.toLowerCase())) : products
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
  const filtered = termo
    ? services.filter((s) => s.name.toLowerCase().includes(termo.toLowerCase()) || (s.category_name ?? '').toLowerCase().includes(termo.toLowerCase()))
    : services
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

async function consultarLocalizacao(tenantSlug: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/store-status`)
  if (!res.ok) return 'Não foi possível consultar a localização da loja agora.'
  const status = (await res.json()) as { pickup_address?: string }
  if (!status.pickup_address) return 'A loja ainda não cadastrou o endereço de retirada.'
  return `Endereço da loja: ${status.pickup_address}`
}

async function consultarPedido(tenantSlug: string, phone: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/orders-by-phone/${phone}`)
  if (!res.ok) return 'Não foi possível consultar pedidos agora.'
  const orders = (await res.json()) as {
    short_id: string
    status: string
    payment_status: string
    payment_method: string
    delivery_type: string
    total: number
    created_at: string
  }[]
  if (orders.length === 0) return 'Não encontrei nenhum pedido desse telefone nessa loja.'
  return orders
    .map(
      (o) =>
        `Pedido #${o.short_id} — status: ${o.status}, pagamento: ${o.payment_status} (${o.payment_method}), ${o.delivery_type}, total R$ ${o.total.toFixed(2).replace('.', ',')}, feito em ${o.created_at}`,
    )
    .join('\n')
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
  itens: { produto_id: string; quantidade: number }[],
  opts: { nomeCliente: string; emailCliente: string; metodoPagamento: 'pix' | 'link_cobranca' },
): Promise<string> {
  if (itens.length === 0) return 'Preciso de pelo menos um produto pra criar o pedido.'
  if (!opts.nomeCliente.trim()) return 'Preciso do nome completo do cliente antes de gerar a cobrança.'
  if (!opts.emailCliente.trim() || !opts.emailCliente.includes('@')) return 'Preciso de um email válido do cliente antes de gerar a cobrança.'

  const paymentMethod = opts.metodoPagamento === 'link_cobranca' ? 'cartao' : 'pix'
  const orderRes = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${ctx.tenantSlug}/assistant-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: opts.nomeCliente,
      customer_whatsapp: ctx.phone,
      items: itens.map((i) => ({ product_id: i.produto_id, quantity: i.quantidade })),
      payment_method: paymentMethod,
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
    return `Pedido criado com sucesso! Total: R$ ${totalFmt}. Código Pix copia-e-cola (mande esse código EXATO pro cliente, ele deve colar no app do banco):\n${paid.pix_copia_cola}`
  }

  const linkRes = await fetch(`${ECOMMERCE_API_URL}/api/orders/${order.id}/card-link`, { method: 'POST' })
  if (!linkRes.ok) {
    return `Pedido criado (total R$ ${totalFmt}), mas não consegui gerar o link de cobrança agora. Avise que um atendente vai mandar o pagamento.`
  }
  const paid = (await linkRes.json()) as { card_payment_link_url?: string | null }
  if (!paid.card_payment_link_url) {
    return `Pedido criado (total R$ ${totalFmt}), mas o link de cobrança ainda não veio pronto. Avise que um atendente vai mandar o pagamento.`
  }
  return `Pedido criado com sucesso! Total: R$ ${totalFmt}. Link de pagamento por cartão (mande esse link EXATO pro cliente):\n${paid.card_payment_link_url}`
}
