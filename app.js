import release from './release-config.js';
import { normalizeAccessCode } from './src/shared/access-code.js';
import { canonicalJson } from './src/shared/canonical-json.js';
import {
  createPortableBundle, createPortableReceipt,
} from './src/portable/bundle.js';
import {
  createPortableSession, isCorrectComprehensionChoice, reducePortableSession,
  validatePortablePrompt, validatePortableSession,
} from './src/portable/model.js';
import {
  decodePortableBase64, decodePortableUtf8, derivePortableKey, encodePortableBase64,
  openPortableEnvelope, sealPortableEnvelope,
} from './src/portable/secure-envelope.js';
import { openPortableStore } from './src/portable/storage.js';

const encoder = new TextEncoder();
const shell = document.querySelector('#shell');
const app = document.querySelector('#app');
const codeInput = document.querySelector('#access-code');
const shellStatus = document.querySelector('#shell-status');
const toggleCode = document.querySelector('#toggle-code');
const unlockButton = document.querySelector('#unlock');

let prompt = null;
let session = null;
let store = null;
let recordKey = null;
let usedIvs = new Set();
let mediaRecorder = null;
let mediaStream = null;
let recordingTimer = null;
let recordingStopPromise = null;
let resolveRecordingStop = null;
let chunkPersistence = Promise.resolve();
let recordingWriteFailed = false;
let stopPartial = false;
let pendingTake = null;
let pendingExport = null;
let feedback = '';
let autosaveStatus = '';
let renderedPhase = null;
let renderedQuestionIndex = null;

const randomIv = () => {
  for (;;) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const token = encodePortableBase64(iv);
    if (!usedIvs.has(token)) { usedIvs.add(token); return iv; }
  }
};
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (label, handler, className = '') => {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await handler(); }
    catch { feedback = prompt?.ui?.generic_failure ?? release.public_shell.generic_unlock_failure; render(); }
    finally { if (node.isConnected) node.disabled = false; }
  });
  return node;
};
const row = (...children) => {
  const node = element('div', undefined, 'button-row');
  node.append(...children);
  return node;
};
const download = (bytes, filename, type) => {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.rel = 'noopener'; anchor.click();
  } finally { URL.revokeObjectURL(url); }
};
const stateHeader = () => ({ envelope_version: 1, release_id: release.release_id, object_id: 'state', object_kind: 'STATE' });
const audioHeader = (objectId) => ({ envelope_version: 1, release_id: release.release_id, object_id: objectId, object_kind: 'AUDIO' });
const draftHeader = (objectId) => ({ envelope_version: 1, release_id: release.release_id, object_id: objectId, object_kind: 'DRAFT_CHUNK' });
const sealState = async (next) => {
  const value = structuredClone(next); value.updated_at = new Date().toISOString();
  validatePortableSession(value, prompt);
  const envelope = await sealPortableEnvelope({ key: recordKey, header: stateHeader(), plaintext: encoder.encode(canonicalJson(value)), iv: randomIv() });
  return { value, envelope };
};
const commitState = async (next, { puts = [], deletes = [] } = {}) => {
  const sealed = await sealState(next);
  await store.commit({ puts: [...puts, { key: 'state', value: sealed.envelope }], deletes });
  session = sealed.value; pendingExport = null;
};
const persistState = async (next) => {
  await commitState(next); setAutosaveStatus(prompt.ui.saved_locally);
};
const setAutosaveStatus = (value) => {
  autosaveStatus = value;
  const node = document.querySelector('#autosave-status');
  if (node) node.textContent = value;
};
const clearPendingTake = () => {
  if (pendingTake?.url) URL.revokeObjectURL(pendingTake.url);
  pendingTake = null;
};
const stopTracks = () => { mediaStream?.getTracks?.().forEach((track) => track.stop()); mediaStream = null; };
const draftKeys = () => (session?.draft_recording?.chunk_object_ids ?? []).map((objectId) => `draft:${objectId}`);
const chooseMime = () => ['audio/webm;codecs=opus', 'audio/webm'].find((value) => MediaRecorder.isTypeSupported?.(value)) ?? '';

