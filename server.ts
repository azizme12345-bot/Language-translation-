import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = (process.env.PORT && process.env.PORT !== '8080') ? Number(process.env.PORT) : 3000;

// Middleware to parse JSON payloads (allow up to 25MB for audio and image uploads)
app.use(express.json({ limit: '25mb' }));

// Helper to sanitize and obtain Gemini client
function getGeminiClient(customApiKey?: string): GoogleGenAI {
  const cleanedCustom = customApiKey?.trim()?.replace(/^["']|["']$/g, '');
  const cleanedEnv = process.env.GEMINI_API_KEY?.trim()?.replace(/^["']|["']$/g, '');

  // Prefer custom key if it has a valid length (typically >= 30), otherwise use server env
  let apiKey = (cleanedCustom && cleanedCustom.length >= 30) ? cleanedCustom : cleanedEnv;
  if (!apiKey && cleanedCustom) {
    apiKey = cleanedCustom;
  }

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server. Please ensure your Gemini API key is configured.');
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Fallback execution if custom API key has authorization error
async function executeWithApiKeyFallback<T>(
  customApiKey: string | undefined,
  fn: (ai: GoogleGenAI) => Promise<T>
): Promise<T> {
  const ai = getGeminiClient(customApiKey);
  try {
    return await fn(ai);
  } catch (err: any) {
    const errMsg = err?.message || '';
    const isKeyAuthError =
      errMsg.includes('API_KEY_INVALID') ||
      errMsg.includes('API key not valid') ||
      errMsg.includes('PERMISSION_DENIED');

    if (isKeyAuthError && customApiKey && process.env.GEMINI_API_KEY) {
      console.warn('Custom API key rejected by API, falling back to server GEMINI_API_KEY...');
      const serverAi = getGeminiClient(undefined);
      return await fn(serverAi);
    }
    throw err;
  }
}

// Track models that have temporary capacity issues (circuit breaker)
const degradedModels = new Map<string, number>();

function isModelDegraded(model: string): boolean {
  const until = degradedModels.get(model);
  if (!until) return false;
  if (Date.now() > until) {
    degradedModels.delete(model);
    return false;
  }
  return true;
}

function markModelDegraded(model: string, durationMs = 10 * 60 * 1000) {
  degradedModels.set(model, Date.now() + durationMs);
}

// Pre-mark models in 503 spike to prioritize healthy ones
markModelDegraded('gemini-3.8-flash', 10 * 60 * 1000);
markModelDegraded('gemini-flash-latest', 10 * 60 * 1000);

// Single model call with internal timeout
function callModelWithTimeout(
  ai: GoogleGenAI,
  model: string,
  contents: any,
  config: any,
  timeoutMs = 20000
) {
  return new Promise<any>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Model ${model} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    ai.models
      .generateContent({
        model,
        contents,
        config,
      })
      .then((res) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve(res);
        }
      })
      .catch((err) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          reject(err);
        }
      });
  });
}

// Generate content with resilient fallback across verified Gemini models
async function generateWithFallback(
  ai: GoogleGenAI,
  preferredModel: string,
  params: { contents: any; config?: any },
  timeoutMs = 15000
) {
  const baseCandidates = [
    preferredModel,
    'gemini-flash-lite-latest',
    'gemini-3.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.5-transcribe',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
  ];

  const uniqueModels = Array.from(new Set(baseCandidates.filter(Boolean)));

  // Try healthy non-degraded models first
  uniqueModels.sort((a, b) => {
    const aDeg = isModelDegraded(a) ? 1 : 0;
    const bDeg = isModelDegraded(b) ? 1 : 0;
    return aDeg - bDeg;
  });

  let lastError: any = null;

  for (const model of uniqueModels) {
    try {
      const response = await callModelWithTimeout(
        ai,
        model,
        params.contents,
        params.config,
        timeoutMs
      );
      if (response && response.text) {
        return response;
      }
    } catch (err: any) {
      lastError = err;
      const errMsg = err?.message || '';
      if (
        errMsg.includes('503') ||
        errMsg.includes('high demand') ||
        errMsg.includes('UNAVAILABLE') ||
        errMsg.includes('404') ||
        errMsg.includes('429') ||
        errMsg.includes('RESOURCE_EXHAUSTED') ||
        errMsg.includes('timed out')
      ) {
        markModelDegraded(model);
      }
    }
  }

  throw lastError || new Error('All translation models are currently busy. Please try again shortly.');
}

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
  });
});

