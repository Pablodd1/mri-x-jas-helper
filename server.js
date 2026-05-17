require('dotenv').config();

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3002;
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';

// ═══════════════════ CONFIG ═══════════════════
const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama';
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';
const KIMI_VISION_MODEL = process.env.KIMI_VISION_MODEL || 'kimi-k2.6';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

const CONFIG = {
  provider: AI_PROVIDER,
  fastDemo: process.env.FAST_DEMO === 'true',
  visionModel: 'llava:13b',
  chatModel: 'deepseek-r1:7b',   // clinical reasoning — replaced llama3.1:8b
  fastChatModel: 'phi4-mini:3.8b', // fast SOAP/quick notes — replaced gemma4
  embedModel: 'bge-m3:latest',
  kimiModel: KIMI_MODEL,
  kimiVisionModel: KIMI_VISION_MODEL,
  kimiBaseUrl: KIMI_BASE_URL,
  kimiApiKey: KIMI_API_KEY,
  deepseekApiKey: DEEPSEEK_API_KEY,
  deepseekBaseUrl: DEEPSEEK_BASE_URL,
  dbUrl: process.env.DATABASE_URL || 'postgresql://postgres.vodhhauwowkalvaxzqyv:***@aws-1-us-west-2.pooler.supabase.com:6543/postgres',
  keepAlive: '2h',
};

console.log(`\n🤖 AI PROVIDER: ${CONFIG.provider.toUpperCase()}`);
if (CONFIG.provider === 'kimi') {
  console.log(`   Model: ${CONFIG.kimiModel} | Vision: ${CONFIG.kimiVisionModel}`);
  console.log(`   Base: ${CONFIG.kimiBaseUrl}`);
} else {
  console.log(`   Vision: ${CONFIG.visionModel} | Chat: ${CONFIG.chatModel}`);
}

// ═══════════════════ DB ═══════════════════
const pool = new Pool({
  connectionString: CONFIG.dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 5, connectionTimeoutMillis: 10000,
});

async function ensureSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lab_reports (
        id SERIAL PRIMARY KEY,
        patient_id INTEGER,
        report_data TEXT,
        report_type VARCHAR(50),
        file_name VARCHAR(255),
        analysis TEXT,
        recommendations TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS icd10_codes (
        id SERIAL PRIMARY KEY,
        doctor_id INTEGER DEFAULT 2,
        code VARCHAR(20),
        description TEXT,
        category VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cpt_codes (
        id SERIAL PRIMARY KEY,
        doctor_id INTEGER DEFAULT 2,
        code VARCHAR(20),
        description TEXT,
        category VARCHAR(100),
        rvu NUMERIC(8,2),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS medical_knowledge_chunks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255),
        content TEXT,
        category VARCHAR(100),
        source VARCHAR(255),
        embedding vector(1024),
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✓ DB schema ready');
  } catch (e) {
    console.error('Schema ensure failed:', e.message);
  }
}

// ═══════════════════ MIDDLEWARE ═══════════════════
app.use(express.json({ limit: '100mb' }));
app.use(require('cors')({ origin: true, credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024, files: 50 }, // 100MB per file, up to 50 files
});

// ═══════════════════ SESSION MEMORY ═══════════════════
// Holds prescription data + image findings across steps
const sessions = {};
const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getSession(id) {
  const s = sessions[id];
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL) { delete sessions[id]; return null; }
  return s;
}
function createSession() {
  const id = crypto.randomBytes(6).toString('hex');
  sessions[id] = { id, created: Date.now(), prescription: null, images: [], findings: [], correlation: null, note: null };
  return sessions[id];
}

// Clean old sessions every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (now - s.created > SESSION_TTL) delete sessions[id];
  }
}, 5 * 60 * 1000);

// ═══════════════════ OLLAMA HELPERS ═══════════════════
async function ollamaChat(model, messages, timeout = 60000) {
  const keepAlive = model === CONFIG.visionModel || model === CONFIG.embedModel ? CONFIG.keepAlive : '5m';
  const res = await axios.post(`${OLLAMA}/api/chat`, {
    model, messages, stream: false, keep_alive: keepAlive,
    options: { temperature: 0.2, num_predict: 1536 }
  }, { timeout });
  return res.data.message.content;
}

async function ollamaVisionBatch(model, prompt, imagesBase64, concurrency = 2) {
  // Process images in parallel batches to avoid GPU overload
  const results = [];
  for (let i = 0; i < imagesBase64.length; i += concurrency) {
    const batch = imagesBase64.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(img => axios.post(`${OLLAMA}/api/generate`, {
        model, prompt, keep_alive: CONFIG.keepAlive,
        images: [img],
        stream: false,
        options: { temperature: 0.1, num_predict: 512 }
      }, { timeout: 90000 }))
    );
    for (const r of batchResults) {
      results.push(r.status === 'fulfilled' ? r.value.data.response : `ERROR: ${r.reason?.message}`);
    }
  }
  return results;
}

async function ollamaEmbed(model, text) {
  const res = await axios.post(`${OLLAMA}/api/embeddings`, {
    model, prompt: text.slice(0, 4000), keep_alive: CONFIG.keepAlive
  }, { timeout: 120000 });
  return res.data.embedding;
}

// ═══════════════════ KIMI K2.6 API HELPERS (OpenAI-compatible) ═══════════════════
async function kimiChat(messages, { model, temperature = 0.2, max_tokens = 8192, timeout = 180000 } = {}) {
  const m = model || CONFIG.kimiModel;
  console.log(`   🤖 Kimi K2.6 → Chat (${m}, ${messages.length} msgs, max_tokens=${max_tokens})`);
  const res = await axios.post(`${CONFIG.kimiBaseUrl}/chat/completions`, {
    model: m,
    messages,
    temperature,
    max_tokens,
  }, {
    headers: { Authorization: `Bearer ${CONFIG.kimiApiKey}`, 'Content-Type': 'application/json' },
    timeout,
  });
  const choice = res.data.choices?.[0];
  let content = choice?.message?.content;
  const finish = choice?.finish_reason;
  // Kimi K2.6 puts output in reasoning_content when thinking mode is active
  // If content is empty but reasoning_content exists, use that
  if (!content && choice?.message?.reasoning_content) {
    console.log(`   ⚠️ Kimi spent all tokens on reasoning — using reasoning_content as output`);
    content = choice.message.reasoning_content;
  }
  if (!content) {
    console.error(`   ❌ Kimi empty content. Finish: ${finish}.`);
    console.error(`   Usage:`, JSON.stringify(res.data.usage));
    console.error(`   Message keys:`, choice?.message ? Object.keys(choice.message) : 'null');
    throw new Error(`Kimi returned no content. Finish: ${finish || 'unknown'}. Check server logs.`);
  }
  console.log(`   ✅ Kimi response: ${content.length} chars, finish: ${finish}`);
  return content;
}

async function kimiVision(prompt, imagesBase64, { model, temperature = 0.2, max_tokens = 2048, timeout = 120000 } = {}) {
  const m = model || CONFIG.kimiVisionModel;
  console.log(`   👁️  Kimi K2.6 → Vision (${m}, ${imagesBase64.length} images)`);
  
  // Build content array with images
  const content = [{ type: 'text', text: prompt }];
  for (const img of imagesBase64) {
    // Determine MIME type from base64 header or default to jpeg
    const mime = img.startsWith('/9j/') ? 'image/jpeg' : img.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${img}` }
    });
  }

  const res = await axios.post(`${CONFIG.kimiBaseUrl}/chat/completions`, {
    model: m,
    messages: [{ role: 'user', content }],
    temperature,
    max_tokens,
  }, {
    headers: { Authorization: `Bearer ${CONFIG.kimiApiKey}`, 'Content-Type': 'application/json' },
    timeout,
  });
  const resp = res.data.choices?.[0]?.message?.content;
  if (!resp) throw new Error(`Kimi vision returned no content. Finish: ${res.data.choices?.[0]?.finish_reason}`);
  return resp;
}

async function kimiVisionBatch(prompt, imagesBase64, concurrency = 2, model) {
  // Process images in parallel batches
  const results = [];
  for (let i = 0; i < imagesBase64.length; i += concurrency) {
    const batch = imagesBase64.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(img => kimiVision(prompt, [img], { model }))
    );
    for (const r of batchResults) {
      results.push(r.status === 'fulfilled' ? r.value : `ERROR: ${r.reason?.message}`);
    }
  }
  return results;
}

// ═══════════════════ UNIFIED AI WRAPPERS ═══════════════════
// Cascading: tries Ollama → Kimi → DeepSeek (never returns null early)

async function aiChat(messages, options = {}) {
  const errors = [];
  
  // 1. Try Ollama (local)
  if (CONFIG.provider !== 'kimi' && CONFIG.provider !== 'deepseek') {
    try {
      const model = options.model || CONFIG.chatModel;
      return await ollamaChat(model, messages, options.timeout || 300000);
    } catch (e) { errors.push('Ollama: ' + e.message); }
  }
  
  // 2. Try Kimi
  if (CONFIG.kimiApiKey) {
    try {
      return await kimiChat(messages, options);
    } catch (e) { errors.push('Kimi: ' + e.message); }
  }
  
  // 3. Try DeepSeek
  if (CONFIG.deepseekApiKey) {
    try {
      const res = await axios.post(`${CONFIG.deepseekBaseUrl}/chat/completions`, {
        model: 'deepseek-chat',
        messages, temperature: 0.2, max_tokens: 4096
      }, {
        headers: { Authorization: `Bearer ${CONFIG.deepseekApiKey}`, 'Content-Type': 'application/json' },
        timeout: options.timeout || 180000
      });
      const content = res.data.choices?.[0]?.message?.content;
      if (content) return content;
      errors.push('DeepSeek: empty response');
    } catch (e) { errors.push('DeepSeek: ' + e.message); }
  }
  
  throw new Error(`All AI providers failed: ${errors.join(' | ')}`);
}

async function aiVision(prompt, imagesBase64, concurrency = 2, model) {
  const errors = [];
  
  // 1. Try Ollama vision
  if (CONFIG.provider !== 'kimi' && CONFIG.provider !== 'deepseek') {
    try {
      const m = model || CONFIG.visionModel;
      return await ollamaVisionBatch(m, prompt, imagesBase64, concurrency);
    } catch (e) { errors.push('Ollama Vision: ' + e.message); }
  }
  
  // 2. Try Kimi vision
  if (CONFIG.kimiApiKey) {
    try {
      return await kimiVisionBatch(prompt, imagesBase64, concurrency, model);
    } catch (e) { errors.push('Kimi Vision: ' + e.message); }
  }
  
  throw new Error(`All vision providers failed: ${errors.join(' | ')}`);
}

async function aiEmbed(model, text) {
  // Embeddings always use Ollama (local) — Kimi doesn't expose embeddings API
  return ollamaEmbed(model || CONFIG.embedModel, text);
}

// ═══════════════════ RAG ═══════════════════
async function searchRAG(query, topK = 5) {
  const embedding = await aiEmbed(null, query);
  const { rows } = await pool.query(
    `SELECT title, content, category, 1 - (embedding <=> $1::vector) AS score
     FROM medical_knowledge_chunks
     WHERE category LIKE 'acr_criteria%' OR category LIKE 'differential%'
        OR category LIKE 'mri_physics%' OR category LIKE 'radiology%'
        OR category LIKE 'emergency%'
     ORDER BY embedding <=> $1::vector LIMIT $2`,
    [`[${embedding.join(',')}]`, topK]
  );
  return rows;
}

// ═══════════════════ FINDINGS RAG (Trauma/MVA focused) ═══════════════════
async function ensureFindingsTable() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS findings_library (
        id SERIAL PRIMARY KEY,
        finding_key TEXT UNIQUE NOT NULL,
        condition_name TEXT NOT NULL,
        modality TEXT NOT NULL,
        anatomical_region TEXT NOT NULL,
        finding_text TEXT NOT NULL,
        severity TEXT,
        icd10_codes TEXT[],
        cpt_codes TEXT[],
        trauma_mechanisms TEXT[],
        embedding vector(1024)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_findings_embedding ON findings_library USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20)`);
    console.log('📚 Findings RAG table ready');
  } catch (e) { console.log('⚠️ Findings RAG table setup skipped:', e.message); }
}

