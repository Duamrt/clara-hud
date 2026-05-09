// Clara Respond — Supabase Edge Function
// Trigger: Database Webhook → INSERT on clara_messages WHERE role = 'user'
// Flow: user msg → rate check → history → Claude → insert response

// ── Startup validation (fail fast, fail loud) ────────────────────────────────
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CLARA_WEBHOOK_SECRET = Deno.env.get("CLARA_WEBHOOK_SECRET");

if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
if (!CLARA_WEBHOOK_SECRET) throw new Error("CLARA_WEBHOOK_SECRET is required");

// ── Constants ─────────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX = 20;          // max user messages per window
const RATE_LIMIT_WINDOW_MS = 300000; // 5 minutes
const MAX_HISTORY = 30;
const MAX_INPUT_CHARS = 12000;       // ~3k tokens safety budget
const FETCH_TIMEOUT_MS = 25000;      // 25s for Claude + Supabase calls

// Accepts: standard UUID or the custom session ID format "word-word-hex-hex-hex"
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{6,80}$/;

const SUPABASE_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY!,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

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

// ── Types ─────────────────────────────────────────────────────────────────────
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
  content: string;
}

// ── Security helpers ──────────────────────────────────────────────────────────

// Constant-time string comparison — prevents timing attacks on the webhook secret
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) {
    // Still run a dummy comparison to avoid early-exit timing leak on length
    let dummy = 0;
    for (let i = 0; i < ab.length; i++) dummy |= ab[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
function fetchWithTimeout(url: string, opts: RequestInit, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function fetchHistory(sessionId: string): Promise<SupabaseRow[]> {
  // Only load messages from trusted sources to prevent history poisoning
  const url = `${SUPABASE_URL}/rest/v1/clara_messages` +
    `?chat_session_id=eq.${encodeURIComponent(sessionId)}` +
    `&or=(role.eq.user,and(role.eq.clara,source.eq.edge-fn))` +
    `&order=created_at.asc&limit=${MAX_HISTORY}&select=id,role,text,source,created_at`;

  const res = await fetchWithTimeout(url, { headers: SUPABASE_HEADERS });
  if (!res.ok) throw new Error(`history fetch failed: ${res.status}`);
  return res.json();
}

async function checkRateLimit(sessionId: string): Promise<boolean> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/clara_messages` +
    `?chat_session_id=eq.${encodeURIComponent(sessionId)}` +
    `&role=eq.user&created_at=gte.${since}&select=id`;

  const res = await fetchWithTimeout(url, { headers: SUPABASE_HEADERS });
  if (!res.ok) return false; // fail open on error to avoid blocking legit requests
  const rows: unknown[] = await res.json();
  return rows.length <= RATE_LIMIT_MAX;
}

// Idempotency: check if this specific message was already answered
async function alreadyAnswered(sessionId: string, triggeredById: string): Promise<boolean> {
  const url = `${SUPABASE_URL}/rest/v1/clara_messages` +
    `?chat_session_id=eq.${encodeURIComponent(sessionId)}` +
    `&role=eq.clara&source=eq.edge-fn` +
    `&metadata->>triggered_by=eq.${encodeURIComponent(triggeredById)}` +
    `&select=id&limit=1`;

  const res = await fetchWithTimeout(url, { headers: SUPABASE_HEADERS });
  if (!res.ok) return false;
  const rows: unknown[] = await res.json();
  return rows.length > 0;
}

async function insertResponse(sessionId: string, text: string, triggeredById: string): Promise<void> {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/clara_messages`, {
    method: "POST",
    headers: {
      ...SUPABASE_HEADERS,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      chat_session_id: sessionId,
      role: "clara",
      source: "edge-fn",
      text,
      metadata: { triggered_by: triggeredById },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`insert failed: ${res.status} — ${err}`);
  }
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function callClaude(messages: AnthropicMessage[]): Promise<string> {
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status}`);
  }

  const data = await res.json();
  const block = data.content?.[0];
  if (block?.type === "text") return block.text as string;
  throw new Error("Claude returned no text content");
}

function buildMessages(history: SupabaseRow[], fallbackText: string): AnthropicMessage[] {
  const msgs: AnthropicMessage[] = [];

  // Apply character budget — keep the most recent messages first
  let budget = MAX_INPUT_CHARS - CLARA_SYSTEM.length;
  const candidates: AnthropicMessage[] = [];

  for (const row of history) {
    if (row.role === "user") {
      candidates.push({ role: "user", content: row.text });
    } else if (row.role === "clara") {
      candidates.push({ role: "assistant", content: row.text });
    }
  }

  // Walk backwards to fit within budget
  const trimmed: AnthropicMessage[] = [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const len = candidates[i].content.length;
    if (budget - len < 0) break;
    trimmed.unshift(candidates[i]);
    budget -= len;
  }

  msgs.push(...trimmed);

  // Conversation must start with a user message
  while (msgs.length > 0 && msgs[0].role === "assistant") {
    msgs.shift();
  }

  // Ensure the last message is the current user input
  if (msgs.length === 0 || msgs[msgs.length - 1].role !== "user") {
    msgs.push({ role: "user", content: fallbackText });
  }

  return msgs;
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Webhook secret — required, constant-time comparison
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!timingSafeEqual(token, CLARA_WEBHOOK_SECRET!)) {
    console.warn("[Clara] unauthorized request from", req.headers.get("cf-connecting-ip") ?? "unknown");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const row = payload.record ?? (payload as unknown as SupabaseRow);

  // Only process user messages
  if (!row || row.role !== "user") {
    return new Response(JSON.stringify({ skip: "not_user" }), { status: 200 });
  }

  // Skip audio messages (STT handled separately)
  if (!row.text || row.text.trim() === "[áudio]") {
    return new Response(JSON.stringify({ skip: "audio" }), { status: 200 });
  }

  // Validate session ID format before using in URLs
  const sessionId = row.chat_session_id;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    console.warn("[Clara] invalid session_id format:", sessionId);
    return new Response("Invalid session_id", { status: 400 });
  }

  const messageId = row.id;
  if (!messageId) {
    return new Response("Missing message id", { status: 400 });
  }

  try {
    // Idempotency — don't answer the same message twice (handles webhook retries)
    const duplicate = await alreadyAnswered(sessionId, messageId);
    if (duplicate) {
      console.log(`[Clara] sessão=${sessionId} msg=${messageId} já respondida, skip`);
      return new Response(JSON.stringify({ skip: "duplicate" }), { status: 200 });
    }

    // Rate limiting
    const allowed = await checkRateLimit(sessionId);
    if (!allowed) {
      console.warn(`[Clara] rate limit atingido para sessão=${sessionId}`);
      return new Response(JSON.stringify({ skip: "rate_limited" }), { status: 429 });
    }

    const history = await fetchHistory(sessionId);
    const messages = buildMessages(history, row.text);

    const claraText = await callClaude(messages);
    await insertResponse(sessionId, claraText, messageId);

    console.log(`[Clara] sessão=${sessionId} msg=${messageId} respondida (${claraText.length} chars)`);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Log internally but never leak details to caller
    console.error(`[Clara] erro sessão=${sessionId} msg=${messageId}:`, err);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
