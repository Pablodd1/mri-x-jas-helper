const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3005;
const OLLAMA = 'http://localhost:11434';
const MODEL = 'llama3.1:8b'; // Single model for everything

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public-pip')));

// ═══════════ PIP MOCK CASES ═══════════
const PIP_CASES = {
  whiplash: {
    patient: 'Maria Gonzalez, 34F',
    accident: 'Rear-end collision, Miami FL, 14 days ago. Delta V ~12mph.',
    attorney: 'Goldberg & Associates, Claim #PI-2026-0487',
    prescription: {
      exam: 'Cervical Spine MRI',
      indication: 'Persistent neck pain, radiating to right arm, headaches, dizziness. Positive Spurling test. Restricted ROM — flexion 30°, extension 15°, rotation 45° bilaterally.',
      suspected: 'C4-C5 and C5-C6 disc herniations with radiculopathy. Rule out ligamentous injury.',
      chiropractor: 'Dr. James Chen, DC — Miami Spine & Injury Center',
    },
    findings: `CERVICAL SPINE MRI WITHOUT CONTRAST

C2-C3: Normal disc height and signal. No herniation. Facet joints unremarkable.
C3-C4: Mild disc desiccation. Shallow central disc bulge without cord compression.
C4-C5: Posterior central disc herniation measuring 4mm, effacing the ventral thecal sac. Mild right foraminal stenosis. Uncovertebral hypertrophy.
C5-C6: Large right paracentral disc herniation measuring 6mm with extrusion. Moderate to severe right foraminal stenosis. Compression of right C6 nerve root. Increased T2 signal in right paravertebral muscles consistent with acute strain.
C6-C7: Small central disc protrusion, 2mm. No stenosis.
C7-T1: Normal.

CRANIOCERVICAL JUNCTION: Loss of normal cervical lordosis — straightened curvature consistent with muscle spasm.
PREVERTEBRAL SOFT TISSUES: Mild edema anterior to C4-C5, consistent with recent trauma.
LIGAMENTS: Intact anterior and posterior longitudinal ligaments. Alar and transverse ligaments intact.
SPINAL CORD: Normal signal. No cord compression, edema, or myelomalacia.

IMPRESSION:
1. C5-C6 large right paracentral disc herniation with extrusion and right C6 radiculopathy — SURGICAL CANDIDATE
2. C4-C5 central disc herniation with mild right foraminal stenosis
3. Straightened cervical lordosis — muscular spasm pattern
4. Prevertebral edema at C4-C5 — acute traumatic etiology
5. Findings are consistent with acceleration-deceleration (whiplash) mechanism`,
    doctor_notes: 'Patient reports 7/10 pain constant, worse with computer work. Numbness right thumb/index finger. Failed 12 sessions chiropractic adjustment + PT. Considering epidural steroid injection C5-C6. Out of work 14 days. Attorney requesting impairment rating.',
  },
  lumbar_herniation: {
    patient: 'Robert Taylor, 45M',
    accident: 'T-bone collision, passenger side, Miami FL, 21 days ago.',
    attorney: 'Morgan & Morgan, Claim #PI-2026-0521',
    prescription: {
      exam: 'Lumbar Spine MRI',
      indication: 'Severe low back pain radiating to left leg with numbness and weakness. Positive straight leg raise at 30°. Diminished left Achilles reflex.',
      suspected: 'L4-L5 and L5-S1 disc herniations with left L5 and S1 radiculopathy.',
      chiropractor: 'Dr. Lisa Park, DC — Accident Recovery Chiropractic',
    },
    findings: `LUMBAR SPINE MRI WITHOUT CONTRAST

T12-L1 through L3-L4: Normal disc height and signal. No herniation or stenosis.

L4-L5: Large left paracentral disc extrusion measuring 8mm, extending inferiorly behind L5 vertebral body. Severe left lateral recess stenosis with compression of traversing left L5 nerve root. Facet arthropathy with mild hypertrophy. Disc desiccation with loss of T2 signal.

L5-S1: Broad-based disc bulge with superimposed left foraminal disc protrusion measuring 5mm. Moderate to severe left foraminal stenosis with compression of exiting left S1 nerve root. Modic type I endplate changes at inferior L5 and superior S1 — acute inflammatory response.

PARASPINAL MUSCLES: Increased T2 signal in left lumbar multifidus and erector spinae at L4-L5 and L5-S1 levels — acute Grade II strain.
SACROILIAC JOINTS: Mild left SI joint inflammation.

IMPRESSION:
1. L4-L5 large left paracentral disc extrusion with left L5 radiculopathy — severe
2. L5-S1 left foraminal disc protrusion with left S1 radiculopathy — moderate to severe
3. Modic type I changes at L5-S1 — acute traumatic etiology
4. Left paraspinal muscle strain Grade II
5. Findings consistent with high-energy side-impact mechanism`,
    doctor_notes: '8/10 pain. Numbness left lateral calf and foot dorsum. Weakness left ankle dorsiflexion 3/5. Using cane to ambulate. Out of work 21 days — construction worker. Will need vocational rehab. Considering microdiscectomy L4-L5. Attorney requesting permanent impairment rating per AMA Guides 6th Edition.',
  },
};

