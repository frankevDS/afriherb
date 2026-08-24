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

    // Step 1: Fetch live model list from Groq so we always use current active models
    // This future-proofs the app — no more hard-coding deprecated model names
    let activeModels = [];
    try {
      const modelsResp = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }
      });
      const modelsData = await modelsResp.json();
      if (modelsData.data && Array.isArray(modelsData.data)) {
        // Filter to text-generation models only, prefer larger/faster ones
        const preferred = [
          'openai/gpt-oss-120b',
          'qwen/qwen3.6-27b',
          'openai/gpt-oss-20b',
          'gemma2-9b-it',
          'qwen-qwq-32b',
        ];
        // Use preferred models that exist in the live list
        const liveIds = modelsData.data.map(m => m.id);
        activeModels = preferred.filter(m => liveIds.includes(m));
        // Add any remaining live models as extra fallback (exclude whisper/vision/embed)
        const extra = liveIds.filter(id =>
          !activeModels.includes(id) &&
          !id.includes('whisper') &&
          !id.includes('vision') &&
          !id.includes('embed') &&
          !id.includes('guard') &&
          !id.includes('tool-use')
        );
        activeModels = [...activeModels, ...extra.slice(0, 3)];
      }
    } catch (e) {
      // If model fetch fails, fall back to known current models
      activeModels = [
        'openai/gpt-oss-120b',
        'qwen/qwen3.6-27b',
        'openai/gpt-oss-20b',
        'gemma2-9b-it',
      ];
    }

    if (activeModels.length === 0) {
      activeModels = ['openai/gpt-oss-20b', 'qwen/qwen3.6-27b'];
    }

    let lastError = null;

    for (const model of activeModels) {
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
                content: systemPrompt + '\n\nReturn a single valid JSON object only. No markdown. No extra text.'
              },
              {
                role: 'user',
                content: userMessage
              }
            ]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          const errMsg = data.error?.message || '';
          const isRetryable =
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

          if (isRetryable) {
            lastError = `${model}: ${errMsg.slice(0, 120)}`;
            // Small delay before trying next model if rate limited
            if (response.status === 429) {
              await new Promise(r => setTimeout(r, 1000));
            }
            continue;
          }

          // Auth error — return immediately
          return res.status(response.status).json({
            error: data.error?.message || 'Groq API error',
            hint: response.status === 401
              ? 'Your GROQ_API_KEY is invalid or expired. Go to console.groq.com → API Keys → create a new key → update in Vercel → Redeploy.'
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

    // All models failed — give a clear user-friendly message
    return res.status(503).json({
      error: 'The AI service is temporarily busy. Please wait 1 minute and try again.',
      technical: lastError
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
