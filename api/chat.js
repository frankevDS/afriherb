export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { systemPrompt, userMessage } = req.body;

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: 'GROQ_API_KEY is not set. Go to Vercel → Settings → Environment Variables → add GROQ_API_KEY → Redeploy.'
      });
    }

    // Fetch live model list from Groq so we always use currently active models
    // This prevents failures when Groq deprecates models
    let MODELS = [];
    try {
      const modelsResp = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }
      });
      if (modelsResp.ok) {
        const modelsData = await modelsResp.json();
        const liveIds = (modelsData.data || []).map(m => m.id);

        // Preferred models in quality order — filter to only live ones
        const preferred = [
          'qwen/qwen3.6-27b',
          'openai/gpt-oss-120b',
          'openai/gpt-oss-20b',
          'gemma2-9b-it',
          'qwen-qwq-32b',
          'llama-3.1-8b-instant',
        ];
        MODELS = preferred.filter(m => liveIds.includes(m));

        // Add any other live text models as extra fallbacks
        const extras = liveIds.filter(id =>
          !MODELS.includes(id) &&
          !id.includes('whisper') &&
          !id.includes('vision') &&
          !id.includes('embed') &&
          !id.includes('guard')
        );
        MODELS = [...MODELS, ...extras.slice(0, 3)];
      }
    } catch(e) {}

    // Hardcoded fallback if live list fetch failed
    if (MODELS.length === 0) {
      MODELS = [
        'qwen/qwen3.6-27b',
        'openai/gpt-oss-20b',
        'gemma2-9b-it',
        'llama-3.1-8b-instant',
      ];
    }

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
            temperature: 0.4,
            max_tokens: 3000,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: systemPrompt + '\n\nReturn a single valid JSON object only. No markdown. No extra text before or after the JSON.'
              },
              { role: 'user', content: userMessage }
            ]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          const errMsg = data.error?.message || '';
          const tryNext =
            errMsg.toLowerCase().includes('decommissioned') ||
            errMsg.toLowerCase().includes('deprecated') ||
            errMsg.toLowerCase().includes('no longer supported') ||
            errMsg.toLowerCase().includes('does not exist') ||
            errMsg.toLowerCase().includes('not found') ||
            errMsg.toLowerCase().includes('too large') ||
            errMsg.toLowerCase().includes('tpm') ||
            errMsg.toLowerCase().includes('rate limit') ||
            errMsg.toLowerCase().includes('token') ||
            response.status === 404 ||
            response.status === 400 ||
            response.status === 429;

          if (tryNext) {
            lastError = `${model}: ${errMsg.slice(0, 100)}`;
            if (response.status === 429) {
              await new Promise(r => setTimeout(r, 1000));
            }
            continue;
          }

          return res.status(response.status).json({
            error: data.error?.message || 'API error',
            hint: response.status === 401
              ? 'Your GROQ_API_KEY is invalid or expired. Go to console.groq.com → API Keys → Create a new key → Update in Vercel → Redeploy.'
              : undefined
          });
        }

        const text = data.choices?.[0]?.message?.content || '';
        return res.status(200).json({ text, model_used: model });

      } catch (modelErr) {
        lastError = `${model}: ${modelErr.message}`;
        continue;
      }
    }

    return res.status(503).json({
      error: 'The AI service is temporarily busy. Please wait 1 minute and try again.'
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
