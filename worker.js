export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-gemini-api-key',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

    const apiKey = (env.API_KEY || '').trim();
    if (!apiKey) return new Response(JSON.stringify({ error: 'API_KEY missing' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    try {
      const body = await request.json();
      const { text, from, to, audioBase64 } = body;
      
      let payload;
      if (audioBase64) {
        payload = { contents: [{ parts: [{ inlineData: { mimeType: 'audio/webm', data: audioBase64.split(',')[1] || audioBase64 } }, { text: "Transcribe this audio. Return ONLY the transcribed text." }] }] };
      } else {
        payload = { contents: [{ parts: [{ text: `Translate from ${from || 'English'} to ${to || 'Urdu'}: ${text}` }] }] };
      }

      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      const result = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from AI";
      
      return new Response(JSON.stringify({ status: 'success', translation: result, transcript: result, translatedText: result }), { 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
      });

    } catch (e) {
      return new Response(JSON.stringify({ status: 'error', error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
  }
};
