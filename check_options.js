const MODEL_OPTIONS = [
  { label: 'Gemini Flash — fast', id: 'gemini-flash-lite-latest' },
  { label: 'Gemini Pro — advanced', id: 'gemini-3.5-flash-lite' },
  { label: 'Other configured model', id: 'gemini-3-flash-preview' },
];
const ids = MODEL_OPTIONS.map(m => m.id);
const uniqueIds = new Set(ids);
console.log('Original IDs:', ids);
console.log('Unique IDs:', uniqueIds.size);
