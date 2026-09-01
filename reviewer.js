import { normalizeAccessCode } from './src/shared/access-code.js';
import { canonicalJson } from './src/shared/canonical-json.js';
import { parsePortableBundle, verifyPortableReceipt } from './src/portable/bundle.js';
import { validatePortablePrompt, validatePortableSession } from './src/portable/model.js';
import { decodePortableBase64, decodePortableUtf8, derivePortableKey, openPortableEnvelope } from './src/portable/secure-envelope.js';

const bundleInput = document.querySelector('#bundle');
const receiptInput = document.querySelector('#receipt');
const codeInput = document.querySelector('#review-code');
const status = document.querySelector('#review-status');
const results = document.querySelector('#review-results');
const urls = new Set();
const stateHeader = (releaseId) => ({ envelope_version: 1, release_id: releaseId, object_id: 'state', object_kind: 'STATE' });
const audioHeader = (releaseId, objectId) => ({ envelope_version: 1, release_id: releaseId, object_id: objectId, object_kind: 'AUDIO' });
const bytesFromFile = async (input) => new Uint8Array(await input.files[0].arrayBuffer());
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };

document.querySelector('#open-review').addEventListener('click', async () => {
  results.replaceChildren(); status.textContent = 'The files or access code could not be verified.';
  let normalized;
  try {
    if (!bundleInput.files?.[0] || !receiptInput.files?.[0]) throw new Error();
    const bundleBytes = await bytesFromFile(bundleInput);
    const receiptBytes = await bytesFromFile(receiptInput);
    await verifyPortableReceipt({ bundleBytes, receiptBytes });
    const bundle = parsePortableBundle(bundleBytes);
    normalized = await normalizeAccessCode(codeInput.value);
    const salt = decodePortableBase64(bundle.kdf.salt_b64);
    const promptKey = await derivePortableKey({ passwordBytes: normalized.passwordBytes, salt, iterations: bundle.kdf.iterations, domain: 'PROMPT' });
    const recordKey = await derivePortableKey({ passwordBytes: normalized.passwordBytes, salt, iterations: bundle.kdf.iterations, domain: 'RECORD' });
    const promptBytes = await openPortableEnvelope({ key: promptKey, envelope: bundle.prompt_envelope, expectedHeader: bundle.prompt_envelope.header });
    const prompt = validatePortablePrompt(JSON.parse(decodePortableUtf8(promptBytes)));
    if (canonicalJson(prompt) !== decodePortableUtf8(promptBytes)) throw new Error();
    const stateRecord = bundle.records.find((item) => item.key === 'state');
    if (!stateRecord) throw new Error();
    const stateBytes = await openPortableEnvelope({ key: recordKey, envelope: stateRecord.envelope, expectedHeader: stateHeader(bundle.release_id) });
    const session = validatePortableSession(JSON.parse(decodePortableUtf8(stateBytes)), prompt);
    if (canonicalJson(session) !== decodePortableUtf8(stateBytes)) throw new Error();
    results.append(element('h2', prompt.ui.participant_summary));
    for (const response of session.responses) {
      const question = prompt.questions.find((item) => item.id === response.question_id);
      const section = element('section'); section.className = 'content question';
      section.append(element('h3', question.opening), element('p', response.disposition));
      if (response.audio_object_id) {
        const record = bundle.records.find((item) => item.key === `audio:${response.audio_object_id}`);
        if (!record) throw new Error();
        const audioBytes = await openPortableEnvelope({ key: recordKey, envelope: record.envelope, expectedHeader: audioHeader(bundle.release_id, response.audio_object_id) });
        const url = URL.createObjectURL(new Blob([audioBytes], { type: 'audio/webm' })); urls.add(url);
        const audio = document.createElement('audio'); audio.controls = true; audio.src = url; section.append(audio);
      }
      results.append(section);
    }
    status.textContent = `Verified ${session.responses.length} encrypted response records locally.`;
    codeInput.value = '';
  } catch { results.replaceChildren(); }
  finally { normalized?.passwordBytes?.fill(0); }
});

addEventListener('beforeunload', () => { for (const url of urls) URL.revokeObjectURL(url); }, { once: true });
