function pcmToWavBase64(pcmBase64, sampleRate = 24000) {
  const binaryString = atob(pcmBase64);
  const dataSize = binaryString.length;
  const numChannels = 1;
  const bitDepth = 16;
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const headerBytes = new Uint8Array(header);
  let headerBinary = '';
  for (let i = 0; i < headerBytes.length; i++) {
    headerBinary += String.fromCharCode(headerBytes[i]);
  }

  return btoa(headerBinary + binaryString);
}

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
    const origin = url.origin || `https://${url.host}`;

    // 1. Robots.txt for Google Search Console, Bing, and Web Crawlers
    if (pathname === '/robots.txt') {
      const robots = `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`;
      return new Response(robots, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          ...corsHeaders,
        },
      });
    }

    // 2. Dynamic Sitemap.xml matching requested host (Googlebot friendly)
    if (pathname === '/sitemap.xml') {
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${origin}/</loc>
    <lastmod>2026-10-25</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/" />
    <xhtml:link rel="alternate" hreflang="ur" href="${origin}/" />
  </url>
  <url>
    <loc>${origin}/english-to-urdu</loc>
    <lastmod>2026-10-25</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/english-to-urdu" />
    <xhtml:link rel="alternate" hreflang="ur" href="${origin}/english-to-urdu" />
  </url>
  <url>
    <loc>${origin}/urdu-to-english</loc>
    <lastmod>2026-10-25</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
    <xhtml:link rel="alternate" hreflang="ur" href="${origin}/urdu-to-english" />
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/urdu-to-english" />
  </url>
</urlset>`;
      return new Response(sitemap, {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          ...corsHeaders,
        },
      });
    }

    // 3. Static assets & SPA client routing (prevent 404 for /english-to-urdu, /urdu-to-english, etc.)
    if (env.ASSETS && !pathname.startsWith('/api/')) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) {
        return assetRes;
      }
      if (request.method === 'GET') {
        return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
      }
    }

    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    };

    // 4. API Endpoints
    const apiKey = (env.GEMINI_API_KEY || env.API_KEY || request.headers.get('x-gemini-api-key') || '').trim();
    if (!apiKey) {
      return jsonResponse({ status: 'error', error: 'GEMINI_API_KEY is missing in Cloudflare variables' }, 401);
    }

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

        const prompt = `Translate the following text faithfully from ${sourceLang} to ${targetLang}.
CRITICAL ACCURACY RULES:
1. Translate names, proper nouns, and person identities with 100% exact phonetic accuracy. DO NOT alter, replace, or guess any person's name (e.g. 'Abdul aziz' MUST be translated as 'عبدالعزیز' or 'عبد العزیز', NEVER as 'عبداللطیف' or any different name).
2. Output ONLY the translated text, with no explanations, notes, or extra characters.
3. Preserve original capitalization and punctuation where appropriate.

Text:
${text.trim()}`;

        const data = await callGemini([{ parts: [{ text: prompt }] }], { temperature: 0.0 });
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
            { text: `Transcribe this audio in ${language}. Return ONLY the transcribed text accurately.` }
          ]
        }], { temperature: 0.0 });

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
        if (!text || !text.trim()) {
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
            const pcmAudio = resData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (pcmAudio) {
              const wavAudio = pcmToWavBase64(pcmAudio, 24000);
              return jsonResponse({ status: 'success', audioBase64: wavAudio, mimeType: 'audio/wav' });
            }
          }
        } catch {
          // fallback
        }

        return jsonResponse({ status: 'fallback', message: 'Use browser speech' });
      }

    } catch (err) {
      return jsonResponse({ status: 'error', error: err.message || 'Processing failed' }, 500);
    }

    return jsonResponse({ status: 'error', error: `Route ${pathname} not found` }, 404);
  }
};
