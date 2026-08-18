import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { configRouter } from './routes/config.js'
import { conversationsRouter } from './routes/conversations.js'
import { webhookRouter } from './routes/webhook.js'
import { platformAiEnginesRouter } from './routes/platformAiEngines.js'
import { ragRouter } from './rag/upload.js'
import { runMigrations } from './db/migrate.js'
import { startCloseExpiredConversationsJob } from './jobs/closeExpiredConversations.js'

const app = express()
app.use(
  cors({
    // Beta: só o painel do lojista (resolutoo.com) e o dev local precisam
    // chamar este serviço.
    origin: ['https://resolutoo.com', 'http://localhost:5173', 'http://localhost:5174'],
  }),
)
// 15mb (não 2mb) — mensagem de voz do WhatsApp forwardada como base64 pelo
// ecommerce-api (audio_base64, ver webhook.ts) pode passar de 2mb em notas
// de voz mais longas; base64 ainda soma ~33% sobre o tamanho original.
app.use(express.json({ limit: '15mb' }))

app.get('/health', (_req, res) => res.json({ ok: true }))

app.use('/api/tenants', configRouter)
app.use('/api/tenants', conversationsRouter)
app.use('/api/tenants', ragRouter)
app.use('/api/platform', platformAiEnginesRouter)
app.use('/webhook', webhookRouter)

const port = Number(process.env.PORT) || 8090

runMigrations()
  .then(() => {
    // Encerra conversa parada além do window_timeout_minutes do tenant —
    // antes só fechava quando o mesmo cliente voltava a falar.
    startCloseExpiredConversationsJob()
    app.listen(port, () => {
      console.log(`assistant-ia backend rodando em http://localhost:${port}`)
    })
  })
  .catch((e) => {
    console.error('falha ao rodar migrations, encerrando:', e)
    process.exit(1)
  })
