const axios = require('axios');
require('dotenv').config({ path: '/home/jasme/mri-xray-local/.env' });

const KIMI_KEY = process.env.KIMI_API_KEY;
const KIMI_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';

async function test() {
  const messages = [
    { role: 'system', content: 'You are a senior radiologist. Be concise.' },
    { role: 'user', content: 'CORRELATE:\nExam: MRI — Right Knee\nIndication: 35yo male soccer player, acute knee injury, audible pop, swelling\n\nImaging Key Findings:\nIMAGE 1: Bucket-handle tear of medial meniscus with displaced fragment. ACL complete rupture. Large joint effusion.\nIMAGE 2: Confirms displaced bucket-handle meniscus fragment. ACL rupture confirmed.\nIMAGE 3: Displaced meniscus fragment visible adjacent to PCL. Patellofemoral joint normal.\n\nProvide concise: 1) Confirmation 2) Discrepancies 3) Correlation score 4) Next steps' }
  ];

  console.log('Sending to Kimi...');
  const t0 = Date.now();
  
  try {
    const res = await axios.post(`${KIMI_URL}/chat/completions`, {
      model: 'kimi-k2.6',
      messages,
      temperature: 1,
      max_tokens: 1500,
    }, {
      headers: { Authorization: `Bearer ${KIMI_KEY}`, 'Content-Type': 'application/json' },
      timeout: 120000,
    });

    const choice = res.data.choices?.[0];
    console.log(`Response in ${(Date.now()-t0)/1000}s`);
    console.log(`Finish: ${choice?.finish_reason}`);
    console.log(`Content type: ${typeof choice?.message?.content}`);
    console.log(`Content length: ${choice?.message?.content?.length || 0}`);
    console.log(`Content truthy: ${!!choice?.message?.content}`);
    console.log('---RAW CHOICE---');
    console.log(JSON.stringify(choice, null, 2).slice(0, 1000));
    console.log('---CONTENT---');
    console.log(choice?.message?.content?.slice(0, 500) || 'NO CONTENT');
  } catch(e) {
    console.error('ERROR:', e.message);
    if (e.response) {
      console.error('Status:', e.response.status);
      console.error('Body:', JSON.stringify(e.response.data).slice(0, 500));
    }
  }
}

test();
