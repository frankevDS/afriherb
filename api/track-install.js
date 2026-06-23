export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const NAMESPACE = 'afriherb-frankev';
  const KEY = 'confirmed-installs';

  try {
    if (req.method === 'POST') {
      const response = await fetch(`https://api.countapi.xyz/hit/${NAMESPACE}/${KEY}`);
      const data = await response.json();
      return res.status(200).json({ count: data.value });
    }

    if (req.method === 'GET') {
      const response = await fetch(`https://api.countapi.xyz/get/${NAMESPACE}/${KEY}`);
      const data = await response.json();
      return res.status(200).json({ count: data.value || 0 });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not update install count', message: err.message });
  }
}
