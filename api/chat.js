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

    // Updated model list — June 2026 current active Groq models
    // Old models (llama-3.3-70b-versatile, llama3-8b-8192 etc.) were decommissioned
    // Source: https://console.groq.com/docs/deprecations
    const MODELS = [
      'openai/gpt-oss-120b',       // Groq's current recommended flagship — best quality
      'qwen/qwen3.6-27b',          // Strong alternative recommended by Groq
      'openai/gpt-oss-20b',        // Lighter, fast fallback
    ];

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
            max_tokens: 4000,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: systemPrompt + '\n\nCRITICAL: Your entire response must be a single valid JSON object only. No text before or after the JSON.'
              },
              {
                role: 'user',
                content: userMessage
              }
            ]
          })
        });

        const data = await response.json();

        // If this model is unavailable/deprecated, try the next one
        if (!response.ok) {
          const errMsg = data.error?.message || '';
          if (
            errMsg.toLowerCase().includes('does not exist') ||
            errMsg.toLowerCase().includes('decommissioned') ||
            errMsg.toLowerCase().includes('deprecated') ||
            errMsg.toLowerCase().includes('no longer supported') ||
            errMsg.toLowerCase().includes('not found') ||
            response.status === 404 ||
            response.status === 400
          ) {
            lastError = errMsg;
            continue; // try next model
          }
          // Auth or rate limit error — no point retrying different models
          return res.status(response.status).json({
            error: data.error?.message || 'Groq API error',
            hint: response.status === 401
              ? 'Your GROQ_API_KEY is invalid or expired. Go to console.groq.com → API Keys → Create new key → Update in Vercel Environment Variables → Redeploy.'
              : response.status === 429
              ? 'Free tier rate limit reached. Wait 1 minute and try again.'
              : undefined
          });
        }

        const text = data.choices?.[0]?.message?.content || '';
        return res.status(200).json({ text, model_used: model });

      } catch (modelErr) {
        lastError = modelErr.message;
        continue;
      }
    }

    return res.status(503).json({
      error: `AI service temporarily unavailable. Last error: ${lastError}. Please try again in a few minutes.`
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
