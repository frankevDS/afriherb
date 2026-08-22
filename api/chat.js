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

    // Models ordered by: token limit (largest first), then quality, then fallback
    // All verified available on Groq free tier as of June 2026
    const MODELS = [
      { id: 'llama-3.1-8b-instant',     tpm: 20000 },  // High TPM, reliable free tier
      { id: 'llama3-groq-70b-8192-tool-use-preview', tpm: 15000 },
      { id: 'gemma2-9b-it',             tpm: 15000 },  // Google Gemma — stable free tier
      { id: 'qwen/qwen3.6-27b',         tpm: 12000 },  // Qwen — good quality
      { id: 'openai/gpt-oss-20b',       tpm: 10000 },  // Lighter OpenAI OSS
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
            model: model.id,
            temperature: 0.4,
            max_tokens: 3500,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: systemPrompt + '\n\nIMPORTANT: Return a single valid JSON object only. No markdown. No extra text.'
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
          const shouldTryNext =
            errMsg.toLowerCase().includes('does not exist') ||
            errMsg.toLowerCase().includes('decommissioned') ||
            errMsg.toLowerCase().includes('deprecated') ||
            errMsg.toLowerCase().includes('no longer supported') ||
            errMsg.toLowerCase().includes('not found') ||
            errMsg.toLowerCase().includes('too large') ||
            errMsg.toLowerCase().includes('token') ||
            errMsg.toLowerCase().includes('tpm') ||
            errMsg.toLowerCase().includes('rate limit') ||
            response.status === 404 ||
            response.status === 400 ||
            response.status === 429;

          if (shouldTryNext) {
            lastError = `${model.id}: ${errMsg}`;
            continue;
          }

          // Auth error — no point retrying
          return res.status(response.status).json({
            error: data.error?.message || 'Groq API error',
            hint: response.status === 401
              ? 'Your GROQ_API_KEY is invalid or expired. Go to console.groq.com → API Keys → Create new key → Update in Vercel → Redeploy.'
              : undefined
          });
        }

        const text = data.choices?.[0]?.message?.content || '';
        return res.status(200).json({ text, model_used: model.id });

      } catch (modelErr) {
        lastError = `${model.id}: ${modelErr.message}`;
        continue;
      }
    }

    return res.status(503).json({
      error: `All models unavailable. Last error: ${lastError}. Please try again in a minute.`
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
