-- Módulo Assistente IA — schema isolado, não toca em nenhuma tabela do
-- Resolutoo. tenant_id referencia o mesmo tenants.id do schema `loja`, mas
-- sem FK cross-schema (mantém este módulo desacoplável/removível sem
-- depender de alterar o schema principal).

CREATE SCHEMA IF NOT EXISTS assistant_ia;
SET search_path TO assistant_ia;

-- Configuração do assistente por tenant. Uma linha por loja.
CREATE TABLE IF NOT EXISTS assistant_config (
  tenant_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  prompt_interpreter TEXT NOT NULL DEFAULT '',
  prompt_validator TEXT NOT NULL DEFAULT '',
  prompt_supervisor TEXT NOT NULL DEFAULT '',
  start_keywords TEXT[] NOT NULL DEFAULT ARRAY['oi','olá','ola','atendimento','quero comprar','pedido'],
  end_keywords TEXT[] NOT NULL DEFAULT ARRAY['tchau','encerrar','obrigado, só isso'],
  window_timeout_minutes INTEGER NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Base de conhecimento (RAG) por tenant.
CREATE TABLE IF NOT EXISTS rag_documents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processando' CHECK (status IN ('processando','pronto','erro')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rag_documents_tenant ON rag_documents(tenant_id);

-- Pedaços de texto extraídos de cada documento — v1 usa busca textual
-- (tsvector), sem embeddings/vetor ainda (evita depender de um segundo
-- provedor de IA só pra RAG; trocar por embeddings reais é um passo futuro
-- que não muda o contrato desta tabela).
CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,
  chunk_index INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_tenant ON rag_chunks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_tsv ON rag_chunks USING GIN(content_tsv);

-- Uma janela de atendimento = uma conversa com um cliente específico.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','pausada','fechada')),
  assistant_enabled BOOLEAN NOT NULL DEFAULT true, -- toggle manual POR conversa
  human_override BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_phone_open
  ON conversations(tenant_id, phone) WHERE status != 'fechada';

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('cliente','assistente','humano')),
  content TEXT NOT NULL,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- Registro de decisão de cada camada de IA, por mensagem — útil pra
-- depurar/auditar por que o assistente respondeu o que respondeu.
CREATE TABLE IF NOT EXISTS agent_decisions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('interpreter','validator','supervisor')),
  output JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_message ON agent_decisions(message_id);
