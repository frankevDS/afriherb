export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { systemPrompt, userMessage } = req.body;
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY not set.' });
    }

    let modelIds = [];
    try {
      const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }
      });
      if (modelsRes.ok) {
        const modelsJson = await modelsRes.json();
        modelIds = (modelsJson.data || []).map(m => m.id).filter(id =>
          !id.includes('whisper') && !id.includes('guard') &&
          !id.includes('safeguard') && !id.includes('embed') &&
          !id.includes('vision') && !id.includes('orpheus') &&
          !id.includes('tts') && !id.includes('ocr')
        );
      }
    } catch (e) {}

    const preferred = ['openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.6-27b'];
    const ordered = [
      ...preferred.filter(m => modelIds.includes(m)),
      ...modelIds.filter(m => !preferred.includes(m))
    ];
    const MODELS = ordered.length > 0 ? ordered : preferred;

    const fullSystem = systemPrompt + '\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown. No backticks. Start with { and end with }.';
    let lastError = null;

    for (const model of MODELS) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model,
            temperature: 0.3,
            max_completion_tokens: 4096,
            messages: [
              { role: 'system', content: fullSystem },
              { role: 'user', content: userMessage }
            ]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          const errLow = (data.error?.message || '').toLowerCase();
          if (response.status === 401) {
            return res.status(401).json({ error: 'API key rejected. Create a new key at console.groq.com and update in Vercel.' });
          }
          lastError = (data.error?.message || '').slice(0, 120);
          if (response.status === 429) await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        const text = data.choices?.[0]?.message?.content || '';
        if (!text) { lastError = `${model}: empty response`; continue; }
        return res.status(200).json({ text, model_used: model });

      } catch (e) {
        lastError = `${model}: ${e.message}`;
        continue;
      }
    }

    return res.status(503).json({
      error: 'AI temporarily unavailable. Please wait 1 minute and try again.',
      debug: lastError
    });

  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
}
