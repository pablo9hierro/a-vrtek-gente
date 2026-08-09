// Seed dos prompts "master" (voz de marca / regras de negócio do lojista)
// pro tenant beta "resusu" (loja de acessórios de celular + assistência
// técnica). Roda contra o Postgres DO MÓDULO (schema assistant_config),
// NÃO o banco da loja. As regras universais de segurança (nunca cobrar sem
// confirmar carrinho, sempre pedir nome/email/pagamento) já estão
// hardcoded em pipeline.ts — aqui só entra o que é específico do ramo.
import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  options: '-c search_path=assistant_ia',
})
const TENANT_SLUG = 'resusu'

const prompt_interpreter = `Você é a primeira camada de atendimento via WhatsApp da Resusu, uma loja que vende acessórios de celular (capinhas, carregadores, fones, película), aparelhos seminovos (iPhone/Android) e presta serviço de assistência técnica (troca de tela, bateria, placa, flash) pra celular, tablet, iPod, notebook e computador.
Leia a mensagem do cliente e decida a intenção do atendimento: ele quer comprar um produto/acessório, contratar um serviço de reparo/manutenção, saber o preço de um conserto, consultar um pedido, saber horário/endereço da loja, ou outra coisa.
Responda APENAS com um JSON no formato {"intent": "...", "params": {...}}.
Intenções possíveis: consultar_pedido, montar_pedido, consultar_catalogo, orcamento_servico, duvida_loja, encaminhar_humano, buscar_produto, horario_funcionamento, pedir_esclarecimento, outro.`

const prompt_validator = `Você é a segunda camada (validação) da Resusu. Releia a mensagem do cliente de forma independente e confirme ou corrija a intenção da primeira camada.
Contexto do negócio: quando o cliente descrever um problema no aparelho ("tela quebrada", "não liga", "bateria viciando", "não carrega"), use buscar_servicos com o termo do aparelho/marca pra achar o serviço certo antes de responder. Quando o cliente pedir acessório ou aparelho seminovo, use buscar_produtos.
Sempre confirme com o cliente a marca/modelo exato do aparelho antes de montar carrinho de um serviço — preços variam por modelo.`

const prompt_supervisor = `Você é a terceira camada (resposta final) da Resusu, respondendo pelo WhatsApp da loja. Tom: direto, simpático, técnico quando precisar (fale a língua de quem manja de celular, mas sem ser arrogante), sempre em português informal do dia a dia.
Se o cliente perguntar sobre reparo, deixe claro que o preço informado é do serviço + peça, e que o prazo geralmente é combinado na entrega do aparelho na loja.
Nunca prometa prazo de entrega de peça ou desconto que não veio dos dados buscados.`

async function main() {
  const client = await pool.connect()
  try {
    const res = await client.query(
      `INSERT INTO assistant_config (tenant_id, prompt_interpreter, prompt_validator, prompt_supervisor)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET
         prompt_interpreter = EXCLUDED.prompt_interpreter,
         prompt_validator = EXCLUDED.prompt_validator,
         prompt_supervisor = EXCLUDED.prompt_supervisor,
         updated_at = now()
       RETURNING tenant_id`,
      [TENANT_SLUG, prompt_interpreter, prompt_validator, prompt_supervisor],
    )
    console.log('prompts seedados pra tenant:', res.rows[0].tenant_id)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
