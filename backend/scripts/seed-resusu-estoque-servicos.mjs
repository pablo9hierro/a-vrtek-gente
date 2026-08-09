// Seed de ITENS DE ESTOQUE (peças de reparo) + SERVIÇOS ligados a essas
// peças pro tenant "resusu" — cada serviço de troca de peça consome 1
// unidade da peça correspondente; a disponibilidade do serviço passa a
// ser calculada automaticamente pelo estoque da peça (mesma lógica do ERP
// Formulação, aplicada a serviço). Roda contra o Postgres do Resolutoo
// (schema loja), NÃO o do módulo assistant-ia.
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.LOJA_DATABASE_URL, ssl: { rejectUnauthorized: false } })
const TENANT_ID = '35f2cd1a-9aaf-45fa-8518-9113585ed1a7' // tenant "resusu"

// name, quantity em estoque, custo por unidade, limite de aviso de baixo estoque
const parts = [
  { name: 'Tela iPhone 11', quantity: 8, cost_price: 280, low_stock_threshold: 2 },
  { name: 'Tela iPhone 12', quantity: 6, cost_price: 340, low_stock_threshold: 2 },
  { name: 'Tela Samsung Galaxy A54', quantity: 5, cost_price: 300, low_stock_threshold: 2 },
  { name: 'Tela Motorola Moto G84', quantity: 4, cost_price: 260, low_stock_threshold: 2 },
  { name: 'Tela Xiaomi Redmi Note 12', quantity: 5, cost_price: 240, low_stock_threshold: 2 },
  { name: 'Bateria iPhone 12', quantity: 10, cost_price: 120, low_stock_threshold: 3 },
  { name: 'Bateria Xiaomi (genérica)', quantity: 0, cost_price: 90, low_stock_threshold: 3 }, // proposital: esgotado
  { name: 'Conector de Carga/Bateria (genérico)', quantity: 15, cost_price: 40, low_stock_threshold: 4 },
  { name: 'Flash/Câmera Traseira iPhone', quantity: 3, cost_price: 90, low_stock_threshold: 2 },
  { name: 'Flash/Câmera Traseira Samsung', quantity: 1, cost_price: 70, low_stock_threshold: 2 }, // proposital: baixo estoque
  { name: 'Flash/Câmera Traseira Motorola', quantity: 4, cost_price: 65, low_stock_threshold: 2 },
  { name: 'Placa-mãe iPhone (peça reparo)', quantity: 6, cost_price: 150, low_stock_threshold: 2 },
  { name: 'Placa-mãe Samsung (peça reparo)', quantity: 5, cost_price: 160, low_stock_threshold: 2 },
  { name: 'Placa-mãe Motorola (peça reparo)', quantity: 5, cost_price: 140, low_stock_threshold: 2 },
  { name: 'Placa-mãe Xiaomi (peça reparo)', quantity: 4, cost_price: 130, low_stock_threshold: 2 },
  { name: 'Bateria Tablet (genérica)', quantity: 6, cost_price: 100, low_stock_threshold: 2 },
  { name: 'Tela Tablet Samsung', quantity: 3, cost_price: 220, low_stock_threshold: 1 },
  { name: 'Bateria iPod', quantity: 5, cost_price: 60, low_stock_threshold: 2 },
]

// Serviços ligados a peça (consomem 1 unidade da peça por reparo) — preço
// final = peça + mão de obra (já embutida no preço digitado, igual ao
// seed anterior de serviços). category deve bater com o seed anterior
// (seed-resusu-services.mjs) pra cair na mesma categoria.
const linkedServices = [
  { name: 'Troca de Tela iPhone 11', part: 'Tela iPhone 11', category: 'Serviços - Celular iPhone', price: 450, description: 'Substituição da tela original, com garantia.' },
  { name: 'Troca de Tela iPhone 12', part: 'Tela iPhone 12', category: 'Serviços - Celular iPhone', price: 550, description: 'Substituição da tela original, com garantia.' },
  { name: 'Troca de Bateria iPhone 12', part: 'Bateria iPhone 12', category: 'Serviços - Celular iPhone', price: 220, description: 'Bateria nova, teste de ciclo de carga incluso.' },
  { name: 'Troca de Flash (Câmera) iPhone', part: 'Flash/Câmera Traseira iPhone', category: 'Serviços - Celular iPhone', price: 190, description: 'Substituição do módulo de câmera/flash traseiro.' },
  { name: 'Troca de Tela Samsung Galaxy A54', part: 'Tela Samsung Galaxy A54', category: 'Serviços - Celular Samsung', price: 480, description: 'Substituição da tela original, com garantia.' },
  { name: 'Reparo de Flash Samsung', part: 'Flash/Câmera Traseira Samsung', category: 'Serviços - Celular Samsung', price: 150, description: 'Reparo/troca do flash da câmera traseira.' },
  { name: 'Troca de Tela Motorola Moto G84', part: 'Tela Motorola Moto G84', category: 'Serviços - Celular Motorola', price: 400, description: 'Substituição da tela original, com garantia.' },
  { name: 'Reparo de Flash Motorola', part: 'Flash/Câmera Traseira Motorola', category: 'Serviços - Celular Motorola', price: 140, description: 'Reparo/troca do flash da câmera traseira.' },
  { name: 'Troca de Tela Xiaomi Redmi Note 12', part: 'Tela Xiaomi Redmi Note 12', category: 'Serviços - Celular Xiaomi', price: 380, description: 'Substituição da tela original, com garantia.' },
  { name: 'Troca de Bateria Xiaomi', part: 'Bateria Xiaomi (genérica)', category: 'Serviços - Celular Xiaomi', price: 180, description: 'Bateria nova, teste de ciclo de carga incluso.' },
  { name: 'Reparo de Tela Tablet Samsung', part: 'Tela Tablet Samsung', category: 'Serviços - Tablet', price: 350, description: 'Substituição de tela de tablet Samsung.' },
  { name: 'Troca de Bateria Tablet', part: 'Bateria Tablet (genérica)', category: 'Serviços - Tablet', price: 200, description: 'Substituição de bateria de tablet (todas as marcas).' },
  { name: 'Troca de Bateria iPod', part: 'Bateria iPod', category: 'Serviços - iPod', price: 150, description: 'Substituição de bateria de iPod.' },
]

