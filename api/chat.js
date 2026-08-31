export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { systemPrompt, userMessage } = req.body;

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY not set in Vercel environment variables.' });
    }

    const MODELS = [
      'openai/gpt-oss-120b',
      'qwen/qwen3.6-27b',
      'openai/gpt-oss-20b',
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
            max_tokens: 1000,
            messages: [
              {
                role: 'system',
                content: systemPrompt + '\n\nReturn a single valid JSON object only. No markdown fences. No extra text before or after the JSON.'
              },
              { role: 'user', content: userMessage }
            ]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          const msg = (data.error?.message || '').toLowerCase();
          const tryNext =
            msg.includes('decommission') || msg.includes('deprecated') ||
            msg.includes('not exist') || msg.includes('not found') ||
            msg.includes('too large') || msg.includes('tpm') ||
            msg.includes('rate limit') || msg.includes('token') ||
            msg.includes('json') || msg.includes('validate') ||
            response.status === 404 || response.status === 400 || response.status === 429;

          if (tryNext) {
            lastError = `${model}: ${data.error?.message?.slice(0, 80)}`;
            if (response.status === 429) await new Promise(r => setTimeout(r, 2000));
            continue;
          }

          return res.status(response.status).json({
            error: data.error?.message || 'API error',
            hint: response.status === 401
              ? 'API key invalid or expired. Go to console.groq.com → API Keys → create new key → update in Vercel → Redeploy.'
              : undefined
          });
        }

        const text = data.choices?.[0]?.message?.content || '';
        return res.status(200).json({ text, model_used: model });

      } catch (e) {
        lastError = `${model}: ${e.message}`;
        continue;
      }
    }

    return res.status(503).json({
      error: `All models temporarily unavailable. Please wait 1 minute and try again.`
    });

  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
}
