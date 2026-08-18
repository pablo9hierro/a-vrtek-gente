/**
 * Testa cada motor do ranking de IA da plataforma de forma ISOLADA — sem
 * passar pela cascata de fallback do aiClient.ts, então uma falha num
 * motor nunca fica mascarada por outro que respondeu no lugar dele.
 * Chama a API real do provedor (OpenAI ou OpenRouter) diretamente, com o
 * modelo exato configurado em cada motor, usando as MESMAS chaves de
 * plataforma (OPENAI_API_KEY/OPENROUTER_API_KEY) que o assistant-ia usa
 * em produção.
 *
 * Usage:
 *   ASSISTANT_IA_URL=https://assistant-ia-production.up.railway.app \
 *   ASSISTANT_IA_INTERNAL_KEY=... \
 *   OPENAI_API_KEY=... \
 *   OPENROUTER_API_KEY=... \
 *   node scripts/test-platform-engines.mjs
 */

const ASSISTANT_IA_URL = process.env.ASSISTANT_IA_URL || 'https://assistant-ia-production.up.railway.app'
const INTERNAL_KEY = process.env.ASSISTANT_IA_INTERNAL_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY

const URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
}

function keyFor(provider) {
  if (provider === 'openai') return OPENAI_KEY
  if (provider === 'openrouter') return OPENROUTER_KEY
  return undefined
}

async function testEngine(engine) {
  const key = keyFor(engine.provider)
  if (!key) {
    return { ok: false, error: `chave de plataforma ausente localmente (${engine.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'} não passada pro script)` }
  }
  const started = Date.now()
  try {
    const res = await fetch(URLS[engine.provider], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: engine.model,
        messages: [{ role: 'user', content: 'Responda apenas a palavra: OK' }],
        // Alguns modelos (ex: Gemini com reasoning) gastam token budget em
        // "pensamento" interno antes do texto visível — max_tokens baixo
        // demais corta antes de qualquer conteúdo aparecer (finish_reason
        // "length" com content vazio, falso negativo). 300 dá folga real
        // sem descaracterizar o teste (produção não limita max_tokens).
        max_tokens: 300,
      }),
    })
    const ms = Date.now() - started
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, ms, error: `HTTP ${res.status}: ${body.slice(0, 300)}` }
    }
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) return { ok: false, ms, error: `resposta sem conteúdo: ${JSON.stringify(data).slice(0, 300)}` }
    return { ok: true, ms, text }
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: String(err) }
  }
}

async function main() {
  if (!INTERNAL_KEY) {
    console.error('ASSISTANT_IA_INTERNAL_KEY não configurada — abortando.')
    process.exit(1)
  }
  const res = await fetch(`${ASSISTANT_IA_URL}/api/platform/ai-engines`, {
    headers: { 'x-internal-key': INTERNAL_KEY },
  })
  if (!res.ok) {
    console.error(`falha ao buscar ranking de motores: HTTP ${res.status}`)
    process.exit(1)
  }
  const engines = await res.json()
  const enabled = engines.filter((e) => e.enabled)

  console.log(`Testando ${enabled.length} motor(es) habilitado(s), cada um isoladamente:\n`)

  const results = []
  for (const engine of enabled.sort((a, b) => a.priority - b.priority)) {
    process.stdout.write(`  #${engine.priority} ${engine.label} (${engine.provider}/${engine.model}) ... `)
    const result = await testEngine(engine)
    results.push({ engine, ...result })
    if (result.ok) {
      console.log(`OK (${result.ms}ms) — respondeu "${result.text}"`)
    } else {
      console.log(`FALHOU — ${result.error}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(`${results.length - failed.length}/${results.length} motores funcionando de ponta a ponta.`)
  if (failed.length > 0) {
    console.log('Motores com problema:')
    for (const f of failed) console.log(`  - ${f.engine.label}: ${f.error}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Erro fatal no teste:', err)
  process.exit(1)
})