// Serviços SEM peça ligada — não têm estoque próprio, disponibilidade
// fica ilimitada (manual_quantity null), avaliação é sempre negociada.
const unlinkedServices = [
  {
    name: 'Avaliação para Troca de Aparelho',
    category: 'Serviços - Celular iPhone',
    price: 0,
    description: 'Avalia seu celular usado (iPhone/Android) como entrada/troca por outro aparelho (seminovo ou acessório) da loja. Valor da troca é definido na avaliação presencial.',
  },
  {
    name: 'Compra de Aparelho Usado',
    category: 'Serviços - Celular iPhone',
    price: 0,
    description: 'Compramos seu celular usado (funcionando ou com defeito) — valor definido após avaliação presencial do estado e modelo.',
  },
  {
    name: 'Busca e Entrega de Aparelho (Reparo)',
    category: 'Serviços - Celular iPhone',
    price: 0,
    description: 'Buscamos seu aparelho na sua casa/trabalho pra fazer o reparo e devolvemos depois de pronto — sem custo extra dentro da área de cobertura. Combine local e horário com o atendimento.',
  },
  {
    name: 'Entrega de Produto Comprado',
    category: 'Serviços - Celular iPhone',
    price: 0,
    description: 'Entregamos no seu endereço produtos comprados na loja (acessórios, aparelhos). Combine endereço e horário com o atendimento.',
  },
]

async function main() {
  const client = await pool.connect()
  try {
    const partIds = {}
    for (const p of parts) {
      const existing = await client.query('SELECT id FROM ingredients WHERE tenant_id = $1 AND name = $2', [TENANT_ID, p.name])
      if (existing.rows[0]) {
        await client.query(
          'UPDATE ingredients SET quantity = $1, cost_price = $2, low_stock_threshold = $3, unit = $4 WHERE id = $5',
          [p.quantity, p.cost_price, p.low_stock_threshold, 'un', existing.rows[0].id],
        )
        partIds[p.name] = existing.rows[0].id
        console.log(`peça atualizada: ${p.name}`)
        continue
      }
      const id = crypto.randomUUID()
      await client.query(
        `INSERT INTO ingredients (id, tenant_id, name, unit, quantity, cost_price, low_stock_threshold) VALUES ($1, $2, $3, 'un', $4, $5, $6)`,
        [id, TENANT_ID, p.name, p.quantity, p.cost_price, p.low_stock_threshold],
      )
      partIds[p.name] = id
      console.log(`peça criada: ${p.name}`)
    }

    for (const s of linkedServices) {
      const catRes = await client.query('SELECT id FROM categories WHERE tenant_id = $1 AND name = $2', [TENANT_ID, s.category])
      const categoryId = catRes.rows[0]?.id ?? null

      let serviceId
      const existingService = await client.query('SELECT id FROM services WHERE tenant_id = $1 AND name = $2', [TENANT_ID, s.name])
      if (existingService.rows[0]) {
        serviceId = existingService.rows[0].id
        await client.query('UPDATE services SET description = $1, category_id = $2, price = $3 WHERE id = $4', [
          s.description,
          categoryId,
          s.price,
          serviceId,
        ])
        console.log(`serviço atualizado: ${s.name}`)
      } else {
        serviceId = crypto.randomUUID()
        await client.query(
          `INSERT INTO services (id, tenant_id, name, description, category_id, price, active) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [serviceId, TENANT_ID, s.name, s.description, categoryId, s.price],
        )
        console.log(`serviço criado: ${s.name}`)
      }

      const partId = partIds[s.part]
      const existingLink = await client.query(
        'SELECT id FROM service_ingredients WHERE tenant_id = $1 AND service_id = $2 AND ingredient_id = $3',
        [TENANT_ID, serviceId, partId],
      )
      if (!existingLink.rows[0]) {
        await client.query(
          `INSERT INTO service_ingredients (id, tenant_id, service_id, ingredient_id, quantity, unit) VALUES ($1, $2, $3, $4, 1, 'un')`,
          [crypto.randomUUID(), TENANT_ID, serviceId, partId],
        )
        console.log(`  -> ligado à peça: ${s.part}`)
      }
    }

    for (const s of unlinkedServices) {
      const catRes = await client.query('SELECT id FROM categories WHERE tenant_id = $1 AND name = $2', [TENANT_ID, s.category])
      const categoryId = catRes.rows[0]?.id ?? null
      const existingService = await client.query('SELECT id FROM services WHERE tenant_id = $1 AND name = $2', [TENANT_ID, s.name])
      if (existingService.rows[0]) {
        await client.query('UPDATE services SET description = $1, category_id = $2, price = $3 WHERE id = $4', [
          s.description,
          categoryId,
          s.price,
          existingService.rows[0].id,
        ])
        console.log(`serviço atualizado: ${s.name}`)
      } else {
        await client.query(
          `INSERT INTO services (id, tenant_id, name, description, category_id, price, active) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [crypto.randomUUID(), TENANT_ID, s.name, s.description, categoryId, s.price],
        )
        console.log(`serviço criado: ${s.name}`)
      }
    }

    console.log('seed de estoque + serviços ligados concluído')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