// Translation endpoint
app.post('/api/translate', async (req, res) => {
  try {
    const { text, from, to, model } = req.body;
    const customApiKey = req.headers['x-gemini-api-key'] as string | undefined;

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Please enter text to translate.' });
      return;
    }

    const sourceLang = from || 'English';
    const targetLang = to || 'Urdu';

    if (sourceLang.toLowerCase() === targetLang.toLowerCase()) {
      res.json({ translation: text.trim() });
      return;
    }

    const selectedModel = (typeof model === 'string' && model.trim()) ? model.trim() : 'gemini-3.6-flash';

    const systemInstruction = `You are a professional, accurate translator.
Translate the text from ${sourceLang} to ${targetLang}.
Rules:
1. Output ONLY the translated text. Do not add explanations, conversational remarks, intro/outro greetings, or surrounding quotes.
2. Maintain the original tone, format, paragraph breaks, and punctuation accurately.`;

    const response = await executeWithApiKeyFallback(customApiKey, (ai) =>
      generateWithFallback(ai, selectedModel, {
        contents: text.trim(),
        config: {
          systemInstruction,
          temperature: 0.2,
        },
      })
    );

    const responseText = response.text ? response.text.trim() : '';

    let translation = responseText;
    try {
      const parsed = JSON.parse(responseText);
      if (parsed.translation) {
        translation = parsed.translation;
      }
    } catch {
      // It's plain text, use as is
    }

    if (!translation) {
      res.status(500).json({ error: 'Received an empty translation from the AI model.' });
      return;
    }

    res.json({ translation });
  } catch (err: any) {
    console.error('Translation error:', err);
    let message = 'Failed to translate text. Please try again.';
    try {
      if (err?.message && err.message.startsWith('{')) {
        const parsed = JSON.parse(err.message);
        message = parsed?.error?.message || message;
      } else if (err?.message) {
        message = err.message;
      }
    } catch {
      message = err?.message || message;
    }
    res.status(500).json({ error: message });
  }
});

// Audio speech transcription endpoint (Gemini voice-to-text fallback)
app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioBase64, mimeType, lang } = req.body;
    const customApiKey = req.headers['x-gemini-api-key'] as string | undefined;

    if (!audioBase64 || typeof audioBase64 !== 'string') {
      res.status(400).json({ error: 'No audio data provided.' });
      return;
    }

    let cleanBase64 = audioBase64;
    let detectedMime = mimeType || 'audio/webm';

    if (audioBase64.includes(';base64,')) {
      const parts = audioBase64.split(';base64,');
      detectedMime = parts[0].replace('data:', '') || detectedMime;
      cleanBase64 = parts[1];
    }

    const language = lang || 'English';

    const promptText = `Listen to this spoken audio carefully.
Transcribe the speech accurately in its original spoken language (${language}).
Rules:
1. Return ONLY the transcribed text.
2. Do not translate. Do not add notes, markdown, or greetings.
3. If no intelligible speech is heard, return an empty string.`;

    const audioPart = {
      inlineData: {
        mimeType: detectedMime,
        data: cleanBase64,
      },
    };

    const textPart = {
      text: promptText,
    };

    const response = await executeWithApiKeyFallback(customApiKey, (ai) =>
      generateWithFallback(
        ai,
        'gemini-3.5-transcribe',
        {
          contents: {
            parts: [audioPart, textPart],
          },
        },
        25000
      )
    );

    const transcript = response.text ? response.text.trim() : '';
    res.json({ transcript });
  } catch (err: any) {
    console.error('Transcription error:', err);
    let message = 'Failed to transcribe audio. Please try speaking again.';
    try {
      if (err?.message && err.message.startsWith('{')) {
        const parsed = JSON.parse(err.message);
        message = parsed?.error?.message || message;
      } else if (err?.message) {
        message = err.message;
      }
    } catch {
      message = err?.message || message;
    }
    res.status(500).json({ error: message });
  }
});

