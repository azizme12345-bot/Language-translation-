/**
 * Cloudflare Worker for Language Translator
 * Deploy this on Cloudflare Workers to power translation, microphone transcription, TTS, and camera analysis.
 * Environment Variables required in Cloudflare Worker Dashboard:
 *   - API_KEY or GEMINI_API_KEY: Your Google Gemini API Key
 */

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, x-gemini-api-key, Authorization',
    };

    // Handle preflight OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      });
    };

    // Health check endpoint
    if (pathname === '/api/health' && request.method === 'GET') {
      const hasKey = Boolean((env && (env.API_KEY || env.GEMINI_API_KEY)));
      return jsonResponse({ status: 'ok', hasApiKey: hasKey });
    }

    // Determine API Key from request headers or environment variables
    const headerKey = request.headers.get('x-gemini-api-key');
    const apiKey = (headerKey && headerKey.trim().length >= 25)
      ? headerKey.trim()
      : ((env && (env.API_KEY || env.GEMINI_API_KEY)) || '').trim();

    if (!apiKey) {
      return jsonResponse({
        status: 'error',
        error: 'API_KEY is not configured in Cloudflare Worker environment variables or request headers.',
        message: 'API key is missing. Please set API_KEY in Cloudflare Worker Settings > Variables.',
      }, 401);
    }

    // 1. Translation Endpoint
    if (pathname === '/api/translate' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const { text, from, to } = body;

        if (!text || !text.trim()) {
          return jsonResponse({ status: 'error', error: 'No text provided to translate.', message: 'No text provided' }, 400);
        }

        const sourceLang = from || 'English';
        const targetLang = to || 'Urdu';

        if (sourceLang.toLowerCase() === targetLang.toLowerCase()) {
          return jsonResponse({ status: 'success', translation: text.trim(), translatedText: text.trim() });
        }

        const prompt = `Translate the following text accurately from ${sourceLang} to ${targetLang}.
Rules:
1. Output ONLY the translated text. Do not include notes, conversational greetings, explanations, or quotes.
2. Preserve original formatting and paragraphs.

Text:
${text.trim()}`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
          let errMsg = `Gemini API error (HTTP ${geminiRes.status})`;
          try {
            const errJson = JSON.parse(errText);
            errMsg = errJson.error?.message || errMsg;
          } catch {
            errMsg = errText || errMsg;
          }
          return jsonResponse({ status: 'error', error: errMsg, message: errMsg }, 500);
        }

        const resData = await geminiRes.json();
        const candidateText = resData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const translation = candidateText.trim();

        return jsonResponse({
          status: 'success',
          translation,
          translatedText: translation,
        });
      } catch (err) {
        return jsonResponse({ status: 'error', error: err.message || 'Internal translation error', message: err.message }, 500);
      }
    }

    // 2. Audio Transcription Endpoint (Microphone speech-to-text)
    if (pathname === '/api/transcribe' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        let { audioBase64, mimeType, lang } = body;

        if (!audioBase64) {
          return jsonResponse({ status: 'error', error: 'No audio data received', message: 'No audio data received' }, 400);
        }

        let cleanBase64 = audioBase64;
        let detectedMime = mimeType || 'audio/webm';
        if (audioBase64.includes(';base64,')) {
          const parts = audioBase64.split(';base64,');
          detectedMime = parts[0].replace('data:', '') || detectedMime;
          cleanBase64 = parts[1];
        }

        const language = lang || 'English';
        const prompt = `Listen to this spoken audio carefully. Transcribe the speech accurately in its original language (${language}). Return ONLY the transcribed text. If no clear speech is detected, return an empty string.`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
          return jsonResponse({ status: 'error', error: errText || 'Transcription failed', message: errText }, 500);
        }

        const resData = await geminiRes.json();
        const transcript = (resData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

        return jsonResponse({
          status: 'success',
          transcript,
          translatedText: transcript,
        });
      } catch (err) {
        return jsonResponse({ status: 'error', error: err.message || 'Transcription error', message: err.message }, 500);
      }
    }

    // 3. Text-to-Speech Endpoint (Speaker playback)
    if (pathname === '/api/tts' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const { text, lang } = body;

        if (!text || !text.trim()) {
          return jsonResponse({ status: 'error', error: 'No text provided for speech.', message: 'No text provided' }, 400);
        }

        // Call Gemini TTS endpoint
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
            return jsonResponse({
              status: 'success',
              audioBase64,
              mimeType: 'audio/wav',
            });
          }
        }

        // If direct audio generation is unavailable, return fallback notification
        return jsonResponse({
          status: 'fallback',
          message: 'Use client browser speech synthesis fallback',
        });
      } catch (err) {
        return jsonResponse({ status: 'error', error: err.message || 'TTS error', message: err.message }, 500);
      }
    }

    // 4. Image Analysis & OCR Endpoint (Camera / Gallery Image)
    if (pathname === '/api/analyze-image' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        let { imageBase64, mimeType, from, to } = body;

        if (!imageBase64) {
          return jsonResponse({ status: 'error', error: 'No image data provided', message: 'No image data provided' }, 400);
        }

        let cleanBase64 = imageBase64;
        let detectedMime = mimeType || 'image/jpeg';
        if (imageBase64.includes(';base64,')) {
          const parts = imageBase64.split(';base64,');
          detectedMime = parts[0].replace('data:', '') || detectedMime;
          cleanBase64 = parts[1];
        }

        const sourceLang = from || 'English';
        const targetLang = to || 'Urdu';

        const prompt = `Inspect this image:
1. Extract all text visible in the image.
2. Translate that text into ${targetLang}.
3. If no text is visible, concisely describe the image in ${sourceLang} and translate that description into ${targetLang}.

Return a JSON object in this exact format:
{
  "extractedText": "Original extracted text",
  "translatedText": "Translation into ${targetLang}"
}`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          return jsonResponse({ status: 'error', error: errText || 'Image analysis failed', message: errText }, 500);
        }

        const resData = await geminiRes.json();
        const jsonText = resData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        let parsed = {};
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          parsed = { extractedText: jsonText, translatedText: jsonText };
        }

        return jsonResponse({
          status: 'success',
          extractedText: parsed.extractedText || '',
          translatedText: parsed.translatedText || '',
        });
      } catch (err) {
        return jsonResponse({ status: 'error', error: err.message || 'Image analysis error', message: err.message }, 500);
      }
    }

    return jsonResponse({ status: 'error', error: `Route ${pathname} not found`, message: 'Not found' }, 404);
  },
};
