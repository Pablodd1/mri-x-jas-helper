
-- AIMS VISION RAG Schema (3 tables)
-- Run this in Supabase SQL Editor

CREATE EXTENSION IF NOT EXISTS vector;

-- 1. FINDINGS LIBRARY
CREATE TABLE IF NOT EXISTS findings_library (
  id SERIAL PRIMARY KEY,
  finding_key TEXT UNIQUE NOT NULL,
  condition_name TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('XRAY', 'MRI', 'CT')),
  anatomical_region TEXT NOT NULL,
  finding_text TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('mild', 'moderate', 'severe')),
  icd10_codes TEXT[],
  cpt_codes TEXT[],
  trauma_mechanisms TEXT[],
  embedding vector(1024)
);

-- 2. REPORTS
CREATE TABLE IF NOT EXISTS vision_reports (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  patient_name TEXT,
  modality TEXT,
  anatomical_region TEXT,
  raw_findings JSONB,
  rag_matches JSONB,
  impression TEXT,
  icd10_codes TEXT[],
  cpt_codes TEXT[],
  report_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. CODE LOOKUP
CREATE TABLE IF NOT EXISTS code_lookup (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  category TEXT
);

-- Index
CREATE INDEX IF NOT EXISTS idx_findings_embedding 
ON findings_library 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 20);
