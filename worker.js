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

    const apiKey = (env.GEMINI_API_KEY || env.API_KEY || request.headers.get('x-gemini-api-key') || '').trim();
    if (!apiKey) {
      return jsonResponse({ status: 'error', error: 'GEMINI_API_KEY is missing in Cloudflare variables' }, 401);
    }

    // Active verified models supported by the v1beta API
    const MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'];

    async function callGemini(contents, generationConfig = {}) {
      let lastErrMsg = 'Gemini API call failed';
      for (const model of MODELS) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents, generationConfig }),
          });

          const data = await res.json();
          if (res.ok && data.candidates?.[0]?.content?.parts?.[0]) {
            return data;
          }
          if (data.error?.message) {
            lastErrMsg = data.error.message;
          }
        } catch (e) {
          lastErrMsg = e.message || lastErrMsg;
        }
      }
      throw new Error(lastErrMsg);
    }

    try {
      if (pathname === '/api/health') {
        return jsonResponse({ status: 'ok', hasApiKey: true });
      }

      let bodyData = {};
      try {
        bodyData = await request.json();
      } catch {
        bodyData = {};
      }

      if (pathname === '/api/translate' && request.method === 'POST') {
        const { text, from, to } = bodyData;
        if (!text || !text.trim()) {
          return jsonResponse({ status: 'error', error: 'No text provided' }, 400);
        }
        const sourceLang = from || 'English';
        const targetLang = to || 'Urdu';

        const prompt = `You are a professional translator. Translate the following text accurately from ${sourceLang} to ${targetLang}.
Rules:
1. Return ONLY the translated text. Do not include notes, conversational greetings, explanations, or quotes.
2. Preserve formatting.

Text:
${text.trim()}`;

        const data = await callGemini([{ parts: [{ text: prompt }] }], { temperature: 0.2 });
        const translation = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

        return jsonResponse({ status: 'success', translation, translatedText: translation });
      }

      if (pathname === '/api/transcribe' && request.method === 'POST') {
        const { audioBase64, mimeType, lang } = bodyData;
        if (!audioBase64) {
          return jsonResponse({ status: 'error', error: 'No audio provided' }, 400);
        }
        const cleanBase64 = audioBase64.includes(';base64,') ? audioBase64.split(';base64,')[1] : audioBase64;
        const language = lang || 'English';

        const data = await callGemini([{
          parts: [
            { inlineData: { mimeType: mimeType || 'audio/webm', data: cleanBase64 } },
            { text: `Transcribe this audio in ${language}. Return ONLY the transcribed text.` }
          ]
        }]);

        const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        return jsonResponse({ status: 'success', transcript, translatedText: transcript });
      }

      if (pathname === '/api/analyze-image' && request.method === 'POST') {
        const { imageBase64, mimeType, to } = bodyData;
        if (!imageBase64) {
          return jsonResponse({ status: 'error', error: 'No image provided' }, 400);
        }
        const cleanBase64 = imageBase64.includes(';base64,') ? imageBase64.split(';base64,')[1] : imageBase64;
        const targetLang = to || 'Urdu';

        const data = await callGemini([{
          parts: [
            { inlineData: { mimeType: mimeType || 'image/jpeg', data: cleanBase64 } },
            { text: `Extract text from this image and translate into ${targetLang}. Return JSON: {"extractedText": "...", "translatedText": "..."}` }
          ]
        }], { responseMimeType: 'application/json' });

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
        const { text } = bodyData;
        if (!text) {
          return jsonResponse({ status: 'error', error: 'No text provided' }, 400);
        }

        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`, {
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

          if (res.ok) {
            const resData = await res.json();
            const base64Audio = resData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              return jsonResponse({ status: 'success', audioBase64: base64Audio, mimeType: 'audio/wav' });
            }
          }
        } catch {
          // fallback to browser speech
        }

        return jsonResponse({ status: 'fallback', message: 'Use browser speech' });
      }

    } catch (err) {
      return jsonResponse({ status: 'error', error: err.message || 'Processing failed' }, 500);
    }

    return jsonResponse({ status: 'error', error: `Route ${pathname} not found` }, 404);
  }
};
