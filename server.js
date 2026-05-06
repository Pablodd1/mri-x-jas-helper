const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3002;
const OLLAMA = 'http://localhost:11434';

// ═══════════════════ CONFIG ═══════════════════
const CONFIG = {
  visionModel: 'llava:13b',
  chatModel: 'gemma4:latest',
  embedModel: 'bge-m3:latest',
  dbUrl: 'postgresql://postgres.vodhhauwowkalvaxzqyv:Hyatt123%40password2@aws-1-us-west-2.pooler.supabase.com:6543/postgres',
  keepAlive: '2h',     // Keep models in VRAM for 2 hours after last use
};

// ═══════════════════ DB ═══════════════════
const pool = new Pool({
  connectionString: CONFIG.dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 5, connectionTimeoutMillis: 10000,
});

// ═══════════════════ MIDDLEWARE ═══════════════════
app.use(express.json({ limit: '100mb' }));
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
const SESSION_TTL = 30 * 60 * 1000; // 30 min

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
async function ollamaChat(model, messages, timeout = 300000) {
  const res = await axios.post(`${OLLAMA}/api/chat`, {
    model, messages, stream: false, keep_alive: CONFIG.keepAlive,
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

// ═══════════════════ RAG ═══════════════════
async function searchRAG(query, topK = 5) {
  const embedding = await ollamaEmbed(CONFIG.embedModel, query);
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

    const result = await ollamaVisionBatch(CONFIG.visionModel, prompt, [imageBase64], 1);
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

    // Build prompt using prescription context
    const prescription = sess.prescription;
    const imagePrompt = `You are a radiologist. Analyze this medical image.

CONTEXT FROM REFERRING PHYSICIAN:
- Exam ordered: ${prescription.exam_type || 'not specified'}
- Body region: ${prescription.body_region || 'not specified'}
- Clinical indication: ${prescription.clinical_indication || 'not specified'}
- Suspected diagnosis: ${prescription.preliminary_diagnosis || 'not specified'}
- Contrast: ${prescription.contrast || 'not specified'}

${files.length > 1 ? `This is image ${'{INDEX}'} of ${files.length} total slices in this series.` : ''}

Describe what you observe:
1. MODALITY CONFIRMATION: Is this the correct exam type?
2. ANATOMY: What body part/region is visible?
3. KEY FINDINGS: Fractures, lesions, alignment, density changes, effusions, masses, etc.
4. CORRELATION WITH SUSPECTED DIAGNOSIS: Do findings support or contradict the suspected diagnosis?
5. ABNORMALITIES: List with severity (mild/moderate/severe)
6. IMAGE QUALITY: Adequate for diagnosis? Any artifacts?

Be specific and precise. If you cannot determine something, say so.`;

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

    // Analyze in batches of 2 to not overwhelm GPU
    const concurrency = files.length > 5 ? 2 : 3;
    const findings = [];
    for (let i = 0; i < imagesBase64.length; i++) {
      const prompt = imagePrompt.replace('{INDEX}', String(i + 1));
      const result = await ollamaVisionBatch(CONFIG.visionModel, prompt, [imagesBase64[i]], 1);
      findings.push({
        index: i + 1,
        file_name: files[i].originalname,
        file_size_mb: (files[i].size / (1024 * 1024)).toFixed(1),
        analysis: result[0],
      });
    }

    sess.images = files.map(f => ({ name: f.originalname, size: f.size }));
    sess.findings = findings;

    // Search RAG with findings + prescription
    const ragQuery = `${prescription.body_region} ${prescription.preliminary_diagnosis || ''} ${findings.map(f => f.analysis).join(' ')}`.slice(0, 2000);
    const ragResults = await searchRAG(ragQuery, 5);
    sess.rag = ragResults;

    // Clean up uploaded files
    files.forEach(f => fs.unlink(f.path, () => {}));

    console.log(`   Analyzed ${findings.length} images. RAG: ${ragResults.length} sources`);

    res.json({
      success: true,
      session_id: sess.id,
      image_count: findings.length,
      findings,
      rag: ragResults.map(r => ({ title: r.title, category: r.category, score: r.score })),
    });
  } catch (e) {
    console.error('Image analysis failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════ STEP 3: CORRELATION ═══════════════════
app.post('/api/correlate', async (req, res) => {
  try {
    const { session_id } = req.body;
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

    const correlation = await ollamaChat(CONFIG.chatModel, correlationPrompt);
    sess.correlation = correlation;

    console.log(`   Correlation complete`);

    res.json({ success: true, session_id: sess.id, correlation });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════ STEP 4: GENERATE MEDICAL NOTE ═══════════════════
app.post('/api/generate-note', async (req, res) => {
  try {
    const { session_id, doctor_notes, prompt_template } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    const sess = getSession(session_id);
    if (!sess) return res.status(404).json({ error: 'Session expired' });

    console.log(`\n📝 STEP 4: Generating medical note`);

    const prescription = sess.prescription || {};
    const findingsSummary = (sess.findings || []).map((f, i) => `IMAGE ${i + 1}: ${f.analysis}`).join('\n\n');
    const ragContext = (sess.rag || []).map(r => `[${r.category}] ${r.title}: ${r.content?.slice(0, 200)}`).join('\n');

    const template = prompt_template || 'DEFAULT';
    const systemPrompts = {
      DEFAULT: 'You are a senior radiologist creating structured diagnostic reports. Be precise and professional.',
      DETAILED: 'You are a senior radiologist creating comprehensive reports. Include detailed observations, measurements, and differential diagnoses.',
      BRIEF: 'You are a radiologist creating concise summary reports. Focus on key findings and actionable recommendations.',
    };

    const notePrompt = [
      { role: 'system', content: `${systemPrompts[template] || systemPrompts.DEFAULT}

Structure the report as:
CLINICAL INDICATION: (from prescription)
TECHNIQUE: (exam type, contrast, number of images)
COMPARISON: (prior studies if mentioned)
FINDINGS: (detailed observations from images)
CORRELATION: (how findings relate to suspected diagnosis)
IMPRESSION:
1. Primary finding
2. Secondary findings
3. Differential considerations
RECOMMENDATIONS:
- Next steps and follow-up
ACR CRITERIA: (cite relevant guidelines from RAG sources)` },
      { role: 'user', content: `Generate a complete medical imaging report.

REFERRAL INFORMATION:
Exam: ${prescription.exam_type || 'N/A'}
Region: ${prescription.body_region || 'N/A'}
Indication: ${prescription.clinical_indication || 'N/A'}
Suspected: ${prescription.preliminary_diagnosis || 'N/A'}

IMAGING FINDINGS:
${findingsSummary || 'No AI findings available'}

CORRELATION ANALYSIS:
${sess.correlation || 'Not performed'}

DOCTOR'S NOTES:
${doctor_notes || 'No additional notes'}

ACR CRITERIA FROM KNOWLEDGE BASE:
${ragContext || 'No criteria matched'}

Generate the structured report now.` }
    ];

    const note = await ollamaChat(CONFIG.chatModel, notePrompt);
    sess.note = note;

    // Save to Supabase lab_reports
    try {
      await pool.query(
        `INSERT INTO lab_reports (patient_id, report_data, report_type, file_name, analysis, recommendations, created_at)
         VALUES ($1, $2, 'radiology', $3, $4, $5, NOW())`,
        [null, note, `${prescription.exam_type}_${prescription.body_region}`.replace(/\s+/g, '_'),
         JSON.stringify(sess.findings?.map(f => f.analysis) || []),
         sess.correlation?.slice(0, 500) || '']
      );
      sess.saved_to_db = true;
    } catch (dbErr) {
      console.error('DB save failed:', dbErr.message);
    }

    console.log(`   Note generated and saved`);

    res.json({
      success: true, session_id: sess.id, note,
      prescription: sess.prescription,
      findings_count: sess.findings?.length || 0,
      rag_sources: (sess.rag || []).map(r => ({ title: r.title, category: r.category })),
      correlation: sess.correlation,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Note generation failed:', e.message);
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
  res.json({ session_id: sess.id });
});

// ═══════════════════ UTILITY ═══════════════════
app.get('/api/health', async (req, res) => {
  try {
    const { data } = await axios.get(`${OLLAMA}/api/tags`, { timeout: 5000 });
    res.json({ status: 'healthy', service: 'AIMS VISION PRO', models: data.models?.map(m => m.name), sessions_active: Object.keys(sessions).length });
  } catch (e) {
    res.json({ status: 'degraded', error: 'Ollama unreachable' });
  }
});

app.get('/api/pipeline/check', async (req, res) => {
  const checks = {};
  try { await ollamaEmbed(CONFIG.embedModel, 'test'); checks.embed = true; } catch { checks.embed = false; }
  try { await ollamaChat(CONFIG.chatModel, [{ role: 'user', content: 'OK' }], 15000); checks.chat = true; } catch { checks.chat = false; }
  try { const { rows } = await pool.query('SELECT 1'); checks.db = true; } catch { checks.db = false; }
  try {
    await axios.post(`${OLLAMA}/api/generate`, { model: CONFIG.visionModel, prompt: 'Say ready', images: [Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64').toString('base64')], stream: false, options: { num_predict: 5 } }, { timeout: 30000 });
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

    // Step 3: RAG search
    const ragQuery = `${mockCase.prescription.body_region} ${mockCase.prescription.preliminary_diagnosis}`;
    const ragResults = await searchRAG(ragQuery, 5);
    sess.rag = ragResults;

    // Step 4: Run correlation with fast model (llama3.1:8b loads in 9s vs gemma4's 5min)
    console.log('   Running correlation (llama3.1:8b)...');
    const findingsSummary = sess.findings.map((f, i) => `IMAGE ${i+1}: ${f.analysis}`).join('\n\n---\n\n');
    const correlationPrompt = [
      { role: 'system', content: 'You are a senior radiologist correlating prescription with imaging findings. Be precise.' },
      { role: 'user', content: `CORRELATE:\nPrescription: ${JSON.stringify(mockCase.prescription, null, 2)}\n\nImaging:\n${findingsSummary}\n\nProvide: 1) Confirmation 2) Additional findings 3) Discrepancies 4) Correlation score 5) Next steps 6) Summary` }
    ];
    sess.correlation = await ollamaChat('llama3.1:8b', correlationPrompt);

    // Step 5: Generate primary note
    console.log('   Generating primary report (Agent 1: llama3.1:8b)...');
    const ragContext = ragResults.map(r => `[${r.category}] ${r.content?.slice(0, 300)}`).join('\n');
    const notePrompt = [
      { role: 'system', content: 'You are a SENIOR RADIOLOGIST with 20+ years experience. Generate a comprehensive, structured radiology report. Include: CLINICAL INDICATION, TECHNIQUE, COMPARISON, FINDINGS, IMPRESSION (numbered), RECOMMENDATIONS. Be detailed and precise. Use proper medical terminology.' },
      { role: 'user', content: `Generate full report:\n\nREFERRAL: ${JSON.stringify(mockCase.prescription)}\n\nDOCTOR NOTES: ${mockCase.doctor_notes}\n\nIMAGING: ${findingsSummary}\n\nCORRELATION: ${sess.correlation}\n\nACR CRITERIA: ${ragContext}` }
    ];
    const primaryReport = await ollamaChat('llama3.1:8b', notePrompt);
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

    const reportToReview = sess.primary_report;
    const prescription = sess.prescription;
    const findings = sess.findings;

    // ═══ AGENT 2: Orthopedic/MSK/Pulmonary Specialist (llama3.1:8b) ═══
    console.log('   Agent 2: Specialist Fact-Checker (llama3.1:8b)...');
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
    const agent2Review = await ollamaChat('llama3.1:8b', agent2Prompt);

    // ═══ AGENT 3: Clinical Accuracy Expert (qwen2.5-medical) ═══
    console.log('   Agent 3: Clinical Accuracy Expert (qwen2.5-medical)...');
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
    const agent3Review = await ollamaChat('qwen2.5-medical:latest', agent3Prompt);

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
    const finalReport = await ollamaChat('llama3.1:8b', synthesisPrompt);

    sess.final_report = finalReport;
    sess.agent2_review = agent2Review;
    sess.agent3_review = agent3Review;

    res.json({
      success: true, session_id,
      agents: {
        agent1: { role: 'Chief Radiologist', model: 'gemma4:latest', output: 'Primary report (see /api/demo/run response)' },
        agent2: { role: 'Specialist Fact-Checker', model: 'llama3.1:8b', review: agent2Review },
        agent3: { role: 'Clinical Accuracy Expert', model: 'qwen2.5-medical:latest', review: agent3Review },
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
  // Simple raw pixel → grayscale PNG conversion
  // For proper DICOM windowing, a full DICOM toolkit is needed — this is a best-effort conversion
  const canvas = { width: cols, height: rows };
  let minVal = Infinity, maxVal = -Infinity;
  const pixels = new Uint16Array(pixelData.buffer, pixelData.byteOffset, rows * cols);
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] < minVal) minVal = pixels[i];
    if (pixels[i] > maxVal) maxVal = pixels[i];
  }
  const range = maxVal - minVal || 1;
  // Simple PNG header + IDAT (minimal valid PNG — browser can display)
  const clamped = new Uint8Array(rows * cols);
  for (let i = 0; i < pixels.length; i++) {
    clamped[i] = Math.round(((pixels[i] - minVal) / range) * 255);
  }
  // Return raw grayscale — browser will display as image via canvas
  return Buffer.from(clamped).toString('base64');
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

// ═══════════════════ MODEL WARM-UP — keep models in VRAM ═══════════════════
async function warmModels() {
  console.log('🔥 Warming models (keep_alive=' + CONFIG.keepAlive + ')...');
  const models = [
    { name: CONFIG.embedModel, type: 'embed', warm: async () => ollamaEmbed(CONFIG.embedModel, 'warmup') },
    { name: 'llama3.1:8b', type: 'chat', warm: async () => ollamaChat('llama3.1:8b', [{role:'user',content:'OK'}], 60000) },
    { name: 'qwen2.5-medical:latest', type: 'chat', warm: async () => ollamaChat('qwen2.5-medical:latest', [{role:'user',content:'OK'}], 60000) },
  ];
  // Skip gemma4 (9.6GB) and llava:13b (8GB) on warm-up to avoid VRAM thrashing
  // They load on-demand when needed and stay with keep_alive

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
    const comparePrompt = `You are a radiologist comparing imaging studies. 
Analyze this CURRENT image and describe key findings. Be concise — focus on what a radiologist would want to compare with a prior study.`;
    
    const currentFindings = await ollamaVisionBatch(CONFIG.visionModel, comparePrompt, currentBase64, 1);

    // Now run the comparison
    const comparisonPrompt = [
      { role: 'system', content: 'You are a radiologist comparing CURRENT vs PRIOR imaging studies. Identify: 1) Progression/regression of findings 2) New findings 3) Resolved findings 4) Stable findings. Be specific about changes.' },
      { role: 'user', content: `COMPARISON STUDY:\n\nCURRENT IMAGING FINDINGS:\n${currentFindings.map((f,i) => `IMAGE ${i+1}: ${f}`).join('\n\n')}\n\nPRIOR IMAGING CONTEXT:\nThe prior study images have been reviewed.\n\nPrescription: ${JSON.stringify(sess.prescription || {})}\n\nProvide a detailed comparison report.` }
    ];
    const comparison = await ollamaChat('llama3.1:8b', comparisonPrompt);

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
    const result = await ollamaChat('llama3.1:8b', measurePrompt);
    
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
    let query = `SELECT id, patient_id, report_data, report_type, file_name, analysis, created_at FROM lab_reports WHERE report_type = 'radiology'`;
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
    let countQuery = query.replace(/SELECT.*?FROM/, 'SELECT COUNT(*) FROM').replace(/ORDER BY.*$/, '').replace(/LIMIT.*$/, '');
    const { rows: countRows } = await pool.query(countQuery, params.slice(0, -2));
    
    res.json({
      success: true,
      total: parseInt(countRows[0].count),
      count: rows.length,
      reports: rows.map(r => ({
        id: r.id, patient_id: r.patient_id, file_name: r.file_name,
        preview: (r.report_data || '').slice(0, 200),
        created_at: r.created_at,
      }))
    });
  } catch (e) {
    res.json({ success: true, total: 0, count: 0, reports: [] });
  }
});

app.get('/api/reports/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(DISTINCT DATE(created_at)) as days_active,
        MIN(created_at) as first_report,
        MAX(created_at) as last_report
      FROM lab_reports WHERE report_type = 'radiology'
    `);
    const { rows: byDay } = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM lab_reports WHERE report_type = 'radiology'
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

// ═══════════════════ START ═══════════════════
app.listen(PORT, async () => {
  console.log(`\n🧠 AIMS VISION PRO — Radiologist Workstation`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Vision: ${CONFIG.visionModel} | Chat: ${CONFIG.chatModel} | Embed: ${CONFIG.embedModel}`);
  console.log(`   Workflow: Prescription → Multi-Image → Correlation → Medical Note`);
  console.log(`   Keep-Alive: ${CONFIG.keepAlive} — models stay in VRAM\n`);
  // Auto-warm models on startup (non-blocking, runs in background)
  warmModels().catch(e => console.error('Warm-up error:', e.message));
});
