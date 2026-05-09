# Clara HUD

PWA do painel da Clara, assistente pessoal do Duam.

- 🌐 Produção: https://clara.dmstack.com.br
- 🤍 Stack: HTML + CSS + JS vanilla, Supabase, Deno Edge Functions
- 📱 Instalável como app no celular/desktop (PWA)

## Estrutura

- `index.html` — HUD com núcleo Jarvis em SVG + wireframe constelação
- `manifest.json` — config PWA (nome, ícones, theme rosé)
- `service-worker.js` — cache-first pra funcionar offline
- `icons/` — 192/512 e apple-touch
- `CNAME` — domínio custom GitHub Pages
- `supabase/functions/clara-respond/` — Edge Function que conecta Supabase → Claude

## Dev local

```bash
npx serve -s . -l 5557
```

Abre http://localhost:5557

---

## Backend — Clara Respond (Edge Function)

A função `clara-respond` é o cérebro da Clara. Ela:

1. É acionada por um **Database Webhook** quando uma mensagem `role=user` entra na tabela `clara_messages`
2. Busca o histórico da conversa
3. Chama a API do Claude (claude-sonnet-4-6) com o system prompt da Clara
4. Insere a resposta de volta como `role=clara`
5. O front-end via Supabase Realtime exibe a resposta instantaneamente

### Variáveis de ambiente necessárias

| Variável | Descrição |
|---|---|
| `ANTHROPIC_API_KEY` | Chave da API do Claude (console.anthropic.com) |
| `SUPABASE_URL` | Automático no deploy via CLI |
| `SUPABASE_SERVICE_ROLE_KEY` | Automático no deploy via CLI |
| `CLARA_WEBHOOK_SECRET` | Opcional — segredo para validar o webhook |

### Deploy passo a passo

**1. Instalar Supabase CLI**
```bash
npm install -g supabase
```

**2. Login e link do projeto**
```bash
supabase login
supabase link --project-ref bkfkzauhnlulrtttgcii
```

**3. Configurar segredos**
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
# Opcional (protege o webhook de chamadas externas):
supabase secrets set CLARA_WEBHOOK_SECRET=um-segredo-forte-aqui
```

**4. Deploy da função**
```bash
supabase functions deploy clara-respond --no-verify-jwt
```

A URL da função será:
```
https://bkfkzauhnlulrtttgcii.supabase.co/functions/v1/clara-respond
```

### Configurar RLS (Row Level Security) — OBRIGATÓRIO

Sem isso, qualquer pessoa com a anon key (visível no HTML) pode ler e escrever suas mensagens.

No Supabase Dashboard → **Authentication → Policies**:

**Tabela `clara_messages`:**
```sql
-- Habilita RLS
ALTER TABLE clara_messages ENABLE ROW LEVEL SECURITY;

-- Só você (autenticado) pode inserir e ler
CREATE POLICY "owner only"
  ON clara_messages
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);
```

**Storage bucket `clara-audio`:**
- Bucket type: **Private** (não public)
- Upload policy: autenticados apenas

> Para usar com o frontend, você precisa fazer login via `supabase.auth.signInWithPassword` antes de enviar mensagens. O README de frontend será atualizado quando adicionarmos autenticação.

---

### Configurar Database Webhook

No Supabase Dashboard → **Database → Webhooks → Create a new hook**:

| Campo | Valor |
|---|---|
| Name | `clara-respond-trigger` |
| Table | `clara_messages` |
| Events | `INSERT` |
| Type | `HTTP Request` |
| Method | `POST` |
| URL | `https://bkfkzauhnlulrtttgcii.supabase.co/functions/v1/clara-respond` |
| Header `Authorization` | `Bearer <CLARA_WEBHOOK_SECRET>` (**obrigatório**) |

### Testar manualmente

```bash
# Health check
curl https://bkfkzauhnlulrtttgcii.supabase.co/functions/v1/clara-respond

# Simular um trigger (substitua o Bearer pelo CLARA_WEBHOOK_SECRET se configurado)
curl -X POST https://bkfkzauhnlulrtttgcii.supabase.co/functions/v1/clara-respond \
  -H "Content-Type: application/json" \
  -d '{
    "type": "INSERT",
    "table": "clara_messages",
    "record": {
      "id": "test-001",
      "chat_session_id": "duam-clara-d7f3a2c1-9b4e-4f0a",
      "role": "user",
      "text": "Oi Clara, tudo bem?",
      "source": "test"
    },
    "schema": "public",
    "old_record": null
  }'
```

---

## Próximos passos (roadmap)

- [ ] STT — transcrever áudios enviados pelo mic (Whisper API)
- [ ] TTS — Clara responder em voz (ElevenLabs ou OpenAI TTS)
- [ ] Wake word real — detectar "Hey Clara" no browser
- [ ] RAG — embeddings dos projetos e notas do Duam no Supabase
- [ ] Ferramentas — clima ao vivo, calendário, CRM
