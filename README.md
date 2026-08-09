# a-vrtek-gente — Assistente IA multitenant (Resolutoo)

Módulo **isolado** de assistente de IA para atendimento via WhatsApp, construído do zero para o Resolutoo. Roda como serviço próprio (backend Node/TypeScript), com banco próprio (schema `assistant_ia` no mesmo Postgres/Supabase do Resolutoo) e integração com a Evolution API já existente no projeto principal via um pequeno forward de webhook — sem alterar a lógica atual da Evolution.

## O que é

Cada loja (tenant) do Resolutoo pode ativar um assistente de IA que:

- responde clientes automaticamente no WhatsApp da loja;
- usa uma arquitetura de 3 camadas de IA (interpretação → validação → supervisão de contexto) antes de responder;
- consulta uma base de conhecimento própria da loja (RAG: PDFs, FAQs, políticas, conversas antigas);
- respeita janelas de atendimento com gatilhos de início/fim configuráveis por loja;
- pode ser interrompido manualmente por conversa (atendimento passa a ser humano) sem perder histórico;
- nunca mistura dados, prompts, RAG ou conversas entre lojas diferentes (isolamento por `tenant_id` reforçado no backend, não só no frontend).

## Arquitetura

```
backend/
├── src/
│   ├── agents/            # As 3 camadas de IA (agente 1, 2, 3) + orquestrador do pipeline
│   ├── rag/                # Upload, chunking, busca e indexação da base de conhecimento
│   ├── evolution-adapter/  # Cliente HTTP pra ENVIAR mensagens via Evolution API já existente
│   ├── routes/              # Endpoints HTTP (config, chat, RAG, webhook de entrada)
│   ├── services/            # Regras de negócio (janela de atendimento, gatilhos, isolamento de tenant)
│   ├── db/                  # Cliente Postgres/Supabase + queries
│   └── server.ts            # Bootstrap do Express
├── migrations/               # SQL do schema assistant_ia (isolado, não toca no schema do Resolutoo)
└── package.json

frontend-integration/         # Documentação + trechos de referência dos pontos de integração
                               # que precisam existir DENTRO do repo do Resolutoo (checkbox em
                               # /meu-plano, página /meu-plano/assistente-ia, menu "Chat" no
                               # painel da loja) — o código real desses pontos fica no repo do
                               # Resolutoo, não aqui, porque são rotas que já existem lá.
```

## Por que esse desenho

- **Não mexe na conexão Evolution existente.** O backend do Resolutoo (`ecommerce/backend`) já recebe todo webhook da Evolution API da loja. Em vez de duplicar essa conexão (o que exigiria a loja escanear um QR code de novo só pro assistente), o webhook existente ganha um forward HTTP fire-and-forget pra este serviço — uma chamada extra, sem alterar nenhum comportamento atual.
- **Banco compartilhado, schema isolado.** Usa a mesma instância Supabase do Resolutoo (mais simples/barato), mas com um schema `assistant_ia` totalmente separado — nenhuma tabela do Resolutoo é tocada, e RLS por `tenant_id` garante isolamento de dados entre lojas.
- **IA via Anthropic (Claude).** As 3 camadas usam a API da Anthropic (`claude-opus-5` como modelo padrão da camada de supervisão, camadas mais simples podem usar modelos mais baratos — configurável).

## Variáveis de ambiente necessárias

```
DATABASE_URL=              # Postgres do Resolutoo (schema assistant_ia)
ANTHROPIC_API_KEY=         # chave da Anthropic — NUNCA commitada, só em env do host de deploy
EVOLUTION_API_URL=         # mesma Evolution API já usada pelo Resolutoo
EVOLUTION_API_KEY=
PORT=8090
```

**Nenhuma env do Resolutoo (Supabase service role, Mercado Pago, etc.) é commitada neste repositório.** O `.env` está no `.gitignore`; `.env.example` documenta as chaves sem valores reais.

## Status

Scaffold inicial — estrutura, schema de banco, pipeline de 3 agentes e adapter de Evolution funcionais. Ver `frontend-integration/README.md` para o que falta integrar no repo do Resolutoo.