// Text-to-speech endpoint (Gemini Flash Lite TTS)
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    const customApiKey = req.headers['x-gemini-api-key'] as string | undefined;

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'No text provided for speech playback.' });
      return;
    }

    const cleanText = text.trim();

    const response = await executeWithApiKeyFallback(customApiKey, (ai) =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [{ text: cleanText }],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      })
    );

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      res.status(500).json({ error: 'No audio generated by TTS model.' });
      return;
    }

    res.json({ audioBase64: base64Audio, mimeType: 'audio/wav' });
  } catch (err: any) {
    console.error('TTS endpoint error:', err);
    res.status(500).json({ error: err?.message || 'TTS generation failed' });
  }
});

// Image analysis & OCR endpoint
app.post('/api/analyze-image', async (req, res) => {
  try {
    const { imageBase64, mimeType, from, to, model } = req.body;
    const customApiKey = req.headers['x-gemini-api-key'] as string | undefined;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      res.status(400).json({ error: 'No image data provided.' });
      return;
    }

    let cleanBase64 = imageBase64;
    let detectedMime = mimeType || 'image/jpeg';

    if (imageBase64.includes(';base64,')) {
      const parts = imageBase64.split(';base64,');
      detectedMime = parts[0].replace('data:', '') || detectedMime;
      cleanBase64 = parts[1];
    }

    const selectedModel = (typeof model === 'string' && model.trim()) ? model.trim() : 'gemini-3.6-flash';
    const sourceLang = from || 'English';
    const targetLang = to || 'Urdu';

    const promptText = `Inspect this image carefully:
1. Detect and extract all visible text from the image in its original language.
2. Translate that text into ${targetLang}.
3. If no readable text is present in the image, concisely describe the visual content of the image in ${sourceLang}, and translate that description into ${targetLang}.

Return a valid JSON object matching this schema:
{
  "extractedText": "Original extracted text from image (or description if no text)",
  "translatedText": "Translation of the text or description into ${targetLang}"
}`;

    const imagePart = {
      inlineData: {
        mimeType: detectedMime,
        data: cleanBase64,
      },
    };

    const textPart = {
      text: promptText,
    };

    const response = await executeWithApiKeyFallback(customApiKey, (ai) =>
      generateWithFallback(
        ai,
        selectedModel,
        {
          contents: {
            parts: [imagePart, textPart],
          },
          config: {
            responseMimeType: 'application/json',
          },
        },
        25000
      )
    );

    const responseText = response.text ? response.text.trim() : '';

    let extractedText = '';
    let translatedText = '';

    try {
      const parsed = JSON.parse(responseText);
      extractedText = parsed.extractedText || '';
      translatedText = parsed.translatedText || '';
    } catch {
      extractedText = responseText;
      translatedText = responseText;
    }

    res.json({
      extractedText,
      translatedText,
    });
  } catch (err: any) {
    console.error('Image analysis error:', err);
    let message = 'Failed to analyze image. Please try again.';
    try {
      if (err?.message && err.message.startsWith('{')) {
        const parsed = JSON.parse(err.message);
        message = parsed?.error?.message || message;
      } else if (err?.message) {
        message = err.message;
      }
    } catch {
      message = err?.message || message;
    }
    res.status(500).json({ error: message });
  }
});

// Vite middleware in dev or static serving in prod
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  function listen(p: number) {
    const server = app.listen(p, '0.0.0.0', () => {
      console.log(`Server listening on port ${p}`);
    });
    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${p} in use, trying port ${p + 1}…`);
        listen(p + 1);
      } else {
        console.error('Server error:', err);
      }
    });
  }

  listen(PORT);
}

startServer();