const hydrateDraft = async () => {
  const draft = session?.draft_recording;
  if (!draft || draft.chunk_object_ids.length === 0) throw new Error('RA_PORTABLE_DRAFT_EMPTY');
  const chunks = [];
  let totalBytes = 0;
  try {
    for (const objectId of draft.chunk_object_ids) {
      const envelope = await store.read(`draft:${objectId}`);
      if (!envelope) throw new Error('RA_PORTABLE_DRAFT_MISSING');
      const bytes = await openPortableEnvelope({ key: recordKey, envelope, expectedHeader: draftHeader(objectId) });
      if (bytes.length < 1) throw new Error('RA_PORTABLE_DRAFT_EMPTY_CHUNK');
      totalBytes += bytes.length; chunks.push(bytes);
    }
    const blob = new Blob(chunks, { type: draft.mime_type });
    if (blob.size !== totalBytes || blob.size !== draft.total_bytes || blob.size > 2_000_000) throw new Error('RA_PORTABLE_DRAFT_SIZE');
    clearPendingTake();
    pendingTake = { blob, partial: draft.partial || draft.status === 'RECORDING', url: URL.createObjectURL(blob) };
  } finally { chunks.forEach((bytes) => bytes.fill(0)); }
};

const discardDraft = async ({ renderAfter = true } = {}) => {
  if (!session?.draft_recording) return;
  const deletes = draftKeys();
  const next = reducePortableSession(session, { type: 'DRAFT_CLEAR' }, prompt);
  await commitState(next, { deletes });
  clearPendingTake(); setAutosaveStatus(prompt.ui.draft_deleted); feedback = '';
  if (renderAfter) render();
};

const enqueueDraftChunk = (blob) => {
  if (!blob?.size) return;
  chunkPersistence = chunkPersistence.then(async () => {
    if (recordingWriteFailed) return;
    const objectId = crypto.randomUUID();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      const envelope = await sealPortableEnvelope({ key: recordKey, header: draftHeader(objectId), plaintext: bytes, iv: randomIv() });
      const next = reducePortableSession(session, { type: 'DRAFT_APPEND', objectId, byteLength: bytes.length }, prompt);
      await commitState(next, { puts: [{ key: `draft:${objectId}`, value: envelope }] });
      setAutosaveStatus(prompt.ui.draft_saved);
    } finally { bytes.fill(0); }
  }).catch(() => {
    recordingWriteFailed = true; feedback = prompt.ui.generic_failure;
    if (mediaRecorder?.state === 'recording') void stopRecording(true);
  });
};

const finalizeRecording = async () => {
  clearTimeout(recordingTimer); stopTracks();
  try {
    await chunkPersistence;
    if (!session?.draft_recording?.chunk_object_ids.length) {
      if (session?.draft_recording) await discardDraft({ renderAfter: false });
      feedback = prompt.ui.generic_failure;
    } else {
      if (session.draft_recording.status === 'RECORDING') {
        await persistState(reducePortableSession(session, { type: 'DRAFT_STOP', partial: stopPartial || recordingWriteFailed }, prompt));
      }
      await hydrateDraft();
      feedback = recordingWriteFailed ? prompt.ui.recording_stopped : '';
      setAutosaveStatus(prompt.ui.draft_saved);
    }
  } catch { feedback = prompt.ui.generic_failure; }
  finally {
    mediaRecorder = null; recordingTimer = null;
    const resolve = resolveRecordingStop; resolveRecordingStop = null; resolve?.();
    render();
  }
};

const stopRecording = (partial = false) => {
  stopPartial ||= partial;
  if (mediaRecorder?.state === 'recording') {
    try { mediaRecorder.requestData?.(); } catch {}
    mediaRecorder.stop();
  }
  return recordingStopPromise ?? Promise.resolve();
};