async function seedFindings() {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int as c FROM findings_library');
    if (rows[0].c > 0) { console.log(`📚 Findings RAG: ${rows[0].c} already seeded`); return; }
    
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'rag-findings.json'), 'utf8'));
    for (const f of data) {
      const embedding = await aiEmbed(CONFIG.embedModel, f.finding_text);
      await pool.query(
        `INSERT INTO findings_library (finding_key, condition_name, modality, anatomical_region, finding_text, severity, icd10_codes, cpt_codes, trauma_mechanisms, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (finding_key) DO NOTHING`,
        [f.finding_key, f.condition_name, f.modality, f.anatomical_region, f.finding_text, f.severity, f.icd10_codes, f.cpt_codes, f.trauma_mechanisms, `[${embedding.join(',')}]`]
      );
    }
    console.log(`📚 Findings RAG: seeded ${data.length} findings`);
  } catch (e) { console.log('⚠️ Findings RAG seed skipped:', e.message); }
}

async function searchFindings(query, modality, topK = 5) {
  try {
    const embedding = await aiEmbed(CONFIG.embedModel, query);
    let sql = `SELECT finding_key, condition_name, modality, anatomical_region, finding_text, severity, icd10_codes, cpt_codes, trauma_mechanisms, 1 - (embedding <=> $1::vector) AS score FROM findings_library`;
    const params = [`[${embedding.join(',')}]`];
    
    if (modality) {
      sql += ` WHERE modality = $2`;
      params.push(modality);
    }
    sql += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length}`;
    params.push(topK);
    
    const { rows } = await pool.query(sql, params);
    return rows.filter(r => r.score > 0.5);
  } catch (e) {
    console.log('⚠️ Findings search error:', e.message);
    return [];
  }
}

async function saveReport(sessionId, patientName, modality, anatomicalRegion, rawFindings, ragMatches, impression, icd10, cpt, reportText) {
  try {
    await pool.query(
      `INSERT INTO vision_reports (session_id, patient_name, modality, anatomical_region, raw_findings, rag_matches, impression, icd10_codes, cpt_codes, report_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [sessionId, patientName, modality, anatomicalRegion, JSON.stringify(rawFindings), JSON.stringify(ragMatches), impression, icd10, cpt, reportText]
    );
  } catch (e) { console.log('⚠️ Report save error:', e.message); }
}

// Initialize findings RAG on startup
ensureFindingsTable().then(() => seedFindings());

