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

    // All models below are on Groq (not OpenAI) — your Groq API key is used for all of them.
    // Models with highest free-tier TPM limits are listed first.
    // llama-3.1-8b-instant: 20,000 TPM free — best fit for this prompt size
    // gemma2-9b-it: 15,000 TPM free — Google Gemma on Groq
    // llama-3.2-11b-text-preview: 7,000 TPM — medium fallback
    // llama-3.2-3b-preview: 7,000 TPM — light fallback
    const MODELS = [
      'llama-3.1-8b-instant',
      'gemma2-9b-it',
      'llama-3.2-11b-text-preview',
      'llama-3.2-3b-preview',
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
            max_tokens: 3500,
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
          const tryNext =
            errMsg.toLowerCase().includes('does not exist') ||
            errMsg.toLowerCase().includes('decommissioned') ||
            errMsg.toLowerCase().includes('deprecated') ||
            errMsg.toLowerCase().includes('no longer supported') ||
            errMsg.toLowerCase().includes('not found') ||
            errMsg.toLowerCase().includes('too large') ||
            errMsg.toLowerCase().includes('tpm') ||
            errMsg.toLowerCase().includes('rate limit') ||
            errMsg.toLowerCase().includes('token') ||
            response.status === 404 ||
            response.status === 400 ||
            response.status === 429;

          if (tryNext) {
            lastError = `${model}: ${errMsg}`;
            continue;
          }

          // Auth error — no point trying other models
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

    return res.status(503).json({
      error: `Service temporarily busy. Please wait 30 seconds and try again. (${lastError})`
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
