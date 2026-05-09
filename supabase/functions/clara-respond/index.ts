// Clara Respond — Supabase Edge Function
// Webhook → INSERT clara_messages role=user → Claude → INSERT role=clara

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { timingSafeEqual } from "https://deno.land/std@0.224.0/crypto/timing_safe_equal.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const CLARA_WEBHOOK_SECRET = requireEnv("CLARA_WEBHOOK_SECRET");

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 300_000;
const MAX_HISTORY = 30;
const MAX_INPUT_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 25_000;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{6,80}$/;

const ROLE = { USER: "user", CLARA: "clara" } as const;
const SOURCE_EDGE_FN = "edge-fn";

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

type Role = typeof ROLE[keyof typeof ROLE];

interface ClaraMessage {
  id: string;
  chat_session_id: string;
  role: Role;
  text: string;
  source?: string;
  metadata?: { triggered_by?: string } & Record<string, unknown>;
  created_at: string;
}

interface WebhookPayload {
  type: string;
  table: string;
  record: ClaraMessage;
  schema: string;
  old_record: ClaraMessage | null;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: {
    fetch: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  },
});

const enc = new TextEncoder();
function secretEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function callClaude(messages: AnthropicMessage[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [
        { type: "text", text: CLARA_SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      messages,
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);

  const data = (await res.json()) as AnthropicResponse;
  const block = data.content?.[0];
  if (block?.type === "text" && block.text) return block.text;
  throw new Error("Claude returned no text content");
}

// Single backward pass through history, fitting within char budget.
// Conversation must start with user message and end with current input.
function buildMessages(history: ClaraMessage[], fallbackText: string): AnthropicMessage[] {
  const reversed: AnthropicMessage[] = [];
  let budget = MAX_INPUT_CHARS - CLARA_SYSTEM.length;

  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (row.role !== ROLE.USER && row.role !== ROLE.CLARA) continue;
    const len = row.text.length;
    if (budget - len < 0) break;
    reversed.push({
      role: row.role === ROLE.CLARA ? "assistant" : "user",
      content: row.text,
    });
    budget -= len;
  }

  const out = reversed.reverse();
  while (out.length > 0 && out[0].role === "assistant") out.shift();
  if (out.length === 0 || out[out.length - 1].role !== "user") {
    out.push({ role: "user", content: fallbackText });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secretEqual(token, CLARA_WEBHOOK_SECRET)) {
    console.warn("[Clara] unauthorized");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const row = payload.record;
  if (!row || row.role !== ROLE.USER) return json({ skip: "not_user" });
  if (!row.text || row.text.trim() === "[áudio]") return json({ skip: "audio" });

  const sessionId = row.chat_session_id;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    return new Response("Invalid session_id", { status: 400 });
  }
  const messageId = row.id;
  if (!messageId) return new Response("Missing message id", { status: 400 });

  try {
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    const [historyRes, rateRes, dupRes] = await Promise.all([
      supa
        .from("clara_messages")
        .select("id,role,text,source,created_at")
        .eq("chat_session_id", sessionId)
        .or(`role.eq.${ROLE.USER},and(role.eq.${ROLE.CLARA},source.eq.${SOURCE_EDGE_FN})`)
        .order("created_at", { ascending: true })
        .limit(MAX_HISTORY),
      supa
        .from("clara_messages")
        .select("*", { count: "exact", head: true })
        .eq("chat_session_id", sessionId)
        .eq("role", ROLE.USER)
        .gte("created_at", since),
      supa
        .from("clara_messages")
        .select("id")
        .eq("chat_session_id", sessionId)
        .eq("role", ROLE.CLARA)
        .eq("source", SOURCE_EDGE_FN)
        .eq("metadata->>triggered_by", messageId)
        .limit(1),
    ]);

    if (dupRes.data && dupRes.data.length > 0) {
      console.log(`[Clara] sessão=${sessionId} msg=${messageId} já respondida`);
      return json({ skip: "duplicate" });
    }

    if ((rateRes.count ?? 0) > RATE_LIMIT_MAX) {
      console.warn(`[Clara] rate limit sessão=${sessionId}`);
      return json({ skip: "rate_limited" }, 429);
    }

    if (historyRes.error) throw historyRes.error;
    const history = (historyRes.data ?? []) as ClaraMessage[];

    const messages = buildMessages(history, row.text);
    const claraText = await callClaude(messages);

    const ins = await supa.from("clara_messages").insert({
      chat_session_id: sessionId,
      role: ROLE.CLARA,
      source: SOURCE_EDGE_FN,
      text: claraText,
      metadata: { triggered_by: messageId },
    });
    if (ins.error) throw ins.error;

    console.log(`[Clara] sessão=${sessionId} msg=${messageId} respondida (${claraText.length} chars)`);
    return json({ ok: true });
  } catch (err) {
    console.error(`[Clara] erro sessão=${sessionId} msg=${messageId}:`, err);
    return json({ error: "internal_error" }, 500);
  }
});
