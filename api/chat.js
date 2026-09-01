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

    // Step 1: Get live model list from Groq so we never use a deprecated model
    let modelIds = [];
    try {
      const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }
      });
      if (modelsRes.ok) {
        const modelsJson = await modelsRes.json();
        // Filter to text generation models only — exclude audio, vision, guard, embed
        modelIds = (modelsJson.data || [])
          .map(m => m.id)
          .filter(id =>
            !id.includes('whisper') &&
            !id.includes('guard') &&
            !id.includes('safeguard') &&
            !id.includes('embed') &&
            !id.includes('vision') &&
            !id.includes('orpheus') &&
            !id.includes('tts') &&
            !id.includes('ocr')
          );
      }
    } catch (e) {}

    // Step 2: Prioritise best models, fall back to any available text model
    const preferred = [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.6-27b',
      'qwen/qwen3.8-27b',
    ];

    // Put preferred models first if they exist in live list, then add rest
    const ordered = [
      ...preferred.filter(m => modelIds.includes(m)),
      ...modelIds.filter(m => !preferred.includes(m))
    ];

    // If live list failed, use hardcoded fallback
    const MODELS = ordered.length > 0 ? ordered : [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.6-27b',
    ];

    const fullSystem = systemPrompt + '\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.';

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
          const errMsg = data.error?.message || '';
          const errLow = errMsg.toLowerCase();

          // These errors mean: skip this model and try the next one
          if (
            errLow.includes('decommission') ||
            errLow.includes('deprecated') ||
            errLow.includes('not exist') ||
            errLow.includes('not found') ||
            errLow.includes('too large') ||
            errLow.includes('tpm') ||
            errLow.includes('rate limit') ||
            errLow.includes('token') ||
            errLow.includes('validate') ||
            errLow.includes('json') ||
            errLow.includes('permission') ||
            errLow.includes('access') ||
            response.status === 404 ||
            response.status === 400 ||
            response.status === 429 ||
            response.status === 403
          ) {
            lastError = errMsg.slice(0, 120);
            if (response.status === 429) {
              await new Promise(r => setTimeout(r, 3000));
            }
            continue;
          }

          // Auth error — no point retrying
          if (response.status === 401) {
            return res.status(401).json({
              error: 'API key rejected. Go to console.groq.com → API Keys → create a new key → update GROQ_API_KEY in Vercel → Redeploy.'
            });
          }

          lastError = errMsg.slice(0, 120);
          continue;
        }

        const text = data.choices?.[0]?.message?.content || '';
        if (!text) {
          lastError = `${model}: empty response`;
          continue;
        }

        return res.status(200).json({ text, model_used: model });

      } catch (e) {
        lastError = `${model}: ${e.message}`;
        continue;
      }
    }

    // All models failed — give a clear message
    return res.status(503).json({
      error: 'AI temporarily unavailable. Please wait 1 minute and try again.',
      debug: lastError
    });

  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
}
