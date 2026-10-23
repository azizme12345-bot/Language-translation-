export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-gemini-api-key, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    };

    const apiKey = (env.API_KEY || env.GEMINI_API_KEY || request.headers.get('x-gemini-api-key') || '').trim();
    if (!apiKey) {
      return jsonResponse({ status: 'error', error: 'API_KEY is missing' }, 401);
    }

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    try {
      if (pathname === '/api/health') {
        return jsonResponse({ status: 'ok', hasApiKey: true });
      }

      if (pathname === '/api/translate' && request.method === 'POST') {
        const { text, from, to } = await request.json().catch(() => ({}));
        if (!text || !text.trim()) {
          return jsonResponse({ status: 'error', error: 'No text provided' }, 400);
        }
        const sourceLang = from || 'English';
        const targetLang = to || 'Urdu';

        const geminiRes = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Translate from ${sourceLang} to ${targetLang}: ${text.trim()}` }] }]
          })
        });

        const data = await geminiRes.json();
        const translation = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        return jsonResponse({ status: 'success', translation, translatedText: translation });
      }

      if (pathname === '/api/transcribe' && request.method === 'POST') {
        const { audioBase64, mimeType, lang } = await request.json().catch(() => ({}));
        if (!audioBase64) {
          return jsonResponse({ status: 'error', error: 'No audio provided' }, 400);
        }
        const cleanBase64 = audioBase64.includes(';base64,') ? audioBase64.split(';base64,')[1] : audioBase64;
        const language = lang || 'English';

        const geminiRes = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType: mimeType || 'audio/webm', data: cleanBase64 } },
                { text: `Transcribe this audio in ${language}. Return ONLY the transcribed text.` }
              ]
            }]
          })
        });

        const data = await geminiRes.json();
        const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        return jsonResponse({ status: 'success', transcript, translatedText: transcript });
      }

      if (pathname === '/api/analyze-image' && request.method === 'POST') {
        const { imageBase64, mimeType, to } = await request.json().catch(() => ({}));
        if (!imageBase64) {
          return jsonResponse({ status: 'error', error: 'No image provided' }, 400);
        }
        const cleanBase64 = imageBase64.includes(';base64,') ? imageBase64.split(';base64,')[1] : imageBase64;
        const targetLang = to || 'Urdu';

        const geminiRes = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType: mimeType || 'image/jpeg', data: cleanBase64 } },
                { text: `Extract text from this image and translate into ${targetLang}. Return JSON: {"extractedText": "...", "translatedText": "..."}` }
              ]
            }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        });

        const data = await geminiRes.json();
        const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        let parsed = {};
        try { parsed = JSON.parse(jsonText); } catch { parsed = { extractedText: jsonText, translatedText: jsonText }; }

        return jsonResponse({
          status: 'success',
          extractedText: parsed.extractedText || '',
          translatedText: parsed.translatedText || ''
        });
      }

      if (pathname === '/api/tts' && request.method === 'POST') {
        const { text } = await request.json().catch(() => ({}));
        if (!text) {
          return jsonResponse({ status: 'error', error: 'No text provided' }, 400);
        }
        const geminiRes = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: text.trim() }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
            }
          })
        });

        if (geminiRes.ok) {
          const resData = await geminiRes.json();
          const base64Audio = resData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
            return jsonResponse({ status: 'success', audioBase64: base64Audio, mimeType: 'audio/wav' });
          }
        }
        return jsonResponse({ status: 'fallback', message: 'Use browser speech' });
      }

    } catch (err) {
      return jsonResponse({ status: 'error', error: err.message }, 500);
    }

    return jsonResponse({ status: 'error', error: 'Not found' }, 404);
  }
};
