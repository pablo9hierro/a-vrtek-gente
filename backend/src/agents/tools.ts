import type Anthropic from '@anthropic-ai/sdk'

/**
 * Ferramentas que a IA pode chamar pra consultar dados REAIS da loja —
 * cada uma é um adapter fino pra um endpoint público já existente no
 * backend do Resolutoo (nunca acesso direto ao banco de produção a partir
 * deste módulo). Desenhado pra virar um servidor MCP de verdade depois
 * (uma tool por arquivo/capacidade); por ora são funções TypeScript
 * chamadas via tool use da Anthropic — mesmo contrato de entrada/saída
 * que um MCP tool teria, só sem o protocolo por cima ainda.
 */

const ECOMMERCE_API_URL = process.env.ECOMMERCE_API_URL || 'https://ecommerce-api-production-d447.up.railway.app'

export const tools: Anthropic.Tool[] = [
  {
    name: 'buscar_produtos',
    description:
      'Busca produtos ativos no catálogo real da loja. Use sempre que o cliente perguntar o que a loja vende, pedir o cardápio/catálogo, ou perguntar sobre um produto específico. Retorna nome, preço e descrição de cada produto.',
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
]

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { tenantSlug: string; phone: string },
): Promise<string> {
  try {
    if (name === 'buscar_produtos') return await buscarProdutos(ctx.tenantSlug, String(input.termo ?? ''))
    if (name === 'consultar_pedido') return await consultarPedido(ctx.tenantSlug, ctx.phone)
    return `Ferramenta desconhecida: ${name}`
  } catch (e) {
    return `Erro ao consultar: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function buscarProdutos(tenantSlug: string, termo: string): Promise<string> {
  const res = await fetch(`${ECOMMERCE_API_URL}/api/public/catalog/${tenantSlug}/products`)
  if (!res.ok) return 'Não foi possível consultar o catálogo agora.'
  const products = (await res.json()) as { name: string; price: number; description?: string; active: number }[]
  const filtered = termo
    ? products.filter((p) => p.name.toLowerCase().includes(termo.toLowerCase()))
    : products
  if (filtered.length === 0) return termo ? `Nenhum produto encontrado pra "${termo}".` : 'A loja não tem produtos cadastrados no catálogo ainda.'
  return filtered
    .slice(0, 20)
    .map((p) => `- ${p.name}: R$ ${p.price.toFixed(2).replace('.', ',')}${p.description ? ` — ${p.description}` : ''}`)
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