const startRecording = async () => {
  feedback = '';
  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') throw new Error();
    if (session.draft_recording) throw new Error();
    clearPendingTake();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    const mimeType = chooseMime();
    const recorderOptions = { audioBitsPerSecond: 24_000 };
    if (mimeType) recorderOptions.mimeType = mimeType;
    mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);
    const effectiveMime = mediaRecorder.mimeType || mimeType || 'audio/webm';
    await persistState(reducePortableSession(session, {
      type: 'DRAFT_BEGIN', questionId: prompt.questions[session.question_index].id, mimeType: effectiveMime,
    }, prompt));
    chunkPersistence = Promise.resolve(); recordingWriteFailed = false; stopPartial = false;
    recordingStopPromise = new Promise((resolve) => { resolveRecordingStop = resolve; });
    mediaRecorder.addEventListener('dataavailable', (event) => enqueueDraftChunk(event.data));
    mediaRecorder.addEventListener('stop', () => { void finalizeRecording(); }, { once: true });
    mediaRecorder.addEventListener('error', () => { recordingWriteFailed = true; feedback = prompt.ui.generic_failure; void stopRecording(true); }, { once: true });
    mediaRecorder.start(1000);
    recordingTimer = setTimeout(() => stopRecording(true), 480_000);
    setAutosaveStatus(prompt.ui.recording_status);
    render();
  } catch {
    stopTracks(); mediaRecorder = null;
    if (session?.draft_recording) { try { await discardDraft({ renderAfter: false }); } catch {} }
    feedback = prompt.ui.microphone_denied; render();
  }
};

const commitDisposition = async (disposition, audioObjectId = null) => {
  const question = prompt.questions[session.question_index];
  const next = reducePortableSession(session, { type: 'RESPONSE_COMMIT', questionId: question.id, disposition, audioObjectId }, prompt);
  await persistState(next); feedback = prompt.ui.saved_locally; render();
};
const acceptRecording = async () => {
  if (!pendingTake?.blob || !session.draft_recording) return;
  const deletes = draftKeys();
  const objectId = crypto.randomUUID();
  const audioBytes = new Uint8Array(await pendingTake.blob.arrayBuffer());
  const audioEnvelope = await sealPortableEnvelope({ key: recordKey, header: audioHeader(objectId), plaintext: audioBytes, iv: randomIv() });
  audioBytes.fill(0);
  const question = prompt.questions[session.question_index];
  const cleared = reducePortableSession(session, { type: 'DRAFT_CLEAR' }, prompt);
  const next = reducePortableSession(cleared, { type: 'RESPONSE_COMMIT', questionId: question.id, disposition: 'RECORDED', audioObjectId: objectId }, prompt);
  const stateEnvelope = await sealState(next);
  await store.commit({ puts: [{ key: `audio:${objectId}`, value: audioEnvelope }, { key: 'state', value: stateEnvelope.envelope }], deletes });
  session = stateEnvelope.value; pendingExport = null; clearPendingTake(); feedback = prompt.ui.saved_locally; render();
};
const prepareExport = async () => {
  if (session.draft_recording || mediaRecorder?.state === 'recording') throw new Error('RA_PORTABLE_EXPORT_DRAFT');
  const records = (await store.entries()).filter((item) => item.key === 'state' || item.key.startsWith('audio:'));
  if (!records.some((item) => item.key === 'state')) throw new Error('RA_PORTABLE_EXPORT_EMPTY');
  const createdAt = new Date().toISOString();
  const bundleBytes = createPortableBundle({
    releaseId: release.release_id, kdf: release.kdf, promptEnvelope: release.prompt_envelope,
    records, createdAt,
  });
  const receipt = await createPortableReceipt({ bundleBytes, releaseId: release.release_id, createdAt });
  pendingExport = {
    bundleBytes, receiptBytes: receipt.bytes,
    bundleName: `van-interview-${release.release_id}.ract.json`,
    receiptName: `van-interview-${release.release_id}.receipt.json`,
  };
  feedback = '';
  render();
};
const downloadPrepared = (kind) => {
  if (!pendingExport || !['bundle','receipt'].includes(kind)) throw new Error('RA_PORTABLE_EXPORT_NOT_PREPARED');
  if (kind === 'bundle') download(pendingExport.bundleBytes, pendingExport.bundleName, 'application/json');
  else download(pendingExport.receiptBytes, pendingExport.receiptName, 'application/json');
};