// ═══════════ AI CALL ═══════════
async function askLLM(messages) {
  const res = await axios.post(`${OLLAMA}/api/chat`, {
    model: MODEL, messages, stream: false,
    keep_alive: '4h', options: { temperature: 0.2, num_predict: 1024 }
  }, { timeout: 300000 });
  return res.data.message.content;
}

// ═══════════ PIP REPORT GENERATOR ═══════════
async function generatePIPReport(caseData) {
  const findings = typeof caseData.findings === 'string' ? caseData.findings : caseData.findings.join('\n\n');

  const report = await askLLM([
    { role: 'system', content: `You are a BOARD-CERTIFIED RADIOLOGIST specializing in personal injury and trauma imaging. You write reports for PI attorneys, PIP insurance, and chiropractic referral sources.

YOUR REPORT MUST INCLUDE:
1. CLINICAL HISTORY — accident mechanism, date, symptoms
2. TECHNIQUE — imaging modality and protocol
3. FINDINGS — detailed by level/structure
4. IMPRESSION — numbered, with severity
5. CAUSATION ANALYSIS — whether findings are consistent with the described accident mechanism (acute vs degenerative)
6. IMPAIRMENT GUIDANCE — per AMA Guides 6th Edition where applicable
7. TREATMENT RECOMMENDATIONS — including surgical vs conservative
8. PROGNOSIS — expected recovery timeline, permanent restrictions

Use language appropriate for legal and insurance review. Be specific about acute vs chronic findings. Distinguish pre-existing degenerative changes from acute traumatic injury.` },
    { role: 'user', content: `Generate a complete PIP radiology report.

PATIENT: ${caseData.patient}
ACCIDENT: ${caseData.accident}
ATTORNEY: ${caseData.attorney || 'N/A'}
REFERRING PROVIDER: ${caseData.prescription?.chiropractor || 'N/A'}
CLINICAL INDICATION: ${caseData.prescription?.indication || 'N/A'}

IMAGING FINDINGS:
${findings}

DOCTOR NOTES: ${caseData.doctor_notes || 'None'}

Generate the complete report with all 8 sections.` }
  ]);
  return report;
}

// ═══════════ API ═══════════
app.get('/api/cases', (req, res) => {
  res.json({ cases: Object.keys(PIP_CASES).map(k => ({ id: k, patient: PIP_CASES[k].patient, accident: PIP_CASES[k].accident })) });
});

app.post('/api/report', async (req, res) => {
  try {
    const { case_id } = req.body;
    const caseData = PIP_CASES[case_id];
    if (!caseData) return res.status(404).json({ error: 'Case not found. Use: ' + Object.keys(PIP_CASES).join(', ') });

    console.log(`\n📋 Generating PIP report: ${caseData.patient}`);
    const start = Date.now();
    const report = await generatePIPReport(caseData);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    res.json({ success: true, case_id, patient: caseData.patient, accident: caseData.accident, report, elapsed_seconds: elapsed, model: MODEL });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => {
  try {
    const { data } = await axios.get(`${OLLAMA}/api/tags`, { timeout: 3000 });
    res.json({ status: 'healthy', model: MODEL, available: !!data.models?.find(m => m.name === MODEL) });
  } catch { res.json({ status: 'healthy', model: MODEL, available: false }); }
});

app.get('/api/download/:case_id', async (req, res) => {
  const caseData = PIP_CASES[req.params.case_id];
  if (!caseData) return res.status(404).send('Not found');

  const report = await generatePIPReport(caseData);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>PIP Radiology Report</title>
<style>body{font:12pt Georgia;line-height:1.7;padding:48px;max-width:750px;margin:auto}h1{font-size:18pt;text-align:center;border-bottom:2px solid #333;padding-bottom:12pt}.meta{font-size:9pt;color:#666;margin:12pt 0}h2{font-size:11pt;text-transform:uppercase;border-bottom:1px solid #999;margin:16pt 0 6pt}.content{white-space:pre-wrap;font-size:11pt}.footer{margin-top:30pt;border-top:1px solid #ccc;padding-top:10pt;font-size:8pt;color:#999;text-align:center}</style></head><body>
<h1>RADIOLOGY REPORT — PERSONAL INJURY</h1>
<div class="meta">Patient: ${caseData.patient} | Accident: ${caseData.accident} | Attorney: ${caseData.attorney || 'N/A'}</div>
<div class="content">${report.replace(/\n/g,'<br>')}</div>
<div class="footer">Board Certified Radiologist — PIP/Personal Injury | Electronically signed</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="PIP-Report-${caseData.patient.split(',')[0].replace(/\s+/g,'-')}.html"`);
  res.send(html);
});

app.listen(PORT, () => {
  console.log(`\n🏥 PIP Radiology — http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL} | Cases: ${Object.keys(PIP_CASES).join(', ')}`);
  console.log(`   Ready for PI attorneys, chiropractors, and PIP claims\n`);
});
