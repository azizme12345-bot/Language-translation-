/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';

const LANGUAGE_SPEECH_MAP: Record<string, string> = {
  English: 'en-US',
  Urdu: 'ur-PK',
  Hindi: 'hi-IN',
  Punjabi: 'pa-IN',
  Arabic: 'ar-SA',
  French: 'fr-FR',
  Spanish: 'es-ES',
};

const MODEL_OPTIONS = [
  { label: 'Gemini Flash — fast', id: 'gemini-flash-lite-latest' },
  { label: 'Gemini Pro — advanced', id: 'gemini-3.5-flash-lite' },
  { label: 'Other configured model', id: 'gemini-3-flash-preview' },
];

async function parseSafeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text || !text.trim()) {
    throw new Error('Backend returned an empty response. Please verify that your backend worker or API server is configured.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON response (${res.status}): ${text.slice(0, 120)}`);
  }
}

export default function App() {
  const [fromLang, setFromLang] = useState('English');
  const [toLang, setToLang] = useState('Urdu');
  const [sourceText, setSourceText] = useState('');
  const [resultText, setResultText] = useState('Translation will appear here…');
  const [statusText, setStatusText] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [appLanguage, setAppLanguage] = useState('English');
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [customApiKey, setCustomApiKey] = useState(() => {
    try {
      return localStorage.getItem('gemini_api_key') || '';
    } catch {
      return '';
    }
  });
  const [isListening, setIsListening] = useState(false);

  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const anyFileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const hasLiveSpeechRef = useRef<boolean>(false);
  const deferredPromptRef = useRef<any>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize theme and PWA install prompt handler
  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem('theme');
      if (savedTheme === 'dark') {
        document.body.classList.add('dark');
      }
    } catch {
      // ignore
    }

    // Register service worker if available
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.debug('ServiceWorker registration error:', err);
      });
    }

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e;
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // Set the page language tag to match the app language (en for English, ur for Urdu)
  useEffect(() => {
    const langCode = appLanguage.toLowerCase().startsWith('ur') ? 'ur' : 'en';
    document.documentElement.lang = langCode;
  }, [appLanguage]);

  // Initialize language direction based on URL route (e.g. /urdu-to-english or /english-to-urdu)
  useEffect(() => {
    const path = window.location.pathname.toLowerCase();
    if (path.includes('urdu-to-english')) {
      setFromLang('Urdu');
      setToLang('English');
    } else if (path.includes('english-to-urdu')) {
      setFromLang('English');
      setToLang('Urdu');
    }
  }, []);

  const toggleTheme = () => {
    const isDark = document.body.classList.toggle('dark');
    try {
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    } catch {
      // ignore
    }
  };

  const handleSwap = () => {
    const prevFrom = fromLang;
    const prevTo = toLang;
    setFromLang(prevTo);
    setToLang(prevFrom);

    if (resultText && resultText !== 'Translation will appear here…') {
      setSourceText(resultText);
      setResultText(sourceText || 'Translation will appear here…');
    }
  };

  const handleClear = () => {
    setSourceText('');
    setResultText('Translation will appear here…');
    setStatusText('');
  };

  const handlePaste = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          setSourceText(text);
          setStatusText('Pasted from clipboard.');
        } else {
          setStatusText('Clipboard is empty.');
        }
      } else {
        setStatusText('Long-press the text box and choose Paste.');
      }
    } catch {
      setStatusText('Long-press the text box and choose Paste.');
    }
  };

  const handleMic = async () => {
    // If currently listening, stop it cleanly
    if (isListening) {
      setIsListening(false);
      setStatusText('Processing your speech with Gemini AI…');

      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatusText('Microphone access is not supported in this browser.');
      return;
    }

    try {
      setStatusText('Requesting microphone permission…');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

      let mimeType = 'audio/webm';
      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
        else if (MediaRecorder.isTypeSupported('audio/ogg')) mimeType = 'audio/ogg';
        else mimeType = '';
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      hasLiveSpeechRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        setIsListening(false);
        if (audioStreamRef.current) {
          audioStreamRef.current.getTracks().forEach((t) => t.stop());
          audioStreamRef.current = null;
        }

        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];

        // If SpeechRecognition already captured the speech, we don't need duplicate transcription
        if (hasLiveSpeechRef.current) {
          return;
        }

        if (!chunks || chunks.length === 0) {
          setStatusText('No audio detected. Please click Mic and speak clearly.');
          return;
        }

        const audioBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (audioBlob.size < 800) {
          setStatusText('Recording was too brief. Please click Mic and speak again.');
          return;
        }

        setStatusText('Transcribing audio with Gemini AI…');
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const base64Audio = reader.result as string;
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
            };
            if (customApiKey && customApiKey.trim().length >= 30) {
              headers['x-gemini-api-key'] = customApiKey.trim();
            }

            const res = await fetch('/api/transcribe', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                audioBase64: base64Audio,
                mimeType: recorder.mimeType || 'audio/webm',
                lang: fromLang,
              }),
            });

            const data = await parseSafeJson(res);
            if (!res.ok) {
              throw new Error(data.error || data.message || `Server error ${res.status}`);
            }
            const recognized = data.transcript || data.translatedText || '';
            if (recognized && recognized.trim()) {
              setSourceText((prev) => (prev ? prev + ' ' + recognized.trim() : recognized.trim()));
              setStatusText(`Recognized: "${recognized.trim()}"`);
            } else {
              setStatusText('No clear speech detected. Please speak into your microphone.');
            }
          } catch (err: any) {
            console.error('Audio transcription error:', err);
            setStatusText('Audio transcription error: ' + (err?.message || 'Failed'));
          }
        };
        reader.readAsDataURL(audioBlob);
      };

      recorder.start(250);
      setIsListening(true);
      setStatusText(`Listening in ${fromLang}… Speak now. Click "Mic" again when finished.`);

      // Also attempt live SpeechRecognition if available, but do not let its errors interrupt MediaRecorder
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          recognitionRef.current = recognition;
          recognition.lang = LANGUAGE_SPEECH_MAP[fromLang] || 'en-US';
          recognition.continuous = false;
          recognition.interimResults = false;

          recognition.onresult = (event: any) => {
            const transcript = event.results?.[0]?.[0]?.transcript;
            if (transcript && transcript.trim()) {
              hasLiveSpeechRef.current = true;
              setSourceText((prev) => (prev ? prev + ' ' + transcript.trim() : transcript.trim()));
              setStatusText(`Captured: "${transcript.trim()}"`);
              setIsListening(false);
              if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
                mediaRecorderRef.current.stop();
              }
            }
          };

          recognition.onerror = () => {
            // Silently allow MediaRecorder + Gemini to handle transcription
            console.debug('Browser speech recognition unavailable in iframe, using Gemini audio recorder.');
          };

          recognition.start();
        } catch {
          // MediaRecorder is already recording
        }
      }
    } catch (err: any) {
      setIsListening(false);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setStatusText('Microphone permission denied. Please click the lock or camera icon in your browser address bar to allow Microphone.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setStatusText('No microphone device found on this system.');
      } else {
        setStatusText('Microphone error: ' + (err?.message || 'Check microphone settings.'));
      }
    }
  };



  const handleTranslate = async () => {
    if (!sourceText || !sourceText.trim()) {
      setStatusText('Please enter text to translate or upload an image.');
      return;
    }

    setIsTranslating(true);
    setStatusText(`Translating from ${fromLang} to ${toLang}…`);

    try {
      const selectedModel = MODEL_OPTIONS[selectedModelIndex]?.id || 'gemini-3.6-flash';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (customApiKey && customApiKey.trim().length >= 10) {
        headers['x-gemini-api-key'] = customApiKey.trim();
      }

      const res = await fetch('/api/translate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: sourceText,
          from: fromLang,
          to: toLang,
          model: selectedModel,
        }),
      });

      const data = await parseSafeJson(res);
      if (!res.ok) {
        throw new Error(data.error || data.message || 'Translation failed.');
      }

      const translation = data.translation || data.translatedText || '';
      setResultText(translation);
      setStatusText('Translation complete.');
    } catch (err: any) {
      console.error('Translate error:', err);
      setStatusText(err.message || 'Translation error occurred.');
    } finally {
      setIsTranslating(false);
    }
  };

  const handleProcessImage = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setStatusText('Selected file is not an image.');
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      setStatusText('Image file is too large. Please select an image under 20MB.');
      return;
    }

    setStatusText(`Reading image: ${file.name}…`);
    const reader = new FileReader();

    reader.onload = async () => {
      try {
        const base64Data = reader.result as string;
        setStatusText('Analyzing image and translating text with Gemini Vision…');
        setIsTranslating(true);

        const selectedModel = MODEL_OPTIONS[selectedModelIndex]?.id || 'gemini-3.6-flash';
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (customApiKey && customApiKey.trim().length >= 30) {
          headers['x-gemini-api-key'] = customApiKey.trim();
        }

        const res = await fetch('/api/analyze-image', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            imageBase64: base64Data,
            mimeType: file.type,
            from: fromLang,
            to: toLang,
            model: selectedModel,
          }),
        });

        const data = await parseSafeJson(res);
        if (!res.ok) {
          throw new Error(data.error || data.message || 'Failed to analyze image.');
        }

        if (data.extractedText) {
          setSourceText(data.extractedText);
        }
        if (data.translatedText) {
          setResultText(data.translatedText);
        }
        setStatusText(`Processed "${file.name}": text extracted and translated.`);
      } catch (err: any) {
        console.error('Image analysis error:', err);
        setStatusText(err.message || 'Image analysis error.');
      } finally {
        setIsTranslating(false);
      }
    };

    reader.onerror = () => {
      setStatusText('Error reading image file.');
    };

    reader.readAsDataURL(file);
  };

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleProcessImage(file);
    }
    e.target.value = '';
  };

  const handleAnyFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('text/') || file.name.endsWith('.txt')) {
      const reader = new FileReader();
      reader.onload = () => {
        setSourceText(reader.result as string);
        setStatusText(`Loaded text file: ${file.name}. Click Translate / Analyze.`);
      };
      reader.onerror = () => {
        setStatusText('Error reading text file.');
      };
      reader.readAsText(file);
    } else if (file.type.startsWith('image/')) {
      handleProcessImage(file);
    } else {
      setStatusText('Unsupported file format. Please upload a .txt file or an image.');
    }
    e.target.value = '';
  };

  const handleListen = async () => {
    if (!resultText || resultText === 'Translation will appear here…') {
      setStatusText('No translation available to listen to.');
      return;
    }

    // If currently playing, clicking again pauses audio
    if (isPlayingAudio && currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      } catch {
        // ignore
      }
      setIsPlayingAudio(false);
      setStatusText('Audio playback stopped.');
      return;
    }

    setIsPlayingAudio(true);
    setStatusText(`Generating voice audio in ${toLang}…`);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (customApiKey && customApiKey.trim().length >= 30) {
        headers['x-gemini-api-key'] = customApiKey.trim();
      }

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: resultText,
          lang: toLang,
        }),
      });

      const data = await parseSafeJson(res);
      if (!res.ok) {
        throw new Error(data.error || data.message || 'TTS server error');
      }

      if (!data.audioBase64) {
        throw new Error('No audio returned');
      }

      const audio = new Audio(`data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`);
      currentAudioRef.current = audio;

      audio.onplay = () => {
        setStatusText(`Playing translation in ${toLang}…`);
      };

      audio.onended = () => {
        setIsPlayingAudio(false);
        currentAudioRef.current = null;
        setStatusText('Finished playing.');
      };

      audio.onerror = () => {
        setIsPlayingAudio(false);
        currentAudioRef.current = null;
        setStatusText('Audio playback ended.');
      };

      await audio.play();
    } catch (err: any) {
      console.warn('Gemini TTS error, attempting browser SpeechSynthesis fallback:', err);
      if ('speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(resultText);
          const targetLangCode = LANGUAGE_SPEECH_MAP[toLang] || 'en-US';
          utterance.lang = targetLangCode;
          utterance.rate = 0.95;

          const voices = window.speechSynthesis.getVoices();
          if (voices && voices.length > 0) {
            const langPrefix = targetLangCode.split('-')[0].toLowerCase();
            const matchingVoice =
              voices.find((v) => v.lang.toLowerCase() === targetLangCode.toLowerCase()) ||
              voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix));
            if (matchingVoice) {
              utterance.voice = matchingVoice;
            }
          }

          utterance.onstart = () => {
            setStatusText(`Playing speech in ${toLang}…`);
          };

          utterance.onend = () => {
            setIsPlayingAudio(false);
            setStatusText('Finished speaking.');
          };

          utterance.onerror = () => {
            setIsPlayingAudio(false);
            setStatusText('Audio playback ended.');
          };

          window.speechSynthesis.speak(utterance);
          return;
        } catch {
          // ignore
        }
      }

      setIsPlayingAudio(false);
      setStatusText('Could not play speech.');
    }
  };

  const handleCopy = async () => {
    if (!resultText || resultText === 'Translation will appear here…') {
      setStatusText('No translation to copy.');
      return;
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(resultText);
        setStatusText('Copied result.');
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = resultText;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setStatusText('Copied result.');
      }
    } catch {
      setStatusText('Select and copy the result manually.');
    }
  };

  const handleShare = async () => {
    if (!resultText || resultText === 'Translation will appear here…') {
      setStatusText('No translation to share.');
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Language Translator',
          text: resultText,
        });
        setStatusText('Shared successfully.');
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setStatusText('Sharing failed or cancelled.');
        }
      }
    } else {
      try {
        await navigator.clipboard.writeText(resultText);
        setStatusText('Sharing is not supported; result copied to clipboard.');
      } catch {
        setStatusText('Sharing is not supported in this browser.');
      }
    }
  };

  const handleInstallClick = async () => {
    if (deferredPromptRef.current) {
      try {
        deferredPromptRef.current.prompt();
        const { outcome } = await deferredPromptRef.current.userChoice;
        if (outcome === 'accepted') {
          setStatusText('App installed successfully!');
        } else {
          setStatusText('Installation dismissed.');
        }
        deferredPromptRef.current = null;
      } catch {
        setStatusText('Installation failed or unsupported in this window.');
      }
      return;
    }

    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;

    if (isStandalone) {
      setStatusText('App is already installed and running in standalone mode.');
      return;
    }

    const isIOS = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
    if (isIOS) {
      setStatusText('To install on iOS: tap the Safari Share button, then tap "Add to Home Screen".');
      return;
    }

    setStatusText('PWA manifest and service worker are active. Use your browser menu to install this app.');
  };

  return (
    <>
      <div className="app">
        <header>
          <div className="logo" aria-hidden="true">A文</div>
          <div className="brand">
            <strong>Language Translator</strong>
            <small>Translation workspace</small>
          </div>
          <button
            className="iconbtn"
            id="theme"
            onClick={toggleTheme}
            aria-label="Toggle light and dark mode"
            title="Toggle theme"
          >
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
            </svg>
          </button>
          <button
            className="iconbtn"
            id="menu"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open settings"
            title="Settings"
          >
            <svg viewBox="0 0 24 24">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </header>

        <main>
          <div className="languages">
            <select
              id="from"
              aria-label="Source language"
              value={fromLang}
              onChange={(e) => setFromLang(e.target.value)}
            >
              <option>English</option>
              <option>Urdu</option>
              <option>Hindi</option>
              <option>Punjabi</option>
              <option>Arabic</option>
              <option>French</option>
              <option>Spanish</option>
            </select>
            <button
              className="swap"
              id="swap"
              onClick={handleSwap}
              aria-label="Swap languages"
              title="Swap languages"
            >
              ⇄
            </button>
            <select
              id="to"
              aria-label="Target language"
              value={toLang}
              onChange={(e) => setToLang(e.target.value)}
            >
              <option>Urdu</option>
              <option>English</option>
              <option>Hindi</option>
              <option>Punjabi</option>
              <option>Arabic</option>
              <option>French</option>
              <option>Spanish</option>
            </select>
          </div>

          <section className="panel">
            <textarea
              id="source"
              placeholder="Type or paste text here…"
              aria-label="Text to translate"
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
            />
            <div className="toolrow">
              <button
                className="tool"
                id="mic"
                onClick={handleMic}
                title="Speech input"
                style={isListening ? { borderColor: 'var(--green)', color: 'var(--green)', background: '#168f7020' } : undefined}
              >
                <svg viewBox="0 0 24 24">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
                </svg>
                <span>{isListening ? 'Listening… (Click to stop)' : 'Mic'}</span>
              </button>

              <button
                className="tool"
                id="camera"
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = 'image/*';
                  input.capture = 'environment';
                  input.onchange = (e: any) => handleProcessImage(e.target.files[0]);
                  input.click();
                }}
                title="Camera"
              >
                <svg viewBox="0 0 24 24">
                  <path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <span>Camera</span>
              </button>

              <button
                className="tool"
                id="image"
                onClick={() => imageFileInputRef.current?.click()}
                title="Choose image"
              >
                <svg viewBox="0 0 24 24">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                  <path d="M14 2v6h6M8 13h8M8 17h8" />
                </svg>
                <span>Image</span>
              </button>

              <button
                className="tool"
                id="file"
                onClick={() => anyFileInputRef.current?.click()}
                title="Upload file"
              >
                <svg viewBox="0 0 24 24">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                  <path d="M14 2v6h6M8 13h8M8 17h8" />
                </svg>
                <span>File</span>
              </button>

              <button
                className="tool"
                id="paste"
                onClick={handlePaste}
                title="Paste from clipboard"
              >
                <svg viewBox="0 0 24 24">
                  <rect x="8" y="3" width="12" height="17" rx="2" />
                  <path d="M16 3V2H6a2 2 0 0 0-2 2v14h4M11 8h6M11 12h6M11 16h4" />
                </svg>
                <span>Paste</span>
              </button>

              <button className="tool clear" id="clear" onClick={handleClear}>
                Clear
              </button>

              <input
                type="file"
                id="imageFile"
                ref={imageFileInputRef}
                accept="image/*"
                onChange={handleImageFileChange}
              />
              <input
                type="file"
                id="anyFile"
                ref={anyFileInputRef}
                accept="image/*,.txt"
                onChange={handleAnyFileChange}
              />
            </div>
          </section>

          <button
            className="primary"
            id="translate"
            onClick={handleTranslate}
            disabled={isTranslating}
          >
            {isTranslating ? 'Translating…' : 'Translate / Analyze'}
          </button>

          <section className="panel">
            <div className="resulthead">
              <strong>Translation result</strong>
              <div className="resulttools">
                <button
                  className="iconbtn"
                  id="listen"
                  onClick={handleListen}
                  title="Listen to result"
                  aria-label="Listen"
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M4 10v4h4l5 4V6l-5 4H4Z" />
                    <path d="M17 9a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12" />
                  </svg>
                </button>
                <button
                  className="iconbtn"
                  id="copy"
                  onClick={handleCopy}
                  title="Copy result"
                  aria-label="Copy"
                >
                  <svg viewBox="0 0 24 24">
                    <rect x="8" y="8" width="13" height="13" rx="2" />
                    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                  </svg>
                </button>
                <button
                  className="iconbtn"
                  id="share"
                  onClick={handleShare}
                  title="Share result"
                  aria-label="Share"
                >
                  <svg viewBox="0 0 24 24">
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <path d="m8.7 10.7 6.6-4.4m-6.6 9 6.6 2.9" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="resulttext" id="result">
              {resultText}
            </div>
          </section>

          <div className="status" id="status" role="status">
            {statusText}
          </div>

          <div
            className="app-description"
            style={{
              marginTop: '14px',
              fontSize: '13px',
              lineHeight: '1.6',
              color: 'var(--muted)',
            }}
          >
            This is an online English and Urdu translator. You can type text and get the translation instantly. Press the mic button to translate by speaking. Take a photo with the camera to translate the text in it. Upload an image or a file to translate its content. You can listen to the translation with the audio button. Copy the translation easily and use it anywhere. You can also share it with others using the share button.
          </div>
        </main>

        <div className="footer">Language Translator · Connected & Functional</div>
      </div>

      <div
        className={`shade ${drawerOpen ? 'show' : ''}`}
        id="shade"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setDrawerOpen(false);
          }
        }}
      >
        <aside className="drawer">
          <div className="drawerhead">
            <span>⚙ Settings</span>
            <button
              className="iconbtn"
              id="close"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close settings"
            >
              ×
            </button>
          </div>

          <label className="label" htmlFor="appLanguage">
            App language
          </label>
          <select
            id="appLanguage"
            value={appLanguage}
            onChange={(e) => setAppLanguage(e.target.value)}
          >
            <option>English</option>
            <option>Urdu</option>
            <option>Hindi</option>
          </select>

          <label className="label">Install App (PWA)</label>
          <button className="install" id="install" onClick={handleInstallClick}>
            Install App
          </button>

          <label className="label">Gemini AI Model Versions</label>
          <div className="model-list" id="models">
            {MODEL_OPTIONS.map((m, idx) => (
              <button
                key={`${m.id}-${m.label}-${idx}`}
                type="button"
                className={selectedModelIndex === idx ? 'active' : ''}
                onClick={() => {
                  setSelectedModelIndex(idx);
                  setStatusText(`Selected model: ${m.label}`);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          <p className="note">
            Your Google AI Studio Gemini API key is securely connected on the server.
          </p>

          <label className="label">App Info</label>
          <div className="note">Language Translator · Connected & Functional</div>
        </aside>
      </div>
    </>
  );
}
