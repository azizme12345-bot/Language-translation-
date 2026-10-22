export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, x-gemini-api-key, Authorization',
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

    if (pathname === '/api/health' && request.method === 'GET') {
      const hasKey = Boolean(env && (env.API_KEY || env.GEMINI_API_KEY));
      return jsonResponse({ status: 'ok', hasApiKey: hasKey });
    }

    const headerKey = request.headers.get('x-gemini-api-key');
    const apiKey = (headerKey && headerKey.trim().length >= 25)
      ? headerKey.trim()
      : ((env && (env.API_KEY || env.GEMINI_API_KEY)) || '').trim();

    if (!apiKey) {
      return jsonResponse({
        status: 'error',
        error: 'API_KEY is missing. Please set API_KEY in Cloudflare Worker Settings > Variables.',
        message: 'API key is missing.',
      }, 401);
    }

    // 1. Translation Endpoint
    if (pathname === '/api/translate' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const { text, from, to } = body;

        if (!text || !text.trim()) {
          return jsonResponse({ status: 'error', error: 'No text provided to translate.' }, 400);
        }

        const sourceLang = from || 'English';
        const targetLang = to || 'Urdu';

        if (sourceLang.toLowerCase() === targetLang.toLowerCase()) {
          return jsonResponse({ status: 'success', translation: text.trim(), translatedText: text.trim() });
        }

        const prompt = `Translate the following text accurately from ${sourceLang} to ${targetLang}.
Rules:
1. Output ONLY the translated text. Do not include notes, greetings, or quotes.
2. Preserve formatting.

Text:
${text.trim()}`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 },
          }),
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          return jsonResponse({ status: 'error', error: errText || 'Gemini API error' }, 500);
        }

        const resData = await geminiRes.json();
        const translation = (resData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

        return jsonResponse({ status: 'success', translation, translatedText: translation });
      } catch (err) {
        return jsonResponse({ status: 'error', error: err.message || 'Internal error' }, 500);
      }
    }

    // 2. Audio Transcription Endpoint
    if (pathname === '/api/transcribe' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        let { audioBase64, mimeType, lang } = body;

        if (!audioBase64) {
          return jsonResponse({ status: 'error', error: 'No audio data received' }, 400);
        }

        let cleanBase64 = audioBase64;
        let detectedMime = mimeType || 'audio/webm';
        if (audioBase64.includes(';base64,')) {
          const parts = audioBase64.split(';base64,');
          detectedMime = parts[0].replace('data:', '') || detectedMime;
          cleanBase64 = parts[1];
        }

        const language = lang || 'English';
        const prompt = `Listen to this audio carefully and transcribe the speech accurately in its original language (${language}). Return ONLY the transcribed text.`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType: detectedMime, data: cleanBase64 } },
                { text: prompt },
              ],
            }],
          }),
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          return jsonResponse({ status: 'error', error: errText || 'Transcription failed' }, 500);
        }

        const resData = await geminiRes.json();
        const transcript = (resData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

        return jsonResponse({ status: 'success', transcript, translatedText: transcript });
      } catch (err) {
        return jsonResponse({ status: 'error', error: err.message || 'Transcription error' }, 500);
      }
    }

    // 3. Text-to-Speech Endpoint
    if (pathname === '/api/tts' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const { text } = body;

        if (!text || !text.trim()) {
          return jsonResponse({ status: 'error', error: 'No text provided for speech.' }, 400);
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: text.trim() }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
              },
            },
          }),
        });

        if (geminiRes.ok) {
          const resData = await geminiRes.json();
          const base64Audio = resData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
            return jsonResponse({ status: 'success', audioBase64: base64Audio, mimeType: 'audio/wav' });
          }
        }

        return jsonResponse({ status: 'fallback', message: 'Use browser speech fallback' });
      } catch (err) {
        return jsonResponse({ status: 'error', error: err.message || 'TTS error' }, 500);
      }
    }

    // 4. Image Analysis & OCR Endpoint
    if (pathname === '/api/analyze-image' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        let { imageBase64, mimeType, from, to } = body;

        if (!imageBase64) {
          return jsonResponse({ status: 'error', error: 'No image data provided' }, 400);
        }

        let cleanBase64 = imageBase64;
        let detectedMpm = mimeType || 'image/jpeg';
        if (imageBase64.includes(';base64,')) {
          const parts = imageBase64.split(';base64,');
          detectedMpm = parts[0].replace('data:', '') || detectedMpm;
          cleanBase64 = parts[1];
        }

        const targetLang = to || 'Urdu';
        const prompt = `Extract all text from this image and translate it into ${targetLang}. Return JSON: {"extractedText": "...", "translatedText": "..."}`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType: detectedMpm, data: cleanBase64 } },
                { text: prompt },
              ],
            }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          return jsonResponse({ status: 'error', error: errText || 'Image analysis failed' }, 500);
        }

        const resData = await geminiRes.json();
        const jsonText = resData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        let parsed = {};
        try { parsed = JSON.parse(jsonText); } catch { parsed = { extractedText: jsonText, translatedText: jsonText }; }

        return jsonResponse({ status: 'success', extractedText: parsed.extractedText || '', translatedText: parsed.translatedText || '' });
      } catch (err) {
        return jsonResponse({ status: 'source', error: err.message || 'Image analysis error' }, 500);
      }
    }

    return jsonResponse({ status: 'error', error: `Route ${pathname} not found` }, 404);
  },
};
