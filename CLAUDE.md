# Clara HUD — Contexto para Claude

Assistente pessoal do Duam Rodrigues (DM Stack, Jupi-PE).
Frontend PWA em https://clara.dmstack.com.br | Backend Supabase Edge Functions.

## Stack

- Frontend: HTML/CSS/JS vanilla, GitHub Pages, PWA
- Backend: Supabase (DB + Storage + Realtime + Edge Functions Deno)
- LLM: Claude `claude-sonnet-4-6` com prompt caching ativo
- Embeddings: Voyage AI `voyage-3` (free tier, sem cartão)
- Vector store: pgvector no Supabase (HNSW, cosine)
- TTS futuro: ElevenLabs com voz clonada da Michele — **não-negociável, nunca usar TTS genérico**

## Decisões travadas

- **RAG sobre Obsidian** (via mirror em GitHub privado → webhook → Supabase pgvector) — priorizado v1
- **Auto-RAG** (busca sempre, não Claude-decide) — escolha v1
- **Privacidade**: só pasta `/Estrategia/` indexada, nunca vault inteiro
- **Obsidian sempre atualizado, nunca acumular**: cada nota é fonte única de verdade. Mudou? Atualiza in-place. Proibido criar `-v2`, `-old`, `-draft`, duplicatas. RAG só é bom se a fonte for limpa.
- **Model routing** (Haiku classifier antes do Sonnet) — ABORTADO. Cache já corta 80% do custo.
- **n8n / Home Assistant** — ABORTADO. Edge Functions chamam APIs direto via tool calling.
- **Voz** entra só depois do RAG estável.

## Protocolo de validação rigorosa (regra-mestre)

Um módulo **só é verde** quando há prova com saída real visível. Nunca declarar pronto por "não deu erro".

Para cada módulo:
1. Critério de pronto definido por escrito ANTES de codar
2. Caminhos de falha listados (vazio, gigante, duplicado, char especial, secret errado, dado faltando)
3. Três tipos de teste obrigatórios: happy path + edge cases + adversarial
4. Idempotência testada (rodar 2x sem efeito colateral)
5. Saída real mostrada ao Duam (curl + response, print de tabela)
6. Duam dá OK visual antes de avançar

Quando não puder testar localmente: dizer claramente "não testei aqui, rode X e me mostre Y".
Nunca inventar que testou.

### Bandeiras vermelhas

- "Provavelmente funciona" sem prova
- Mocks substituindo serviço real
- Try/catch silenciando erro
- "Retornou 200" sem inspecionar conteúdo
- Loops idempotentes não testados em 2ª execução

## Mapa modular do RAG (status)

| Módulo | Descrição | Status |
|---|---|---|
| M1 | Schema SQL + toggle `CLARA_RAG_ENABLED` | Próximo |
| M2 | Setup Obsidian → GitHub privado + Voyage account | Duam executa em paralelo |
| M3 | Edge Function `clara-search` (read isolado) | Pendente |
| M4 | Edge Function `clara-index` (webhook + chunker + embed + upsert) | Pendente |
| M5 | Integração no `clara-respond` com auto-RAG | Pendente |
| M6 | Eval set + observabilidade | Pendente |

Regras: não avança sem M anterior verde. Toggle desliga tudo em segundos.

## Critérios de pronto por módulo

- M1: `SELECT * FROM clara_knowledge` retorna sem erro, índice HNSW criado, toggle visível
- M2: Push manual no repo aparece no GitHub, conta Voyage criada, key gerada
- M3: `curl` em `clara-search?q=...` retorna ID correto da nota seed
- M4: Push real dispara webhook, tabela ganha rows novas, hash skip evita duplicata, signature validada
- M5: Pergunta sobre nota indexada → resposta cita o conteúdo, toggle off elimina chamada
- M6: 5/5 do eval set retorna chunk correto top-3

## Estado atual do código

- `index.html` — HUD principal (clock, weather hardcoded, chat overlay, mic recorder, Realtime listener)
- `service-worker.js` — cache-first PWA
- `supabase/functions/clara-respond/index.ts` — backend de chat (Claude + Supabase SDK + rate limit + idempotência + timing-safe secret)
  - Pendente: deploy + database webhook + RLS no Supabase Dashboard
- `supabase/functions/clara-index/` — futuro indexer
- `supabase/functions/clara-search/` — futuro search
- `supabase/migrations/` — schema do pgvector + clara_knowledge

Branch ativa: `claude/analyze-photos-xfS9V`

## Repos relacionados

- `Duamrt/clara-hud` (público) — HUD + Edge Functions
- `Duamrt/dm-stack-strategy` (privado) — vault Obsidian indexado pela Clara
- `Duamrt/DM-STACK-BACKUPS` (privado) — backups do Supabase (não relacionado à Clara)

## Convenções

- Português BR em comments, mensagens da Clara, commits
- Commit prefix: `feat:` `fix:` `refactor:` `security:` `docs:`
- TodoWrite para tarefas com 3+ passos
- Edge Functions, nunca servidor próprio
- `timingSafeEqual` em todo secret compare
- `AbortSignal.timeout()` em todo fetch externo
- Validar input com regex antes de interpolar em URL
- Sem emojis no código
- Nunca `--no-verify`, nunca `--amend` em commits já pushados
- Não criar arquivos de doc sem pedido explícito
- Não pushar para `main` sem permissão direta

## Tom de comunicação com o Duam

- Direto ao ponto, sem narração
- Sem ego, validação só do produto
- Curto sempre
- Push back quando vir problema, não acomodar
- Quando incerto, pedir mais contexto antes de codar

## Backlog (fora do escopo atual, arrumar depois)

- GitHub Actions `backup-dmpay.yml` no repo `Duamrt/DM-STACK-BACKUPS` falhando: dump exit code 1 (30s), warning de `actions/checkout@v4` rodando em Node.js 20 deprecated. Investigar workflow do backup do Supabase do DM Pay.

## Não fazer

- Avançar fase sem OK visual do Duam
- Declarar pronto sem prova de saída real
- Esconder o que não foi testado
- Mockar onde dá pra testar real
- Adicionar features ou abstrações além do solicitado
- Criar wrappers/helpers sem necessidade clara