// ═══════════════════ STEP 1: PRESCRIPTION ANALYSIS ═══════════════════
app.post('/api/prescription/analyze', upload.single('prescription'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No prescription image uploaded' });

    const session = req.body.session_id ? getSession(req.body.session_id) : null;
    const sess = session || createSession();

    // Read image
    const imageBuffer = fs.readFileSync(req.file.path);
    const imageBase64 = imageBuffer.toString('base64');

    console.log(`\n📋 STEP 1: Prescription Analysis — ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)}MB)`);

    const prompt = `You are a medical intake specialist. Analyze this prescription/referral document.
It may be a handwritten prescription, printed referral form, or clinical order.

Extract and structure the following information as JSON:
{
  "exam_type": "MRI / X-ray / CT / Ultrasound / Other — what imaging is ordered?",
  "body_region": "e.g., Left Knee, Lumbar Spine, Chest, Brain",
  "clinical_indication": "Why is the exam ordered? Chief complaint / reason",
  "preliminary_diagnosis": "Working diagnosis or suspected condition from the referring physician",
  "urgency": "routine / urgent / stat",
  "contrast": "with contrast / without contrast / both / not specified",
  "special_instructions": "Any specific views, protocols, or positioning notes",
  "referring_physician": "Name if visible",
  "facility": "Hospital or clinic name if visible",
  "patient_info_visible": true/false,
  "raw_text": "Any readable text from the document"
}

If you cannot determine something, use "not specified". Do not invent information.`;

    const result = await aiVision(prompt, [imageBase64], 1);
    const rawOutput = result[0];

    // Try to extract JSON from the response
    let prescription = {};
    try {
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) prescription = JSON.parse(jsonMatch[0]);
    } catch {
      prescription = { raw_analysis: rawOutput, exam_type: 'not specified', body_region: 'not specified' };
    }

    sess.prescription = { ...prescription, file_name: req.file.originalname, analyzed_at: new Date().toISOString() };

    // Clean up uploaded file
    fs.unlink(req.file.path, () => {});

    console.log(`   Extracted: ${prescription.exam_type} | ${prescription.body_region} | ${prescription.preliminary_diagnosis}`);

    res.json({
      success: true,
      session_id: sess.id,
      prescription: sess.prescription,
    });
  } catch (e) {
    console.error('Prescription analysis failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════ STEP 2: MULTI-IMAGE ANALYSIS ═══════════════════
app.post('/api/images/analyze', upload.array('images', 50), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'No images uploaded' });
    if (!req.body.session_id) return res.status(400).json({ error: 'session_id required — run Step 1 first' });

    const sess = getSession(req.body.session_id);
    if (!sess) return res.status(404).json({ error: 'Session expired or not found. Re-run Step 1.' });
    if (!sess.prescription) return res.status(400).json({ error: 'No prescription in session. Run Step 1 first.' });

    const files = req.files;
    console.log(`\n🔬 STEP 2: Analyzing ${files.length} image(s) — ${sess.prescription.exam_type} | ${sess.prescription.body_region}`);

    // Build prompt using prescription context + visit type (trauma mechanism)
    const prescription = sess.prescription;
    const visitType = sess.visit?.type || 'general';
    const patientName = sess.patient ? `${sess.patient.firstName || ''} ${sess.patient.lastName || ''}`.trim() : 'Unknown';
    
    const imagePrompt = `You are a board-certified trauma radiologist at a Level 1 trauma center, fellowship-trained in emergency and musculoskeletal radiology. You are reading a ${prescription.exam_type || 'diagnostic imaging'} study of the ${prescription.body_region || 'unknown region'}.

PATIENT CONTEXT:
- Patient: ${patientName}
- Trauma mechanism: ${visitType.replace(/_/g, ' ')}
- Clinical indication: ${prescription.clinical_indication || 'Not provided'}
- Suspected diagnosis: ${prescription.preliminary_diagnosis || 'Not specified'}
- Contrast: ${prescription.contrast || 'None'}
${prescription.urgency ? `- Urgency: ${prescription.urgency}` : ''}
${prescription.special_instructions ? `- Special instructions: ${prescription.special_instructions}` : ''}
${files.length > 1 ? `\nSERIES CONTEXT: This is image ${'{INDEX}'} of ${files.length} total slices in this series.${files.length > 1 ? ' Describe findings specific to this slice but note if they extend across multiple slices.' : ''}` : ''}

REQUIRED STRUCTURED REPORT:

TECHNIQUE:
- Confirm the imaging modality and view (e.g., \"Sagittal T2-weighted MRI of the cervical spine\")
- Note image quality (diagnostic / limited by motion artifact / suboptimal positioning)
- State if contrast was administered

KEY FINDINGS (list each separately with severity):
For each abnormality found, specify:
• Finding: What is seen (be specific — use standard radiology terminology)
• Location: Exact anatomical location (vertebral level, compartment, quadrant)
• Severity: rate as MILD / MODERATE / SEVERE
• Measurements: Provide mm or % when applicable (fracture displacement, canal compromise, disc protrusion size, etc.)
• Acuity: STATE whether the finding appears ACUTE (traumatic) vs CHRONIC (degenerative/pre-existing)

CRITICAL FINDINGS (flag immediately if present):
- Cord compression or cauda equina compression
- Unstable fracture (3-column injury, translation, distraction)
- Epidural hematoma with mass effect
- Vascular injury (dissection, occlusion)
- Pneumothorax / tension pneumothorax (chest)
- Free air / pneumoperitoneum (abdomen)

ADDITIONAL OBSERVATIONS:
- Alignment: Normal vs abnormal (listhesis, loss of lordosis/kyphosis, scoliosis)
- Bone marrow signal: Normal vs abnormal (edema pattern, infiltration)
- Soft tissues: Paraspinal muscles, prevertebral soft tissues, subcutaneous tissues
- Disc spaces: Height, signal, contour
- Facet joints: Degenerative changes, effusion, perching/locking
- Spinal canal and neural foramina: Patency, stenosis grade (mild/moderate/severe)

CORRELATION:
- Do the imaging findings support or contradict the suspected diagnosis?
- What is the MOST LIKELY diagnosis based on the imaging?
- What is the most important DIFFERENTIAL diagnosis to consider?

IMPRESSION (2-3 lines maximum):
- Primary diagnosis with confidence level
- Most significant secondary finding (if any)
- Critical action item (if any)

RECOMMENDATIONS:
- Additional imaging needed? (CT for fracture characterization, MRI if not already done, etc.)
- Surgical vs non-surgical management indicators
- Follow-up imaging timeline (if applicable)

RULES:
- Be SPECIFIC — use exact vertebral levels, anatomical compartments, and measurements
- Be HONEST — if the image quality is poor or a finding is uncertain, say so
- DISTINGUISH acute trauma from pre-existing degenerative changes
- Use STANDARD radiology terminology (not colloquial descriptions)
- NEVER fabricate findings not visible in the image
- If the image appears NORMAL, say so clearly — do not invent subtle findings`;

    // Read and encode all images
    const imagesBase64 = files.map(f => {
      const buf = fs.readFileSync(f.path);
      // If DICOM, try to extract pixel data; otherwise use raw file
      if (f.originalname.toLowerCase().endsWith('.dcm')) {
        try {
          const parsed = parseDicomHeader(f.path);
          if (parsed.imageBase64) {
            console.log(`   DICOM: ${f.originalname} — ${parsed.metadata.modality} ${parsed.metadata.bodyPartExamined || ''} (${parsed.metadata.rows}x${parsed.metadata.cols})`);
            // Attach DICOM metadata to session
            if (!sess.dicomMetadata) sess.dicomMetadata = [];
            sess.dicomMetadata.push(parsed.metadata);
            return parsed.imageBase64;
          }
        } catch (e) { console.log(`   DICOM parse failed for ${f.originalname}: ${e.message}`); }
      }
      return buf.toString('base64');
    });

    // Analyze in batches of 2-3 concurrently to balance speed vs GPU load
    const concurrency = files.length > 5 ? 2 : 3;
    const findings = [];
    for (let i = 0; i < imagesBase64.length; i += concurrency) {
      const batchPromises = [];
      for (let j = 0; j < concurrency && (i + j) < imagesBase64.length; j++) {
        const idx = i + j;
        const prompt = imagePrompt.replace('{INDEX}', String(idx + 1));
        batchPromises.push(
          aiVision(prompt, [imagesBase64[idx]], 1).then(result => ({
            index: idx + 1,
            file_name: files[idx].originalname,
            file_size_mb: (files[idx].size / (1024 * 1024)).toFixed(1),
            analysis: result[0],
          }))
        );
      }
      const batchResults = await Promise.all(batchPromises);
      findings.push(...batchResults);
    }

    sess.images = files.map(f => ({ name: f.originalname, size: f.size }));
    sess.findings = findings;

    // Search RAG (legacy medical knowledge) + Findings Library (trauma/MVA)
    const ragQuery = `${prescription.body_region} ${prescription.preliminary_diagnosis || ''} ${findings.map(f => f.analysis).join(' ')}`.slice(0, 2000);
    const [ragResults, findingsMatches] = await Promise.all([
      searchRAG(ragQuery, 5).catch(() => []),
      searchFindings(ragQuery, prescription.exam_type || null, 5).catch(() => [])
    ]);
    sess.rag = ragResults;
    sess.findings_matches = findingsMatches;

    // Clean up uploaded files
    files.forEach(f => fs.unlink(f.path, () => {}));

    console.log(`   Analyzed ${findings.length} images. RAG: ${ragResults.length} sources. Findings matches: ${findingsMatches.length}`);

    res.json({
      success: true,
      session_id: sess.id,
      image_count: findings.length,
      findings,
      rag: ragResults.map(r => ({ title: r.title, category: r.category, score: r.score })),
      findings_matches: findingsMatches.map(f => ({
        finding_key: f.finding_key,
        condition_name: f.condition_name,
        severity: f.severity,
        icd10_codes: f.icd10_codes,
        cpt_codes: f.cpt_codes,
        score: f.score
      })),
    });
  } catch (e) {
    console.error('Image analysis failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════ STEP 3: CORRELATION ═══════════════════
app.post('/api/correlate', async (req, res) => {
  try {
    const { session_id, findings, doctor_notes, patient_info, visit_type, mode } = req.body;
    
    // === MODE: COMBINE (Step 4 — synthesize AI + doctor input) ===
    if (mode === 'combine') {
      if (!findings && !doctor_notes) {
        return res.status(400).json({ error: 'Need AI findings or doctor notes to combine' });
      }
      
      console.log(`\n🔄 COMBINE MODE: Synthesizing AI analysis + doctor input`);
      
      const combinePrompt = [
        { role: 'system', content: `You are a senior radiology report synthesizer. Your job is to combine the AI's image analysis with the doctor's dictated notes into one coherent, authoritative radiology report. The doctor's input overrides the AI where they disagree. Remove redundancies, resolve conflicts (favor doctor), and produce a final structured report.

OUTPUT FORMAT:
FINDINGS: (combined objective findings — merge AI observations with doctor's corrections)
IMPRESSION: (final diagnosis incorporating both AI and doctor's assessment)
RECOMMENDATIONS: (next steps based on combined analysis)

RULES:
- Doctor's observations ALWAYS override AI when they conflict
- If doctor adds a finding AI missed, include it prominently
- If doctor contradicts AI, note "per clinical correlation" and use doctor's interpretation
- Be concise — this goes into the final report
- Mark any remaining discrepancies with [AI noted X; Doctor notes Y — correlate clinically]` },
        { role: 'user', content: `SYNTHESIZE THE FOLLOWING:\n\n=== AI IMAGE ANALYSIS ===\n${findings || 'No AI analysis provided'}\n\n=== DOCTOR'S NOTES & CORRECTIONS ===\n${doctor_notes || 'No doctor notes provided'}\n\n=== PATIENT CONTEXT ===\nPatient: ${patient_info || 'Unknown'}\nVisit type: ${visit_type || 'General'}\n\nProduce the combined radiology report now. Doctor's input takes priority.` }
      ];
      
      const correlation = await aiChat(combinePrompt, { timeout: 120000 });
      
      // Generate red flags from combined analysis
      let redFlags = [];
      try {
        const flagPrompt = [
          { role: 'system', content: `You are a CLINICAL RED FLAG DETECTOR. Review the combined radiology report and patient context. Return a JSON array: [{"severity":"critical|warning|info","message":"...","recommendation":"..."}]. Flag: critical findings needing immediate attention, missing documentation, trauma-specific concerns, follow-up gaps.` },
          { role: 'user', content: `Report:\n${correlation}\n\nPatient: ${patient_info}\nVisit: ${visit_type}\n\nFlag ALL documentation gaps and clinical concerns.` }
        ];
        const flagResult = await aiChat(flagPrompt, { max_tokens: 512, timeout: 60000 });
        const jsonMatch = flagResult.match(/\[[\s\S]*\]/);
        if (jsonMatch) redFlags = JSON.parse(jsonMatch[0]);
      } catch (e) { console.log('Red flag error:', e.message); }
      
      return res.json({ success: true, correlation, red_flags: redFlags });
    }
    
    // === DEFAULT MODE: Correlate prescription with image findings ===
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    const sess = getSession(session_id);
    if (!sess) return res.status(404).json({ error: 'Session expired' });
    if (!sess.prescription || !sess.findings?.length) {
      return res.status(400).json({ error: 'Need both prescription and image findings. Run Steps 1 and 2 first.' });
    }

    console.log(`\n🔗 STEP 3: Correlating prescription ↔ ${sess.findings.length} image(s)`);

    const prescription = sess.prescription;
    const findingsSummary = sess.findings.map((f, i) => `IMAGE ${i + 1} (${f.file_name}):\n${f.analysis}`).join('\n\n---\n\n');

    const correlationPrompt = [
      { role: 'system', content: `You are a senior radiologist performing correlation analysis between a referring physician's prescription and the actual imaging findings. Your job: identify agreements, discrepancies, and additional findings not mentioned in the prescription. Be thorough and honest.` },
      { role: 'user', content: `CORRELATION ANALYSIS

REFERRING PHYSICIAN'S PRESCRIPTION:
- Exam ordered: ${prescription.exam_type}
- Body region: ${prescription.body_region}
- Clinical indication: ${prescription.clinical_indication}
- Suspected diagnosis: ${prescription.preliminary_diagnosis}
- Urgency: ${prescription.urgency || 'not specified'}
- Contrast: ${prescription.contrast || 'not specified'}
- Special instructions: ${prescription.special_instructions || 'none'}

IMAGING FINDINGS (${sess.findings.length} image${sess.findings.length > 1 ? 's' : ''}):
${findingsSummary}

Please provide:
1. CONFIRMATION: Does the imaging confirm, rule out, or partially support the suspected diagnosis?
2. ADDITIONAL FINDINGS: What did the imaging reveal that was NOT mentioned in the prescription?
3. DISCREPANCIES: Any contradictions between the clinical indication and imaging findings?
4. CORRELATION SCORE: 0-100% — how well do the images correlate with the prescription?
5. RECOMMENDED NEXT STEPS: Additional views, contrast study, comparison studies, clinical follow-up
6. SUMMARY: One paragraph synthesis of the case` }
    ];

    const correlation = await aiChat(correlationPrompt);
    sess.correlation = correlation;

    // Generate red flags if doctor input + visit context provided
    let redFlags = [];
    if (findings || doctor_notes) {
      try {
        const flagPrompt = [
          { role: 'system', content: `You are a CLINICAL RED FLAG DETECTOR. Review the imaging findings, doctor's notes, and patient context. Return a JSON array of red flags: [{"severity":"critical|warning|info","message":"...","recommendation":"..."}]. Flag: missing vitals, missing consent, critical findings needing immediate attention, incomplete documentation, medication conflicts, contrast allergies, pregnancy status unknown, trauma-specific concerns.` },
          { role: 'user', content: `Patient: ${patient_info || 'Unknown'}\nVisit Type: ${visit_type || 'General'}\n\nImaging Findings:\n${findings || 'None'}\n\nDoctor Notes:\n${doctor_notes || 'None'}\n\nFlag ALL documentation gaps and clinical concerns.` }
        ];
        const flagResult = await aiChat(flagPrompt, { max_tokens: 1024 });
        const jsonMatch = flagResult.match(/\[[\s\S]*\]/);
        if (jsonMatch) redFlags = JSON.parse(jsonMatch[0]);
      } catch (e) { console.log('Red flag generation error:', e.message); }
    }
    sess.redFlags = redFlags;

    console.log(`   Correlation complete. Red flags: ${redFlags.length}`);

    res.json({ success: true, session_id: sess.id, correlation, red_flags: redFlags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════ STEP 4: GENERATE MEDICAL NOTE ═══════════════════
app.post('/api/generate-note', async (req, res) => {
  try {
    const { session_id, doctor_notes, prompt_template, patient, visit, prescription, ai_findings, impression, icd10_codes, cpt_codes, red_flags, dictation, report_text } = req.body;
    
    let sess = null;
    if (session_id) sess = getSession(session_id);
    
    console.log(`\n📝 STEP 4: Generating + saving medical note`);
    
    // Use provided data or extract from session
    const rx = prescription || sess?.prescription || {};
    const findingsSummary = ai_findings 
      ? ai_findings.map((f, i) => `IMAGE ${i + 1}: ${f.analysis}`).join('\n\n')
      : (sess?.findings || []).map((f, i) => `IMAGE ${i + 1}: ${f.analysis}`).join('\n\n');
    const ragContext = (sess?.rag || []).map(r => `[${r.category}] ${r.title}`).join('\n');
    const correlation = sess?.correlation || '';
    
    // If report_text already provided (from frontend preview), use it directly
    const note = report_text || 'Report generated by AIMS VISION PRO';
    
    if (sess) sess.note = note;
    
    // Save to findings_matches and reports in Supabase
    const patientId = patient?.mrn || session_id || crypto.randomUUID();
    try {
      // Save to vision_reports table
      if (sess) {
        await saveReport(
          session_id,
          `${patient?.firstName || ''} ${patient?.lastName || ''}`.trim() || 'Unknown',
          rx.exam_type || 'Unknown',
          rx.body_region || 'Unknown',
          ai_findings || sess?.findings || [],
          sess?.findings_matches || [],
          impression || '',
          (icd10_codes || []).map(c => c.code).filter(Boolean),
          (cpt_codes || []).map(c => c.code).filter(Boolean),
          note
        );
      }
      
      // Also save legacy lab_reports for backward compat
      await pool.query(
        `INSERT INTO lab_reports (patient_id, report_data, report_type, file_name, analysis, recommendations, created_at)
         VALUES ($1, $2, 'radiology', $3, $4, $5, NOW())`,
        [patientId, JSON.stringify({ patient, visit, rx, findings: ai_findings, impression, icd10_codes, cpt_codes, red_flags, dictation }), 
         `${rx.exam_type}_${rx.body_region}`.replace(/\s+/g, '_'),
         findingsSummary.slice(0, 4000),
         note.slice(0, 2000)]
      );
      console.log('   ✅ Report saved to DB');
    } catch (e) { console.log('   ⚠️ DB save error:', e.message); }
    
    res.json({ success: true, note, report_text: note });
  } catch (e) {
    console.error('Generate note failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ═══════════════════ SESSION ENDPOINTS ═══════════════════
app.get('/api/session/:id', (req, res) => {
  const sess = getSession(req.params.id);
  if (!sess) return res.status(404).json({ error: 'Session expired or not found' });
  res.json({
    id: sess.id,
    has_prescription: !!sess.prescription,
    has_images: !!sess.images?.length,
    has_findings: !!sess.findings?.length,
    has_correlation: !!sess.correlation,
    has_note: !!sess.note,
    image_count: sess.images?.length || 0,
    prescription: sess.prescription ? { exam_type: sess.prescription.exam_type, body_region: sess.prescription.body_region } : null,
  });
});

app.post('/api/session/new', (req, res) => {
  const sess = createSession();
  if (req.body.patient) sess.patient = req.body.patient;
  if (req.body.visit) sess.visit = req.body.visit;
  res.json({ session_id: sess.id, patient: sess.patient, visit: sess.visit });
});

// ═══════════════════ UTILITY ═══════════════════
app.get('/api/health', async (req, res) => {
  let dbOk = false, ollamaOk = false, models = [];
  try {
    const { rows } = await pool.query('SELECT 1');
    dbOk = rows.length > 0;
  } catch (e) { console.error('Health DB check:', e.message); }
  try {
    const { data } = await axios.get(`${OLLAMA}/api/tags`, { timeout: 3000 });
    ollamaOk = true;
    models = data.models?.map(m => m.name) || [];
  } catch (e) { /* Ollama optional */ }
  const overall = dbOk ? 'healthy' : 'degraded';
  res.json({ status: overall, service: 'AIMS VISION PRO', db: dbOk, ollama: ollamaOk, models, sessions_active: Object.keys(sessions).length });
});

app.get('/api/pipeline/check', async (req, res) => {
  const checks = {};
  try { await aiEmbed(null, 'test'); checks.embed = true; } catch { checks.embed = false; }
  try { await aiChat([{ role: 'user', content: 'OK' }], 15000); checks.chat = true; } catch { checks.chat = false; }
  try { const { rows } = await pool.query('SELECT 1'); checks.db = true; } catch { checks.db = false; }
  try {
    if (CONFIG.provider === 'kimi') {
      await kimiChat([{ role: 'user', content: 'Say OK' }], { max_tokens: 5 });
    } else {
      await axios.post(`${OLLAMA}/api/generate`, { model: CONFIG.visionModel, prompt: 'Say ready', images: [Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64').toString('base64')], stream: false, options: { num_predict: 5 } }, { timeout: 30000 });
    }
    checks.vision = true;
  } catch { checks.vision = false; }
  res.json({ ready: Object.values(checks).every(Boolean), checks });
});

// ═══════════════════ DEMO: MOCK DATA + MULTI-AGENT ═══════════════════

const MOCK_CASES = {
  knee_mri: {
    prescription: {
      exam_type: 'MRI',
      body_region: 'Right Knee',
      clinical_indication: '35-year-old male soccer player with acute right knee pain, swelling, and instability after twisting injury during match 3 days ago. Unable to fully weight-bear. Positive McMurray test. Suspect medial meniscus tear vs ACL injury.',
      preliminary_diagnosis: 'Medial meniscus tear, right knee. Rule out ACL rupture.',
      urgency: 'urgent',
      contrast: 'without contrast',
      special_instructions: 'Standard knee MRI protocol. Include sagittal, coronal, and axial T1 and T2-weighted sequences. Pay special attention to menisci and cruciate ligaments.',
      referring_physician: 'Dr. Michael Torres, Sports Medicine',
      facility: 'Miami Orthopedic & Sports Medicine Center',
    },
    mock_findings: [
      {
        index: 1, file_name: 'knee_sagittal_t2_001.dcm',
        analysis: `MODALITY CONFIRMATION: MRI Right Knee — correct exam type.
ANATOMY: Right knee joint visualized in sagittal plane. Femoral condyles, tibial plateau, patella, menisci, and cruciate ligaments well visualized.
KEY FINDINGS:
- Medial meniscus: Grade 3 tear involving the posterior horn with a displaced bucket-handle fragment extending into the intercondylar notch. Tear measures approximately 18mm.
- ACL: Complete proximal rupture with retraction of the ligament fibers. Large joint effusion with lipohemarthrosis indicating intra-articular fracture component.
- Lateral meniscus: Intact, no tear identified.
- MCL: Grade 1 sprain with mild periligamentous edema.
- Bone: Bone contusion involving the lateral femoral condyle and posterolateral tibial plateau (kissing contusions pattern consistent with pivot-shift mechanism).
- Cartilage: Focal grade 2 chondral fissuring of the medial femoral condyle.
CORRELATION WITH SUSPECTED DIAGNOSIS: Confirms medial meniscus tear AND reveals additional ACL rupture not explicitly mentioned in referral.
ABNORMALITIES:
- Medial meniscus bucket-handle tear — SEVERE
- ACL complete rupture — SEVERE
- Kissing bone contusions — MODERATE
- MCL grade 1 sprain — MILD
IMAGE QUALITY: Excellent. No motion artifact. Adequate for surgical planning.`
      },
      {
        index: 2, file_name: 'knee_coronal_t1_002.dcm',
        analysis: `MODALITY: MRI Right Knee — Coronal T1.
ANATOMY: Coronal view confirms anatomy. Both compartments visible.
KEY FINDINGS:
- Confirms displaced bucket-handle meniscus fragment in intercondylar notch (classic "double PCL" sign on sagittal — fragment lies anterior and inferior to PCL).
- ACL rupture confirmed with empty notch sign.
- Joint effusion is large, extending into suprapatellar recess.
- Lateral compartment: preserved joint space, no meniscal pathology.
CORRELATION: Findings consistent with acute high-grade rotational knee injury (pivot-shift mechanism). Surgical intervention recommended.
ABNORMALITIES: Same as Image 1 — confirmed. IMAGE QUALITY: Good.`
      },
      {
        index: 3, file_name: 'knee_axial_t2_003.dcm',
        analysis: `MODALITY: MRI Right Knee — Axial T2 fat-saturated.
ANATOMY: Axial view of patellofemoral joint and menisci.
KEY FINDINGS:
- Patellofemoral joint: normal alignment, no chondral defect.
- Medial patellofemoral ligament (MPFL): intact.
- Displaced meniscus fragment clearly visible adjacent to PCL.
- Popliteus tendon: intact.
- Baker's cyst: small, 12mm, no rupture.
CORRELATION: Axial view provides excellent visualization of the displaced meniscal fragment position — confirms bucket-handle tear morphology.
RECOMMENDATION: Urgent orthopedic consultation for arthroscopic meniscus repair + ACL reconstruction. IMAGE QUALITY: Excellent.`
      }
    ],
    doctor_notes: 'Patient is a 35yo elite soccer midfielder. Injury occurred during pivoting maneuver with planted foot. Audible pop reported. Immediate swelling within 2 hours. Unable to continue play. On exam: large effusion, positive Lachman, positive McMurray medial. Plan: schedule urgent arthroscopy within 5 days. Discussed surgical options with patient — arthroscopic meniscus repair + ACL reconstruction with hamstring autograft.',
  },

  chest_xray: {
    prescription: {
      exam_type: 'X-ray',
      body_region: 'Chest',
      clinical_indication: '62-year-old female with 3-day history of productive cough, fever (102.4°F), chills, and progressive shortness of breath. 40-pack-year smoking history. Diminished breath sounds right lower lobe. SpO2 91% on room air. Rule out community-acquired pneumonia vs COPD exacerbation.',
      preliminary_diagnosis: 'Community-acquired pneumonia, right lower lobe. Rule out: COPD exacerbation, pulmonary edema, malignancy.',
      urgency: 'urgent',
      contrast: 'not specified',
      special_instructions: 'PA and lateral chest radiographs. Include apical lordotic views if needed.',
      referring_physician: 'Dr. Elena Rodriguez, Internal Medicine',
      facility: 'Miami General Hospital — Emergency Department',
    },
    mock_findings: [
      {
        index: 1, file_name: 'chest_pa_001.jpg',
        analysis: `MODALITY CONFIRMATION: PA Chest X-ray — correct exam type.
ANATOMY: Lungs, heart, mediastinum, pleura, and bony thorax visualized.
KEY FINDINGS:
- Right lower lobe: Dense alveolar consolidation with air bronchograms involving the right lower lobe. Silhouette sign present — right heart border remains distinct but right hemidiaphragm is partially obscured.
- Left lung: Clear. No infiltrates, effusions, or pneumothorax identified.
- Heart: Normal cardiomediastinal silhouette. CTR < 0.5.
- Pleura: No pleural effusion. Costophrenic angles are sharp bilaterally.
- Hilar regions: Normal. No lymphadenopathy.
- Bones: No acute fracture. Degenerative changes in thoracic spine consistent with age.
- Soft tissues: Unremarkable.
- Hyperinflation: Mildly increased AP diameter suggestive of COPD component.
CORRELATION: Confirms right lower lobe consolidation consistent with community-acquired pneumonia. COPD component noted.
ABNORMALITIES:
- RLL consolidation — SEVERE (involving entire lower lobe)
- COPD changes — MODERATE (chronic)
IMAGE QUALITY: Good. Minimal rotation. Adequate inspiration (9 posterior ribs visible).`
      },
      {
        index: 2, file_name: 'chest_lateral_002.jpg',
        analysis: `MODALITY: Lateral Chest X-ray.
ANATOMY: Lateral view confirms localization of pathology.
KEY FINDINGS:
- RLL consolidation clearly visible posterior to the right hemidiaphragm. Confirms lower lobe location.
- Spine sign: increased density over lower thoracic spine confirming RLL pathology.
- Retrosternal airspace: increased, consistent with mild COPD.
- Left lung: clear on lateral view as well.
- No pleural effusion identified.
- Cardiac silhouette: normal.
CORRELATION: Lateral view confirms PA findings — RLL pneumonia. No additional pathology identified.
IMAGE QUALITY: Good diagnostic quality. IMAGE QUALITY: Adequate.`
      }
    ],
    doctor_notes: 'Patient admitted from ED with CAP. Started on IV ceftriaxone 1g q24h + azithromycin 500mg q24h. Oxygen via nasal cannula at 2L to maintain SpO2 > 94%. CBC shows WBC 18.2K, CRP 156. Blood cultures pending. Will reassess in 24h for oral switch if clinically improving. Smoking cessation counseling provided.',
  }
};

// ═══════════ DEMO: Run full pipeline with mock data ═══════════
app.post('/api/demo/run', async (req, res) => {
  try {
    const { case_id = 'knee_mri' } = req.body;
    const mockCase = MOCK_CASES[case_id];
    if (!mockCase) return res.status(400).json({ error: `Unknown case. Use: ${Object.keys(MOCK_CASES).join(', ')}` });

    const sess = createSession();
    console.log(`\n🎬 DEMO: Running ${case_id}`);

    // Step 1: Load mock prescription
    sess.prescription = { ...mockCase.prescription, analyzed_at: new Date().toISOString(), source: 'mock_demo' };

    // Step 2: Load mock findings
    sess.images = mockCase.mock_findings.map(f => ({ name: f.file_name, size: 0 }));
    sess.findings = mockCase.mock_findings;

    // Step 3: RAG search (with timeout — don't block demo if RAG is slow)
    const ragQuery = `${mockCase.prescription.body_region} ${mockCase.prescription.preliminary_diagnosis}`;
    let ragResults = [];
    try {
      ragResults = await Promise.race([
        searchRAG(ragQuery, 3),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RAG timeout')), 15000))
      ]);
    } catch (ragErr) {
      console.log('   ⚠️ RAG skipped (timeout/unavailable):', ragErr.message);
    }
    sess.rag = ragResults;

    // ═══ FAST DEMO MODE ═══ Skip AI calls for instant results (Ollama is slow)
    if (CONFIG.fastDemo) {
      console.log('   🚀 FAST DEMO MODE — skipping AI calls, returning instant results');
      sess.correlation = `CORRELATION ANALYSIS\n\nCONFIRMATION: The imaging findings fully confirm the suspected diagnosis of ${mockCase.prescription.preliminary_diagnosis}.\n\nADDITIONAL FINDINGS: No additional significant findings beyond those described in the prescription.\n\nDISCREPANCIES: None identified.\n\nCORRELATION SCORE: 95%\n\nRECOMMENDED NEXT STEPS: ${mockCase.prescription.body_region.includes('Knee') ? 'Orthopedic referral for surgical evaluation of meniscal tear.' : 'Continue current antibiotic regimen. Follow-up chest X-ray in 48-72 hours.'}\n\nSUMMARY: Imaging correlates well with clinical presentation.`;
      sess.note = mockCase.mock_primary_report || `RADIOLOGY REPORT\n\nEXAM: ${mockCase.prescription.exam_type} — ${mockCase.prescription.body_region}\nINDICATION: ${mockCase.prescription.clinical_indication}\n\nFINDINGS:\n${sess.findings.map(f => f.analysis).join('\n\n')}\n\nIMPRESSION:\n1. ${mockCase.prescription.preliminary_diagnosis} confirmed.\n2. No additional acute findings.\n\nRECOMMENDATIONS:\n${mockCase.prescription.body_region.includes('Knee') ? '- Orthopedic consultation\n- MRI with contrast if surgery planned' : '- Continue current treatment\n- Follow-up imaging as clinically indicated'}`;
      sess.primary_report = sess.note;

      res.json({
        success: true, session_id: sess.id, case_id,
        steps: {
          prescription: { exam_type: sess.prescription.exam_type, body_region: sess.prescription.body_region },
          findings: sess.findings.length + ' images analyzed',
          rag: ragResults.length + ' ACR criteria matched',
          correlation: 'Complete (fast mode)',
        },
        primary_report: sess.primary_report,
        rag_sources: ragResults.map(r => ({ title: r.title, category: r.category, score: r.score })),
        fast_mode: true,
      });
      return;
    }

    // Step 4: Run correlation with summarized findings (keep it fast)
    console.log('   Running correlation (via AI provider)...');
    // Summarize findings to 150 chars each to keep prompt manageable
    const findingsSummary = sess.findings.map((f, i) => {
      const analysis = f.analysis || '';
      // Extract just KEY FINDINGS section
      const keyMatch = analysis.match(/KEY FINDINGS:[\s\S]*?(?=CORRELATION|RECOMMENDATION|ABNORMALITIES|IMAGE QUALITY|\n\n|$)/);
      const keyFindings = keyMatch ? keyMatch[0].trim() : analysis.slice(0, 200);
      return `IMAGE ${i+1}: ${keyFindings.slice(0, 300)}`;
    }).join('\n\n');
    
    const correlationPrompt = [
      { role: 'system', content: 'You are a senior radiologist. Be concise. Correlate prescription with imaging findings.' },
      { role: 'user', content: `CORRELATE:\nExam: ${mockCase.prescription.exam_type} — ${mockCase.prescription.body_region}\nIndication: ${mockCase.prescription.clinical_indication?.slice(0, 200)}\n\nImaging Key Findings:\n${findingsSummary}\n\nProvide concise: 1) Confirmation 2) Discrepancies 3) Correlation score 4) Next steps` }
    ];
    sess.correlation = await aiChat(correlationPrompt, { max_tokens: 1500, timeout: 120000 });

    // Step 5: Generate primary note (shorter, faster)
    console.log('   Generating primary report (Agent 1)...');
    const ragContext = ragResults.slice(0, 2).map(r => `[${r.category}] ${r.content?.slice(0, 150)}`).join('\n');
    const notePrompt = [
      { role: 'system', content: 'You are a SENIOR RADIOLOGIST. Generate a structured radiology report with: CLINICAL INDICATION, TECHNIQUE, FINDINGS, IMPRESSION (numbered), RECOMMENDATIONS. Be concise.' },
      { role: 'user', content: `Generate report:\n\nEXAM: ${mockCase.prescription.exam_type} — ${mockCase.prescription.body_region}\nINDICATION: ${mockCase.prescription.clinical_indication?.slice(0, 200)}\nNOTES: ${mockCase.doctor_notes?.slice(0, 200)}\n\nKEY FINDINGS:\n${findingsSummary}\n\nCORRELATION: ${sess.correlation?.slice(0, 500)}\n\nRAG: ${ragContext}` }
    ];
    const primaryReport = await aiChat(notePrompt, { max_tokens: 2000, timeout: 120000 });
    sess.note = primaryReport;
    sess.primary_report = primaryReport;

    res.json({
      success: true, session_id: sess.id, case_id,
      steps: {
        prescription: { exam_type: sess.prescription.exam_type, body_region: sess.prescription.body_region },
        findings: sess.findings.length + ' images analyzed',
        rag: ragResults.length + ' ACR criteria matched',
        correlation: 'Complete — ' + sess.correlation.slice(0, 100) + '...',
      },
      primary_report: primaryReport,
      rag_sources: ragResults.map(r => ({ title: r.title, category: r.category, score: r.score })),
    });
  } catch (e) {
    console.error('Demo failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════ MULTI-AGENT VERIFICATION ═══════════
app.post('/api/demo/verify', async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const sess = getSession(session_id);
    if (!sess?.primary_report) return res.status(404).json({ error: 'No primary report. Run /api/demo/run first.' });

    console.log(`\n🔍 MULTI-AGENT VERIFICATION — 3 Specialist Review`);

    // ═══ FAST DEMO MODE ═══ Skip AI calls for instant results
    if (CONFIG.fastDemo) {
      console.log('   🚀 FAST VERIFY MODE — returning pre-computed verification');
      const reportToReview = sess.primary_report;
      const agent2Review = `PEER REVIEW (Specialist Fact-Checker)

1. Anatomical accuracy: All described structures are correctly identified.
2. Measurement validity: Measurements and grades are clinically appropriate.
3. Missing findings: No significant findings appear to have been omitted.
4. Surgical/clinical implications: Recommendations align with standard of care.
5. Overall assessment: Report is accurate and complete. No corrections needed.`;
      const agent3Review = `CLINICAL ACCURACY & GUIDELINES REVIEW

1. ACR Appropriateness Criteria: Report follows established criteria.
2. ICD-10 terminology: Codes and terminology are correct.
3. Guidelines compliance: Recommendations align with current clinical practice.
4. Risk assessment: No contraindications or missed risks identified.
5. Urgency level: Appropriately classified.
6. Medico-legal completeness: Report structure is complete and sound.

VERDICT: APPROVED for patient record.`;
      const finalReport = `## FINAL VERIFIED RADIOLOGY REPORT\n\n${reportToReview}\n\n## VERIFICATION SUMMARY\n- Agent 2 (Specialist): All findings verified. No disagreements.\n- Agent 3 (Clinical Accuracy): Guidelines compliant. Terminology correct.\n- Chief Resolution: No disagreements to resolve.\n- Confidence: HIGH`;

      sess.final_report = finalReport;
      sess.agent2_review = agent2Review;
      sess.agent3_review = agent3Review;

      res.json({
        success: true, session_id,
        fast_mode: true,
        agents: {
          agent1: { role: 'Chief Radiologist', model: 'fast-mode', output: 'Primary report (see demo run)' },
          agent2: { role: 'Specialist Fact-Checker', model: 'fast-mode', review: agent2Review },
          agent3: { role: 'Clinical Accuracy Expert', model: 'fast-mode', review: agent3Review },
        },
        final_report: finalReport,
      });
      return;
    }

    const reportToReview = sess.primary_report;
    const prescription = sess.prescription;
    const findings = sess.findings;

    // ═══ AGENT 2: Orthopedic/MSK/Pulmonary Specialist ═══
    console.log('   Agent 2: Specialist Fact-Checker...');
    const agent2Prompt = [
      { role: 'system', content: `You are a SUBSPECIALIST in ${prescription.body_region.includes('Knee') ? 'Orthopedic Surgery and Sports Medicine' : 'Pulmonary and Critical Care Medicine'} with 15+ years experience. Your job: FACT-CHECK this radiology report. 
Focus on:
1. Anatomical accuracy — are the described structures correctly identified?
2. Measurement validity — do the measurements and grades make clinical sense?
3. Missing findings — what should have been mentioned but wasn't?
4. Surgical/clinical implications — are the recommendations appropriate?
5. Flag anything that seems incorrect, exaggerated, or missed.
Be critical. Disagree if needed. This is a peer review.` },
      { role: 'user', content: `PEER REVIEW:\n\nPrescription: ${JSON.stringify(prescription)}\n\nReport to review:\n${reportToReview}\n\nImage findings reference:\n${findings.map(f => f.analysis).join('\n---\n')}\n\nProvide your specialist review: agreements, disagreements, corrections, additions.` }
    ];
    const agent2Review = await aiChat(agent2Prompt);

    // ═══ AGENT 3: Clinical Accuracy Expert (qwen2.5-medical) ═══
    console.log('   Agent 3: Clinical Accuracy Expert...');
    const agent3Prompt = [
      { role: 'system', content: `You are a CLINICAL ACCURACY & GUIDELINES EXPERT. Your focus:
1. Does this report follow ACR Appropriateness Criteria?
2. Are the ICD-10 codes / clinical terminology correct?
3. Do the recommendations align with current clinical practice guidelines?
4. Are there any contraindications or risks not mentioned?
5. Does the urgency level match the clinical findings?
6. Is the report structure complete and medico-legally sound?
Be the final quality gate before this report reaches the patient.` },
      { role: 'user', content: `QUALITY REVIEW:\n\nCase: ${JSON.stringify(prescription)}\n\nPrimary Report:\n${reportToReview}\n\nSpecialist Review (Agent 2):\n${agent2Review}\n\nProvide your clinical accuracy assessment: guidelines compliance, terminology check, risk flags, completeness.` }
    ];
    const agent3Review = await aiChat(agent3Prompt);

    // ═══ AGENT 1 (gemma4): Synthesize Final Report ═══
    console.log('   Agent 1: Synthesizing final verified report...');
    const synthesisPrompt = [
      { role: 'system', content: `You are the CHIEF OF RADIOLOGY. You have:
- Your original report (Agent 1)
- A specialist fact-check (Agent 2: ${prescription.body_region.includes('Knee') ? 'Orthopedic Surgeon' : 'Pulmonologist'})
- A clinical accuracy review (Agent 3: Guidelines & Quality Expert)

Synthesize the FINAL VERIFIED REPORT. Incorporate valid corrections. Note where reviewers disagreed and your resolution. Produce a clean, authoritative final report ready for the patient's medical record.

Format as:
## FINAL VERIFIED RADIOLOGY REPORT
[The corrected, complete report]

## VERIFICATION SUMMARY
- Agent 2 (Specialist): [key findings — agreements/disagreements]
- Agent 3 (Clinical Accuracy): [guidelines compliance, terminology issues]
- Chief Resolution: [how disagreements were resolved]
- Confidence: HIGH / MEDIUM / LOW` },
      { role: 'user', content: `ORIGINAL REPORT:\n${reportToReview}\n\nAGENT 2 — SPECIALIST REVIEW:\n${agent2Review}\n\nAGENT 3 — CLINICAL ACCURACY REVIEW:\n${agent3Review}\n\nSynthesize the final verified report.` }
    ];
    const finalReport = await aiChat(synthesisPrompt);

    sess.final_report = finalReport;
    sess.agent2_review = agent2Review;
    sess.agent3_review = agent3Review;

    res.json({
      success: true, session_id,
      agents: {
        agent1: { role: 'Chief Radiologist', model: CONFIG.provider === 'kimi' ? CONFIG.kimiModel : 'gemma4:latest', output: 'Primary report (see /api/demo/run response)' },
        agent2: { role: 'Specialist Fact-Checker', model: CONFIG.provider === 'kimi' ? CONFIG.kimiModel : 'llama3.1:8b', review: agent2Review },
        agent3: { role: 'Clinical Accuracy Expert', model: CONFIG.provider === 'kimi' ? CONFIG.kimiModel : 'qwen2.5-medical:latest', review: agent3Review },
      },
      final_report: finalReport,
    });
  } catch (e) {
    console.error('Verification failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════ LIST DEMO CASES ═══════════
app.get('/api/demo/cases', (req, res) => {
  res.json({
    cases: Object.keys(MOCK_CASES).map(k => ({
      id: k,
      name: MOCK_CASES[k].prescription.body_region + ' — ' + MOCK_CASES[k].prescription.preliminary_diagnosis.split('.')[0],
      exam: MOCK_CASES[k].prescription.exam_type,
      images: MOCK_CASES[k].mock_findings.length,
    }))
  });
});

// ═══════════════════ DICOM PARSER ═══════════════════
const dicomParser = require('dicom-parser');

function parseDicomHeader(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const dataSet = dicomParser.parseDicom(buf);

    // Extract key patient/study metadata
    const extract = (tag) => {
      try { return dataSet.string(tag); } catch { return null; }
    };

    const metadata = {
      patientName: extract('x00100010'),
      patientId: extract('x00100020'),
      patientBirthDate: extract('x00100030'),
      patientSex: extract('x00100040'),
      studyDate: extract('x00080020'),
      studyDescription: extract('x00081030'),
      modality: extract('x00080060'),
      bodyPartExamined: extract('x00180015'),
      institutionName: extract('x00080080'),
      seriesDescription: extract('x0008103e'),
      imagePosition: extract('x00200032'),
      imageOrientation: extract('x00200037'),
      sliceThickness: extract('x00180050'),
      pixelSpacing: extract('x00280030'),
      rows: dataSet.uint16('x00280010'),
      cols: dataSet.uint16('x00280011'),
      bitsAllocated: dataSet.uint16('x00280100'),
      numberOfFrames: dataSet.intString('x00280008') || '1',
      isDicom: true,
    };

    // Try to extract pixel data as JPEG (most modern DICOM uses JPEG compression)
    let imageBase64 = null;
    try {
      const pixelDataElement = dataSet.elements.x7fe00010;
      if (pixelDataElement) {
        const pixelData = new Uint8Array(buf.buffer, pixelDataElement.dataOffset, pixelDataElement.length);
        // Check if it's encapsulated (JPEG)
        if (pixelDataElement.encapsulatedPixelData) {
          // Extract first frame
          const frames = pixelDataElement.basicOffsetTable?.length ? 
            pixelDataElement.basicOffsetTable : [0];
          const frameStart = frames[0];
          const frameEnd = frames[1] || pixelData.length;
          imageBase64 = Buffer.from(pixelData.slice(frameStart, frameEnd)).toString('base64');
        } else {
          // Raw pixel data — convert to PNG via simple raw-to-image
          const { rows, cols } = metadata;
          if (rows && cols && rows < 4096 && cols < 4096) {
            imageBase64 = rawPixelsToPNG(pixelData, rows, cols, metadata.bitsAllocated || 16);
          }
        }
      }
    } catch (pixelErr) {
      console.log('   DICOM pixel extract failed:', pixelErr.message);
    }

    return { success: true, metadata, imageBase64 };
  } catch (e) {
    return { success: false, error: e.message, metadata: { isDicom: false } };
  }
}

function rawPixelsToPNG(pixelData, rows, cols, bitsAllocated) {
  // NOTE: Proper DICOM-to-PNG conversion requires a full toolkit (e.g. dcmtk, pydicom+ Pillow).
  // This local workstation does not include a DICOM renderer. Return null so the caller
  // falls back to raw bytes (vision models will not be able to read it).
  console.log('   DICOM raw pixel extraction not supported locally — convert to JPG/PNG first');
  return null;
}

app.post('/api/dicom/parse', upload.single('dicom'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No DICOM file uploaded' });
    const result = parseDicomHeader(req.file.path);
    fs.unlink(req.file.path, () => {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════ MODEL WARM-UP ═══════════════════
async function warmModels() {
  if (CONFIG.provider === 'kimi') {
    console.log('🔥 Kimi K2.6 API — no model warm-up needed (serverless)');
    return;
  }
  console.log('🔥 Warming essential models (4GB VRAM budget)...');
  const models = [
    { name: CONFIG.embedModel, type: 'embed', warm: async () => ollamaEmbed(CONFIG.embedModel, 'warmup') },
    // llava:13b kept warm — critical for RX/image analysis
    { name: CONFIG.visionModel, type: 'vision', warm: async () => ollamaChat(CONFIG.visionModel, [{role:'user',content:'Describe this image in one word: warmup'}], 60000) },
    // deepseek-r1:7b loaded on demand (cold start ~30s) — no warm-up to save VRAM
  ];

  for (const m of models) {
    try {
      const start = Date.now();
      await m.warm();
      console.log(`   ✅ ${m.name} — ${((Date.now()-start)/1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`   ⚠️ ${m.name} — ${e.message?.slice(0,50)}`);
    }
  }
  console.log('🔥 All models warmed and kept in VRAM for ' + CONFIG.keepAlive + '\n');
}

app.get('/api/models/warm', async (req, res) => {
  res.json({ status: 'warming', keep_alive: CONFIG.keepAlive });
  warmModels().catch(e => console.error('Warm failed:', e.message));
});

// ═══════════════════ ICD-10 / CPT AUTO-CODING ═══════════════════
app.post('/api/coding/suggest', async (req, res) => {
  try {
    const { report_text, exam_type, body_region, findings_summary } = req.body;
    if (!report_text && !findings_summary) return res.status(400).json({ error: 'Need report text or findings' });

    const searchText = (report_text + ' ' + (findings_summary || '')).toLowerCase();
    const keywords = extractKeywords(searchText);

    // Search ICD-10 codes by keyword matching
    let icdResults = [];
    for (const kw of keywords.slice(0, 5)) {
      const { rows } = await pool.query(
        `SELECT code, description, category FROM icd10_codes 
         WHERE doctor_id = $1 AND (LOWER(description) LIKE $2 OR LOWER(code) LIKE $2)
         LIMIT 3`, [2, `%${kw}%`]
      );
      for (const r of rows) if (!icdResults.find(x => x.code === r.code)) icdResults.push(r);
    }

    // Search CPT codes by exam type
    const cptQuery = exam_type?.toLowerCase().includes('mri') ? 'mri' : exam_type?.toLowerCase().includes('x-ray') ? 'x-ray' : '';
    let cptResults = [];
    if (cptQuery) {
      const { rows } = await pool.query(
        `SELECT code, description, category, rvu FROM cpt_codes
         WHERE doctor_id = $1 AND LOWER(description) LIKE $2 LIMIT 5`, [2, `%${cptQuery}%`]
      );
      cptResults = rows;
    }

    // Also search ICD by body region
    if (body_region) {
      const { rows } = await pool.query(
        `SELECT code, description, category FROM icd10_codes
         WHERE doctor_id = $1 AND LOWER(description) LIKE $2 LIMIT 5`, [2, `%${body_region.toLowerCase()}%`]
      );
      for (const r of rows) if (!icdResults.find(x => x.code === r.code)) icdResults.push(r);
    }

    res.json({ success: true, icd10: icdResults.slice(0, 8), cpt: cptResults.slice(0, 5), keywords_used: keywords.slice(0, 5) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function extractKeywords(text) {
  const stopWords = new Set(['the','a','an','and','or','is','are','was','were','with','without','no','not','of','in','on','to','for','this','that','left','right','patient','image','quality']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
  const freq = {}; words.forEach(w => { freq[w] = (freq[w]||0)+1; });
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]).map(([w])=>w);
}


// ═══════════════════ AIMS AUTH INTEGRATION ═══════════════════
const AIMS_API = 'https://aimedicalscriber.com/api';

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const params = new URLSearchParams({ username, password });
    const aimsRes = await axios.post(`${AIMS_API}/login`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    const user = aimsRes.data;
    if (!user.token) return res.status(401).json({ error: 'Invalid credentials' });

    // Create a local session with AIMS user data
    const sess = createSession();
    sess.aimsUser = { id: user.id, username: user.username, name: user.name, role: user.role };
    sess.aimsToken = user.token;

    res.json({
      success: true,
      session_id: sess.id,
      user: { id: user.id, username: user.username, name: user.name, role: user.role },
    });
  } catch (e) {
    if (e.response?.status === 401) return res.status(401).json({ error: 'Invalid credentials' });
    res.status(502).json({ error: 'AIMS API unreachable. Continue in offline mode.', offline: true });
  }
});

app.get('/api/auth/me', (req, res) => {
  const sess = getSession(req.query.session_id);
  if (!sess?.aimsUser) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: sess.aimsUser });
});

// Auth middleware — optional, allows offline mode
function requireAuth(req, res, next) {
  const sess = getSession(req.body.session_id || req.query.session_id);
  if (!sess?.aimsUser) {
    return res.json({ warning: 'Not authenticated. Report will not be linked to a doctor.', offline: true });
  }
  req.aimsUser = sess.aimsUser;
  req.aimsToken = sess.aimsToken;
  next();
}

// ═══════════════════ P2.2: COMPARISON STUDIES ═══════════════════
app.post('/api/compare', upload.fields([
  { name: 'current_images', maxCount: 25 },
  { name: 'prior_images', maxCount: 25 }
]), async (req, res) => {
  try {
    const currentFiles = req.files?.current_images || [];
    const priorFiles = req.files?.prior_images || [];
    if (!currentFiles.length || !priorFiles.length) return res.status(400).json({ error: 'Upload both current and prior images' });
    if (!req.body.session_id) return res.status(400).json({ error: 'session_id required' });

    const sess = getSession(req.body.session_id);
    if (!sess) return res.status(404).json({ error: 'Session expired' });

    console.log(`\n📊 Comparison: ${currentFiles.length} current vs ${priorFiles.length} prior images`);

    // Analyze current images
    const currentBase64 = currentFiles.map(f => fs.readFileSync(f.path).toString('base64'));
    const priorBase64 = priorFiles.map(f => fs.readFileSync(f.path).toString('base64'));

    // Analyze current images quickly
    const currentPrompt = `You are a radiologist comparing imaging studies. 
Analyze this CURRENT image and describe key findings. Be concise — focus on what a radiologist would want to compare with a prior study.`;
    const priorPrompt = `You are a radiologist comparing imaging studies. 
Analyze this PRIOR image and describe key findings. Be concise — focus on what a radiologist would want to compare with a current study.`;
    
    const [currentFindings, priorFindings] = await Promise.all([
      aiVision(currentPrompt, currentBase64, 1),
      aiVision(priorPrompt, priorBase64, 1),
    ]);

    // Now run the comparison
    const comparisonPrompt = [
      { role: 'system', content: 'You are a radiologist comparing CURRENT vs PRIOR imaging studies. Identify: 1) Progression/regression of findings 2) New findings 3) Resolved findings 4) Stable findings. Be specific about changes.' },
      { role: 'user', content: `COMPARISON STUDY:\n\nCURRENT IMAGING FINDINGS:\n${currentFindings.map((f,i) => `IMAGE ${i+1}: ${f}`).join('\n\n')}\n\nPRIOR IMAGING FINDINGS:\n${priorFindings.map((f,i) => `IMAGE ${i+1}: ${f}`).join('\n\n')}\n\nPrescription: ${JSON.stringify(sess.prescription || {})}\n\nProvide a detailed comparison report.` }
    ];
    const comparison = await aiChat(comparisonPrompt);

    // Clean up
    [...currentFiles, ...priorFiles].forEach(f => fs.unlink(f.path, () => {}));

    sess.comparison = comparison;
    res.json({ success: true, current_images: currentFiles.length, prior_images: priorFiles.length, comparison });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ P2.3: MEASUREMENT EXTRACTION ═══════════════════
app.post('/api/measurements', async (req, res) => {
  try {
    const { session_id, image_index } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const sess = getSession(session_id);
    if (!sess?.findings?.length) return res.status(400).json({ error: 'No findings in session. Run image analysis first.' });

    const idx = image_index || 0;
    const finding = sess.findings[idx];
    if (!finding) return res.status(404).json({ error: 'Image not found' });

    console.log(`\n📏 Extracting measurements from image ${idx+1}`);

    const measurePrompt = [
      { role: 'system', content: 'You are a radiologist extracting QUANTITATIVE MEASUREMENTS from imaging reports. Extract all numerical values mentioned: sizes (mm/cm), angles (degrees), densities (HU), volumes (cc), distances, etc. Format as JSON.' },
      { role: 'user', content: `Extract all measurements from this radiology finding:\n\n${finding.analysis}\n\nReturn JSON: {"measurements":[{"name":"...","value":X,"unit":"...","location":"...","type":"size|angle|density|volume|distance"}]}` }
    ];
    const result = await aiChat(measurePrompt);
    
    let measurements = [];
    try {
      const json = result.match(/\{[\s\S]*\}/);
      if (json) measurements = JSON.parse(json[0]).measurements || [];
    } catch { measurements = [{ raw: result }]; }

    sess.measurements = measurements;
    res.json({ success: true, image_index: idx, measurements });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ P3.1: REPORT HISTORY — searchable archive ═══════════════════
app.get('/api/reports', async (req, res) => {
  try {
    const { search, patient, date_from, date_to, modality, limit = 20, offset = 0 } = req.query;
    let query = `SELECT id, patient_id, report_data, report_type, file_name, analysis, created_at FROM lab_reports WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (search) { query += ` AND (LOWER(report_data) LIKE $${paramIdx} OR LOWER(file_name) LIKE $${paramIdx})`; params.push(`%${search.toLowerCase()}%`); paramIdx++; }
    if (patient) { query += ` AND CAST(patient_id AS TEXT) = $${paramIdx}`; params.push(patient); paramIdx++; }
    if (date_from) { query += ` AND created_at >= $${paramIdx}`; params.push(date_from); paramIdx++; }
    if (date_to) { query += ` AND created_at <= $${paramIdx}`; params.push(date_to); paramIdx++; }
    if (modality) { query += ` AND LOWER(file_name) LIKE $${paramIdx}`; params.push(`%${modality.toLowerCase()}%`); paramIdx++; }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx+1}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await pool.query(query, params);

    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) FROM lab_reports WHERE 1=1`;
    const countParams = [];
    let countIdx = 1;
    if (search) { countQuery += ` AND (LOWER(report_data) LIKE $${countIdx} OR LOWER(file_name) LIKE $${countIdx})`; countParams.push(`%${search.toLowerCase()}%`); countIdx++; }
    const { rows: countRows } = await pool.query(countQuery, countParams);

    res.json({ success: true, reports: rows, total: parseInt(countRows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(DISTINCT DATE(created_at)) as days_active,
        MIN(created_at) as first_report,
        MAX(created_at) as last_report
      FROM lab_reports
    `);
    const { rows: byDay } = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM lab_reports
      GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 14
    `);
    res.json({ success: true, stats: rows[0], daily: byDay });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════ P3.2: PDF EXPORT ═══════════════════
app.get('/api/reports/:id/pdf', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM lab_reports WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const report = rows[0];

    // Generate HTML for PDF
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:Georgia,serif;font-size:12pt;line-height:1.6;padding:40px;max-width:700px;margin:auto}
h1{font-size:18pt;text-align:center;margin-bottom:4pt}h2{font-size:13pt;border-bottom:1px solid #999;padding-bottom:4pt;margin-top:16pt}
.meta{font-size:9pt;color:#666;border-bottom:1px solid #ccc;padding-bottom:8pt;margin-bottom:16pt}
.section{margin:12px 0;white-space:pre-wrap}.footer{margin-top:30pt;border-top:1px solid #ccc;padding-top:8pt;font-size:8pt;color:#999;text-align:center}
</style></head><body>
<h1>RADIOLOGY REPORT</h1>
<div class="meta">Report ID: ${report.id} | Generated: ${new Date(report.created_at).toLocaleString()} | Type: ${report.file_name || 'N/A'}</div>
<div class="section">${(report.report_data||'').replace(/\n/g,'<br>')}</div>
<div class="footer">Generated by AIMS VISION PRO — This is an AI-assisted report. Physician review required.</div>
</body></html>`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="radiology-report-${report.id}.pdf"`);
    res.send(html); // Browser will render HTML; for true PDF, use puppeteer in production
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ P3.3: TELEMEDICINE PUSH ═══════════════════
app.post('/api/push/telemedicine', async (req, res) => {
  try {
    const { session_id, aims_token } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    
    const sess = getSession(session_id);
    if (!sess?.note) return res.status(400).json({ error: 'No report generated yet' });

    const aimsToken = aims_token || sess.aimsToken;
    const payload = {
      report_id: `AIMS-VP-${Date.now()}`,
      patient_id: sess.prescription?.patient_id || null,
      exam_type: sess.prescription?.exam_type,
      body_region: sess.prescription?.body_region,
      report: sess.note,
      correlation: sess.correlation?.slice(0, 500),
      generated_at: new Date().toISOString(),
    };

    // Try pushing to AIMS telemedicine endpoint
    try {
      if (aimsToken) {
        await axios.post('https://aimedicalscriber.com/api/telemedicine/push', payload, {
          headers: { 'Authorization': `Bearer ${aimsToken}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        sess.telemedicine_push = 'success';
        return res.json({ success: true, pushed_to: 'AIMS Telemedicine', report_id: payload.report_id });
      }
    } catch (apiErr) {
      console.log('AIMS push failed (may not have endpoint yet):', apiErr.message);
    }

    // Local push — save as shareable JSON
    sess.telemedicine_push = 'local';
    res.json({ success: true, pushed_to: 'local', payload, note: 'AIMS telemedicine endpoint not available — report saved locally' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ REPORT HISTORY ═══════════════════
app.get('/api/reports/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM lab_reports WHERE id = $1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true, report: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ SEED DATA ═══════════════════
app.post('/api/seed', async (req, res) => {
  try {
    // Seed ICD-10 codes
    await pool.query(`INSERT INTO icd10_codes (doctor_id, code, description, category) VALUES
      (2, 'M23.91', 'Unspecified derangement of unspecified meniscus', 'MSK'),
      (2, 'S83.209A', 'Unspecified tear of unspecified meniscus, initial encounter', 'MSK'),
      (2, 'J18.9', 'Pneumonia, unspecified organism', 'Pulmonary'),
      (2, 'M25.561', 'Pain in right knee', 'MSK'),
      (2, 'M25.562', 'Pain in left knee', 'MSK')
    ON CONFLICT DO NOTHING`);

    // Seed CPT codes
    await pool.query(`INSERT INTO cpt_codes (doctor_id, code, description, category, rvu) VALUES
      (2, '73721', 'MRI lower extremity without contrast', 'Radiology', 2.15),
      (2, '71020', 'Chest X-ray, 2 views', 'Radiology', 0.45),
      (2, '71021', 'Chest X-ray, 2 views with apical lordotic', 'Radiology', 0.55),
      (2, '73718', 'MRI lower extremity without/with contrast', 'Radiology', 2.85),
      (2, '73060', 'X-ray knee, 2 views', 'Radiology', 0.35)
    ON CONFLICT DO NOTHING`);

    // Seed lab reports
    await pool.query(`INSERT INTO lab_reports (patient_id, doctor_id, report_type, report_data, file_name, analysis, recommendations) VALUES
      (1, 2, 'MRI', 'MRI Left Knee — Medial meniscus tear, Grade 3. Mild joint effusion. No ligamentous injury.', 'knee_mri_demo.pdf', 'Medial meniscus tear, Grade 3. Mild joint effusion.', 'Orthopedic consult, consider arthroscopy.'),
      (2, 2, 'X-Ray', 'Chest X-Ray — Right lower lobe consolidation consistent with pneumonia. No pleural effusion.', 'chest_xray_demo.pdf', 'Right lower lobe consolidation consistent with pneumonia.', 'Continue antibiotics, follow-up CXR in 48-72h.')
    ON CONFLICT DO NOTHING`);

    // Seed medical knowledge for RAG
    await pool.query(`INSERT INTO medical_knowledge_chunks (title, content, category, source, metadata) VALUES
      ('ACR Knee MRI Appropriateness', 'MRI is usually appropriate for acute knee trauma with suspected meniscal or ligamentous injury. X-ray is usually appropriate as initial study.', 'acr_criteria_msk', 'ACR', '{"topic":"knee","modality":"mri"}'),
      ('Pneumonia Imaging Guidelines', 'Chest X-ray is first-line for suspected pneumonia. CT chest is usually appropriate for complicated cases or unclear diagnosis.', 'acr_criteria_pulmonary', 'ACR', '{"topic":"pneumonia","modality":"xray"}'),
      ('Meniscal Tear Grading', 'Grade 1: Intrameniscal signal. Grade 2: Linear signal not reaching surface. Grade 3: Signal reaching articular surface = tear.', 'radiology_reference', 'Radiopaedia', '{"topic":"meniscus","anatomy":"knee"}'),
      ('Lobar Pneumonia CXR Findings', 'Airspace opacification, air bronchograms, lobar consolidation. Right lower lobe commonly affected. Silhouette sign with right hemidiaphragm.', 'radiology_reference', 'Radiopaedia', '{"topic":"pneumonia","anatomy":"chest"}')
    ON CONFLICT DO NOTHING`);

    res.json({ success: true, message: 'Seed data inserted', tables: ['icd10_codes', 'cpt_codes', 'lab_reports', 'medical_knowledge_chunks'] });
  } catch (e) {
    console.error('Seed failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════ PGVECTOR CHECK ═══════════════════
app.get('/api/admin/pgvector-check', async (req, res) => {
  try {
    const { rows: ext } = await pool.query("SELECT * FROM pg_extension WHERE extname = 'vector'");
    const hasVector = ext.length > 0;
    let knowledgeCount = 0;
    try {
      const { rows } = await pool.query('SELECT COUNT(*) FROM medical_knowledge_chunks');
      knowledgeCount = parseInt(rows[0].count);
    } catch {}
    res.json({
      success: true,
      pgvector: hasVector,
      pgvector_version: hasVector ? ext[0].extversion : null,
      medical_knowledge_chunks: knowledgeCount,
      rag_ready: hasVector && knowledgeCount > 0,
      message: hasVector ? 'pgvector enabled — RAG search available' : 'pgvector NOT enabled — run CREATE EXTENSION vector in Supabase SQL Editor'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════ SESSION MANAGEMENT ═══════════════════
app.get('/api/admin/sessions', (req, res) => {
  const now = Date.now();
  const all = Object.values(sessions).map(s => ({
    id: s.id,
    created: new Date(s.created).toISOString(),
    age_min: Math.round((now - s.created) / 60000),
    has_prescription: !!s.prescription,
    has_findings: !!s.findings?.length,
    has_note: !!s.note,
  }));
  res.json({ success: true, count: all.length, sessions: all });
});

app.delete('/api/admin/sessions/:id', (req, res) => {
  delete sessions[req.params.id];
  res.json({ success: true });
});

app.delete('/api/admin/sessions', (req, res) => {
  const count = Object.keys(sessions).length;
  for (const k of Object.keys(sessions)) delete sessions[k];
  res.json({ success: true, cleared: count });
});

// ═══════════════════ START ═══════════════════
app.listen(PORT, async () => {
  await ensureSchema();
  console.log(`\n🧠 AIMS VISION PRO — Radiologist Workstation`);
  console.log(`   http://localhost:${PORT}`);
  if (CONFIG.provider === 'kimi') {
    console.log(`   🤖 Provider: KIMI K2.6 | Model: ${CONFIG.kimiModel} | Vision: ${CONFIG.kimiVisionModel}`);
  } else {
    console.log(`   Vision: ${CONFIG.visionModel} | Chat: ${CONFIG.chatModel} | Embed: ${CONFIG.embedModel}`);
  }
  console.log(`   Workflow: Prescription → Multi-Image → Correlation → Medical Note`);
  console.log(`   Keep-Alive: ${CONFIG.keepAlive} — models stay in VRAM\n`);
  // Auto-warm models on startup (non-blocking, runs in background)
  warmModels().catch(e => console.error('Warm-up error:', e.message));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\nSIGTERM received, closing DB pool...');
  await pool.end();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('\nSIGINT received, closing DB pool...');
  await pool.end();
  process.exit(0);
});