const renderConsent = (main) => {
  main.append(element('h2', prompt.ui.consent_heading));
  for (const item of prompt.consent) main.append(element('p', item.text));
  const allAffirmed = Object.values(session.affirmations).every(Boolean);
  for (const item of prompt.affirmations) {
    const label = element('label', undefined, 'check-row');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = session.affirmations[item.id]; input.disabled = input.checked;
    input.addEventListener('change', async () => { await persistState(reducePortableSession(session, { type: 'AFFIRM', affirmationId: item.id }, prompt)); render(); });
    label.append(input, element('span', item.text)); main.append(label);
  }
  if (allAffirmed && session.phase === 'CONSENT') {
    const card = prompt.comprehension_cards.find((item) => session.comprehension[item.id] === null);
    main.append(element('h3', card.text));
    for (const choice of card.choices) main.append(button(choice.text, async () => {
      if (!isCorrectComprehensionChoice(prompt, card.id, choice.id)) { feedback = card.incorrect_explanation; render(); return; }
      await persistState(reducePortableSession(session, { type: 'COMPREHENSION_ANSWER', cardId: card.id, choiceId: choice.id }, prompt)); feedback = ''; render();
    }, 'choice'));
  }
  if (session.phase === 'CONSENT_READY') main.append(row(
    button(prompt.ui.consent_decline, async () => { await store.clear(); location.reload(); }),
    button(prompt.ui.consent_continue, async () => { await persistState(reducePortableSession(session, { type: 'CONSENT_COMMIT' }, prompt)); render(); }, 'primary'),
  ));
};

const renderQuestion = (main) => {
  const question = prompt.questions[session.question_index];
  const progress = element('div', undefined, 'progress');
  progress.append(element('span', question.section_label), element('span', question.progress_label));
  main.append(progress);
  const card = element('section', undefined, 'content question');
  card.append(element('h2', question.opening));
  const followups = element('ul', undefined, 'followups');
  for (const value of question.followups) followups.append(element('li', value));
  card.append(followups, element('p', prompt.ui.no_medical_advice, 'notice'), element('p', prompt.ui.not_evidence, 'muted'));
  if (mediaRecorder?.state === 'recording') card.append(row(button(prompt.ui.stop_recording, () => stopRecording(false), 'primary')));
  else if (pendingTake?.blob) {
    card.append(element('p', prompt.ui.recording_stopped, 'saved-status'));
    const audio = document.createElement('audio'); audio.controls = true; audio.src = pendingTake.url; card.append(audio);
    card.append(row(button(prompt.ui.retry_recording, discardDraft), button(prompt.ui.keep_recording, acceptRecording, 'primary')));
    card.append(button(prompt.ui.delete_draft, discardDraft, 'danger'));
  } else {
    card.append(row(button(prompt.ui.start_recording, startRecording, 'primary')));
    for (const control of prompt.nonresponse_controls) {
      const disposition = {
        'NONRESPONSE:PREFER_NOT': 'PREFER_NOT_TO_ANSWER', 'NONRESPONSE:DO_NOT_KNOW': 'DO_NOT_KNOW',
        'NONRESPONSE:VERIFY_LATER': 'VERIFY_LATER', 'NONRESPONSE:NOT_APPLICABLE': 'NOT_APPLICABLE',
        'NONRESPONSE:SKIP_TOPIC': 'SKIP_TOPIC',
      }[control.id];
      card.append(button(control.text, () => commitDisposition(disposition), 'choice'));
    }
  }
  main.append(card);
};

const renderComplete = (main) => {
  main.append(element('h2', prompt.ui.finish));
  main.append(element('p', prompt.ui.no_medical_advice, 'notice'));
};
const renderExportControls = (main) => {
  if (!pendingExport) { main.append(row(button(prompt.ui.export_files, prepareExport, 'primary'))); return; }
  main.append(element('p', prompt.ui.return_code_warning, 'notice'));
  main.append(row(
    button(prompt.ui.download_bundle, () => downloadPrepared('bundle'), 'primary'),
    button(prompt.ui.download_receipt, () => downloadPrepared('receipt'), 'primary'),
  ));
};

