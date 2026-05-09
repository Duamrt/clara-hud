// Clara Respond — Supabase Edge Function
// Trigger: Database Webhook → INSERT on clara_messages (role = user)
// Flow: user msg → busca histórico → Claude → insere resposta como role=clara

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("CLARA_WEBHOOK_SECRET") ?? "";

const CLARA_SYSTEM = `Você é a Clara — assistente pessoal do Duam Rodrigues, fundador do DM Stack (Jupi, PE, Brasil).

Projetos do Duam:
- RPM PRO: sistema de gestão para oficinas mecânicas
- DM TECH: empresa de tecnologia principal
- EDR SYS: sistema de segurança/monitoramento
- DM PAY: solução de pagamentos
- DM SMART: produto de automação inteligente
- Obsidian: vault de notas e base de conhecimento pessoal

Sua personalidade:
- Direta, sem enrolação — vai ao ponto
- Tom casual mas profissional, como parceira de confiança
- Fala sempre em português BR
- Usa "Chefe" esporadicamente quando faz sentido no contexto
- Respostas curtas quando a pergunta é simples, detalhadas quando necessário
- Não precisa se apresentar em toda mensagem
- Tem consciência dos projetos e pode ajudar com decisões técnicas, estratégia e execução`;

interface SupabaseRow {
  id: string;
  chat_session_id: string;
  role: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

interface WebhookPayload {
  type: string;
  table: string;
  record: SupabaseRow;
  schema: string;
  old_record: null | SupabaseRow;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; cache_control?: { type: string } }>;
}

async function fetchHistory(sessionId: string): Promise<SupabaseRow[]> {
  const url = `${SUPABASE_URL}/rest/v1/clara_messages?chat_session_id=eq.${sessionId}&order=created_at.asc&limit=30&select=id,role,text,created_at`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`history fetch failed: ${res.status}`);
  return res.json();
}

async function insertResponse(sessionId: string, text: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/clara_messages`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      chat_session_id: sessionId,
      role: "clara",
      source: "edge-fn",
      text,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`insert failed: ${res.status} — ${err}`);
  }
}

async function callClaude(messages: AnthropicMessage[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: CLARA_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  const block = data.content?.[0];
  if (block?.type === "text") return block.text as string;
  throw new Error("Claude returned no text content");
}

function buildMessages(history: SupabaseRow[]): AnthropicMessage[] {
  const msgs: AnthropicMessage[] = [];

  for (const row of history) {
    if (row.role === "user") {
      msgs.push({ role: "user", content: row.text });
    } else if (row.role === "clara") {
      msgs.push({ role: "assistant", content: row.text });
    }
    // ignora role=system do frontend
  }

  return msgs;
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response(JSON.stringify({ status: "Clara respond — online" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Valida webhook secret se configurado
  if (WEBHOOK_SECRET) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    if (token !== WEBHOOK_SECRET) {
      console.warn("[Clara] unauthorized webhook call");
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const row = payload.record ?? (payload as unknown as SupabaseRow);

  // Só processa mensagens do usuário
  if (!row || row.role !== "user") {
    return new Response(JSON.stringify({ skip: true }), { status: 200 });
  }

  // Ignora mensagens de áudio (STT será tratado futuramente)
  if (!row.text || row.text.trim() === "[áudio]") {
    return new Response(JSON.stringify({ skip: "audio" }), { status: 200 });
  }

  const sessionId = row.chat_session_id;
  if (!sessionId) {
    return new Response("Missing session_id", { status: 400 });
  }

  try {
    const history = await fetchHistory(sessionId);
    const messages = buildMessages(history);

    // Garante que o histórico termina com a mensagem atual do usuário
    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      messages.push({ role: "user", content: row.text });
    }

    const claraText = await callClaude(messages);
    await insertResponse(sessionId, claraText);

    console.log(`[Clara] respondeu na sessão ${sessionId} (${claraText.length} chars)`);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[Clara] erro:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
