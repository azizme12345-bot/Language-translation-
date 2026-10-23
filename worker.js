export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-gemini-api-key',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

    const url = new URL(request.url);
    const apiKey = (env.API_KEY || '').trim();
    if (!apiKey) return new Response(JSON.stringify({ error: 'API Key missing' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    try {
      if (url.pathname === '/api/translate') {
        const { text, from, to } = await request.json();
        const res = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: `Translate from ${from} to ${to}: ${text}` }] }] })
        });
        const data = await res.json();
        const translation = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        return new Response(JSON.stringify({ status: 'success', translation }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    } catch (e) {
      return new Response(JSON.stringify({ status: 'error', error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    return new Response('Not Found', { status: 404 });
  }
};
