// Free AI options. Gemini and Groq have free API tiers; Ollama runs fully locally.
export const PROVIDERS = {
  gemini: { label: 'Google Gemini (free tier)', model: 'gemini-2.5-flash', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey' },
  groq: { label: 'Groq (free tier)', model: 'llama-3.3-70b-versatile', needsKey: true, keyUrl: 'https://console.groq.com/keys' },
  ollama: { label: 'Ollama (local, no key)', model: 'llama3.1', needsKey: false, keyUrl: 'https://ollama.com/download' },
};

export async function askAI({ provider, key, model }, prompt) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('Pick an AI provider in Settings');
  if (p.needsKey && !key) throw new Error(`Add your free ${p.label} API key in Settings first`);
  model = model || p.model;

  if (provider === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4 } }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'Gemini error ' + r.status);
    return j.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') || '(empty response)';
  }
  if (provider === 'groq') {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, temperature: 0.4, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'Groq error ' + r.status);
    return j.choices?.[0]?.message?.content || '(empty response)';
  }
  if (provider === 'ollama') {
    let r;
    try {
      r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
    } catch {
      throw new Error('Could not reach Ollama on localhost:11434. Is it running? (`ollama serve`)');
    }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Ollama error ' + r.status);
    return j.response;
  }
}
