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

export const tools: Anthropic.Tool[] = [
  {
    name: 'buscar_produtos',
    description:
      'Busca produtos ativos no catálogo real da loja. Use sempre que o cliente perguntar o que a loja vende, pedir o cardápio/catálogo, ou perguntar sobre um produto específico. Retorna id, nome, preço e descrição de cada produto — o id é necessário pra montar carrinho depois.',
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
    name: 'consultar_pedido',
    description:
      'Consulta os pedidos recentes do cliente (pelo telefone da própria conversa) na loja de verdade. Use sempre que o cliente perguntar sobre status/andamento de um pedido já feito.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'criar_pedido_e_gerar_pix',
    description:
      'Cria de verdade um pedido com os itens que o cliente escolheu e já gera a cobrança Pix (código copia-e-cola) pra mandar pro cliente pagar. Use SÓ quando o cliente já confirmou explicitamente quais produtos e quantidades quer comprar — nunca crie pedido sem essa confirmação clara. Sempre nasce como retirada no local (esse atendimento por WhatsApp ainda não coleta endereço de entrega) e pendente de pagamento — nunca já pago.',
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          description: 'Lista de itens do carrinho, com o id do produto (vindo de buscar_produtos) e a quantidade.',
          items: {
            type: 'object',
            properties: {
              produto_id: { type: 'string' },
              quantidade: { type: 'integer', minimum: 1 },
            },
            required: ['produto_id', 'quantidade'],
          },
        },
      },
      required: ['itens'],
    },
  },
]

type ToolCtx = { tenantSlug: string; phone: string; customerName: string | null }

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  try {
    if (name === 'buscar_produtos') return await buscarProdutos(ctx.tenantSlug, String(input.termo ?? ''))
    if (name === 'consultar_pedido') return await consultarPedido(ctx.tenantSlug, ctx.phone)
    if (name === 'criar_pedido_e_gerar_pix') {
      const itens = Array.isArray(input.itens) ? (input.itens as { produto_id: string; quantidade: number }[]) : []
      return await criarPedidoEGerarPix(ctx, itens)
    }
    return `Ferramenta desconhecida: ${name}`
  } catch (e) {
    return `Erro ao consultar: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function buscarProdutos(tenantSlug: string, termo: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/products`)
  if (!res.ok) return 'Não foi possível consultar o catálogo agora.'
  const products = (await res.json()) as { id: string; name: string; price: number; description?: string }[]
  const filtered = termo ? products.filter((p) => p.name.toLowerCase().includes(termo.toLowerCase())) : products
  if (filtered.length === 0) return termo ? `Nenhum produto encontrado pra "${termo}".` : 'A loja não tem produtos cadastrados no catálogo ainda.'
  return filtered
    .slice(0, 20)
    .map((p) => `- id=${p.id} | ${p.name}: R$ ${p.price.toFixed(2).replace('.', ',')}${p.description ? ` — ${p.description}` : ''}`)
    .join('\n')
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

async function criarPedidoEGerarPix(
  ctx: ToolCtx,
  itens: { produto_id: string; quantidade: number }[],
): Promise<string> {
  if (itens.length === 0) return 'Preciso de pelo menos um item pra criar o pedido.'
  const orderRes = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${ctx.tenantSlug}/assistant-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: ctx.customerName || 'Cliente WhatsApp',
      customer_whatsapp: ctx.phone,
      items: itens.map((i) => ({ product_id: i.produto_id, quantity: i.quantidade })),
    }),
  })
  if (!orderRes.ok) {
    const body = await orderRes.text().catch(() => '')
    return `Não consegui criar o pedido: ${body || orderRes.status}`
  }
  const order = (await orderRes.json()) as { id: string; total: number }

  const pixRes = await fetch(`${ECOMMERCE_API_URL}/api/orders/${order.id}/create-pix-payment`, { method: 'POST' })
  if (!pixRes.ok) {
    return `Pedido criado (total R$ ${order.total.toFixed(2).replace('.', ',')}), mas não consegui gerar o Pix agora. Avise que um atendente vai mandar o pagamento.`
  }
  const paid = (await pixRes.json()) as { pix_copia_cola?: string | null }
  if (!paid.pix_copia_cola) {
    return `Pedido criado (total R$ ${order.total.toFixed(2).replace('.', ',')}), mas o Pix ainda não veio pronto. Avise que um atendente vai mandar o pagamento.`
  }
  return `Pedido criado com sucesso! Total: R$ ${order.total.toFixed(2).replace('.', ',')}. Código Pix copia-e-cola (mande esse código EXATO pro cliente, ele deve colar no app do banco):\n${paid.pix_copia_cola}`
}
