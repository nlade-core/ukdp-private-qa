// Chrome's built-in model (Gemini Nano, Prompt API), used for exactly two
// things: choosing a provision from a numbered list (retrieval.js asks), and
// writing an answer from the provision text it's given. Nothing here touches
// the network -- the model runs on this device.
import { PICK_SYSTEM_PROMPT, pickPrompt, parsePick } from './retrieval.js';

const IO = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

// 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'missing'
export async function modelStatus() {
  if (!self.LanguageModel) return 'missing';
  try { return await withTimeout(LanguageModel.availability(IO), 5000); } catch { return 'unavailable'; }
}

// A throwaway session per pick keeps the answer session's context clean.
export async function pickModel(question, candidates) {
  let session;
  try {
    session = await withTimeout(LanguageModel.create({ initialPrompts: [{ role: 'system', content: PICK_SYSTEM_PROMPT }], ...IO }), 10000);
    const text = pickPrompt(question, candidates);
    let raw;
    try {
      raw = await withTimeout(session.prompt(text, { responseConstraint: { type: 'integer', minimum: 0, maximum: candidates.length } }), 10000);
    } catch (e) {
      if (e && e.message === 'timed out') throw e;
      raw = await withTimeout(session.prompt(text), 10000); // a build that rejects the constraint still gets a pick
    }
    return parsePick(raw, candidates.length);
  } catch (e) {
    console.warn('[ukdp] provision pick failed --', e);
    return null;
  } finally {
    try { session && session.destroy(); } catch {}
  }
}

const ANSWER_SYSTEM_PROMPT = 'You answer questions about UK data protection law using ONLY the provision text you are given. '
  + 'Cite the provision by its reference (for example "UK GDPR Art. 6(1)(f)"). If the text does not answer the question, say so plainly instead of guessing. '
  + 'Be concise: a short direct answer, then the key conditions if there are any. This is general information, not legal advice.';

export async function answer(question, provision, { onChunk, onDownload, signal } = {}) {
  const session = await LanguageModel.create({
    initialPrompts: [{ role: 'system', content: ANSWER_SYSTEM_PROMPT }], ...IO,
    monitor(m) { m.addEventListener('downloadprogress', (e) => onDownload && onDownload(e.loaded)); },
  });
  try {
    const input = 'Provision: ' + provision.ref + ' — ' + provision.title + '\n' + provision.text + '\n\nQuestion: ' + question;
    let out = '';
    for await (const chunk of session.promptStreaming(input, { signal })) {
      out += chunk;
      if (onChunk) onChunk(out);
    }
    return out;
  } finally {
    try { session.destroy(); } catch {}
  }
}