const render = () => {
  if (!prompt || !session) return;
  const contextChanged = renderedPhase !== session.phase || renderedQuestionIndex !== session.question_index;
  app.replaceChildren();
  const header = element('header', undefined, 'app-header');
  const headerContent = element('div', undefined, 'header-content');
  const saved = element('p', autosaveStatus, 'autosave-status');
  saved.id = 'autosave-status'; saved.setAttribute('role', 'status'); saved.setAttribute('aria-live', 'polite');
  headerContent.append(element('h1', prompt.ui.title), saved); header.append(headerContent);
  const main = element('main', undefined, 'content');
  if (session.phase === 'CONSENT' || session.phase === 'CONSENT_READY') renderConsent(main);
  else if (session.phase === 'INTERVIEW') renderQuestion(main);
  else renderComplete(main);
  if (session.phase === 'INTERVIEW' || session.phase === 'COMPLETE') {
    renderExportControls(main);
    main.append(row(button(prompt.ui.save_exit, async () => { await stopRecording(true); location.reload(); })));
  }
  main.append(button(prompt.ui.delete_local, async () => { if (confirm(prompt.ui.delete_local)) { await store.clear(); location.reload(); } }, 'danger'));
  if (feedback) main.append(element('p', feedback, 'notice'));
  app.append(header, main); app.hidden = false; shell.hidden = true;
  renderedPhase = session.phase; renderedQuestionIndex = session.question_index;
  if (contextChanged) {
    scrollTo(0, 0);
    const contextHeading = main.querySelector('h2');
    if (contextHeading) { contextHeading.tabIndex = -1; contextHeading.focus({ preventScroll: true }); }
  }
};

const unlock = async () => {
  shellStatus.textContent = release.public_shell.generic_unlock_failure;
  let normalized;
  try {
    normalized = await normalizeAccessCode(codeInput.value);
    const salt = decodePortableBase64(release.kdf.salt_b64);
    const promptKey = await derivePortableKey({ passwordBytes: normalized.passwordBytes, salt, iterations: release.kdf.iterations, domain: 'PROMPT' });
    recordKey = await derivePortableKey({ passwordBytes: normalized.passwordBytes, salt, iterations: release.kdf.iterations, domain: 'RECORD' });
    const promptBytes = await openPortableEnvelope({ key: promptKey, envelope: release.prompt_envelope, expectedHeader: release.prompt_envelope.header });
    prompt = validatePortablePrompt(JSON.parse(decodePortableUtf8(promptBytes)));
    if (canonicalJson(prompt) !== decodePortableUtf8(promptBytes)) throw new Error();
    store = await openPortableStore(release.release_id);
    const records = await store.entries(); usedIvs = new Set(records.map((item) => item.envelope?.iv_b64).filter(Boolean));
    const sealedState = records.find((item) => item.key === 'state')?.envelope ?? null;
    if (sealedState) {
      const stateBytes = await openPortableEnvelope({ key: recordKey, envelope: sealedState, expectedHeader: stateHeader() });
      session = validatePortableSession(JSON.parse(decodePortableUtf8(stateBytes)), prompt);
      if (canonicalJson(session) !== decodePortableUtf8(stateBytes)) throw new Error();
    } else session = createPortableSession({ releaseId: release.release_id, prompt });
    if (session.draft_recording) {
      if (session.draft_recording.chunk_object_ids.length === 0) await discardDraft({ renderAfter: false });
      else {
        if (session.draft_recording.status === 'RECORDING') {
          await persistState(reducePortableSession(session, { type: 'DRAFT_STOP', partial: true }, prompt));
        }
        await hydrateDraft(); autosaveStatus = prompt.ui.draft_saved; feedback = prompt.ui.resume;
      }
    }
    try { await navigator.storage?.persist?.(); } catch {}
    codeInput.value = ''; shellStatus.textContent = release.public_shell.saved_and_locked_status; render();
  } catch { prompt = null; session = null; recordKey = null; shellStatus.textContent = release.public_shell.generic_unlock_failure; }
  finally { normalized?.passwordBytes?.fill(0); }
};

toggleCode.addEventListener('click', () => {
  codeInput.type = codeInput.type === 'password' ? 'text' : 'password';
  toggleCode.textContent = codeInput.type === 'password' ? release.public_shell.show_access_code_control : release.public_shell.hide_access_code_control;
});
unlockButton.addEventListener('click', unlock);
codeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') void unlock(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && mediaRecorder?.state === 'recording') stopRecording(true); });
addEventListener('pagehide', () => { if (mediaRecorder?.state === 'recording') void stopRecording(true); }, { once: true });
addEventListener('beforeunload', () => { clearTimeout(recordingTimer); stopTracks(); clearPendingTake(); }, { once: true });

for (const [key, value] of Object.entries(release.public_shell)) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`RA_PORTABLE_SHELL_INVALID:${key}`);
}
