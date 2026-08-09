import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { configRouter } from './routes/config.js'
import { conversationsRouter } from './routes/conversations.js'
import { webhookRouter } from './routes/webhook.js'
import { ragRouter } from './rag/upload.js'
import { runMigrations } from './db/migrate.js'

const app = express()
app.use(
  cors({
    // Beta: só o painel do lojista (resolutoo.com) e o dev local precisam
    // chamar este serviço.
    origin: ['https://resolutoo.com', 'http://localhost:5173', 'http://localhost:5174'],
  }),
)
app.use(express.json({ limit: '2mb' }))

app.get('/health', (_req, res) => res.json({ ok: true }))

app.use('/api/tenants', configRouter)
app.use('/api/tenants', conversationsRouter)
app.use('/api/tenants', ragRouter)
app.use('/webhook', webhookRouter)

const port = Number(process.env.PORT) || 8090

runMigrations()
  .then(() => {
    app.listen(port, () => {
      console.log(`assistant-ia backend rodando em http://localhost:${port}`)
    })
  })
  .catch((e) => {
    console.error('falha ao rodar migrations, encerrando:', e)
    process.exit(1)
  })
