-- M1: Foundation — schema pgvector + clara_knowledge
-- Rodar no Supabase Dashboard → SQL Editor → New Query → Run

-- 1. Habilita pgvector
create extension if not exists vector;

-- 2. Tabela de chunks indexados
create table if not exists clara_knowledge (
  id              uuid primary key default gen_random_uuid(),
  source_path     text not null,                  -- ex: "Estrategia/02-DM-Pay/Restricoes.md"
  heading_path    text not null default '',       -- ex: "DM Pay > Restrições > Isolamento"
  content         text not null,
  content_hash    text not null,                  -- sha256 do content; skip embed se igual
  embedding       vector(1024),                   -- voyage-3 = 1024 dims
  is_deleted      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (source_path, heading_path)
);

-- 3. Índice HNSW + cosine para busca vetorial
create index if not exists clara_knowledge_embedding_idx
  on clara_knowledge using hnsw (embedding vector_cosine_ops);

-- 4. Índice parcial: queries só leem rows ativas
create index if not exists clara_knowledge_active_idx
  on clara_knowledge (source_path) where is_deleted = false;

-- 5. RLS: bloqueia tudo. Apenas service role (Edge Functions) acessa.
alter table clara_knowledge enable row level security;
-- (Sem policy = ninguém com anon key lê/escreve. Service role bypassa RLS.)

-- 6. Trigger updated_at automático
create or replace function clara_knowledge_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists clara_knowledge_updated_at on clara_knowledge;
create trigger clara_knowledge_updated_at
  before update on clara_knowledge
  for each row execute function clara_knowledge_touch_updated_at();


-- ──────────────────────────────────────────────────────────────────────────────
-- VALIDAÇÃO — rodar logo após o migration acima e me colar a saída de cada um
-- ──────────────────────────────────────────────────────────────────────────────

-- V1: extensão habilitada
select extname, extversion from pg_extension where extname = 'vector';
-- Esperado: 1 row, vector + versão (>= 0.5.0)

-- V2: tabela criada com colunas certas
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'clara_knowledge'
order by ordinal_position;
-- Esperado: 9 colunas (id, source_path, heading_path, content, content_hash,
--                       embedding, is_deleted, created_at, updated_at)

-- V3: índice HNSW criado
select indexname, indexdef
from pg_indexes
where tablename = 'clara_knowledge';
-- Esperado: 3 índices (pkey, embedding_idx hnsw, active_idx parcial, unique constraint)

-- V4: tabela vazia, select funciona sem erro
select count(*) as total from clara_knowledge;
-- Esperado: total = 0

-- V5: RLS ligada
select relname, relrowsecurity
from pg_class
where relname = 'clara_knowledge';
-- Esperado: relrowsecurity = true

-- V6: insert + delete funciona (smoke test)
insert into clara_knowledge (source_path, heading_path, content, content_hash)
values ('test/smoke.md', 'Smoke', 'conteudo de teste', 'hash-fake-001');

select id, source_path, heading_path, content, is_deleted
from clara_knowledge
where source_path = 'test/smoke.md';
-- Esperado: 1 row, is_deleted = false, updated_at preenchido

delete from clara_knowledge where source_path = 'test/smoke.md';
-- Esperado: DELETE 1
