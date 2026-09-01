const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DISPOSITIONS = new Set(['RECORDED', 'PREFER_NOT_TO_ANSWER', 'DO_NOT_KNOW', 'VERIFY_LATER', 'NOT_APPLICABLE', 'SKIP_TOPIC']);
const clone = (value) => structuredClone(value);
const fail = () => { throw new Error('RA_PORTABLE_MODEL_INVALID'); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const literalIndex = (copy) => {
  const result = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.copy_id === 'string' && typeof value.text === 'string') result.set(value.copy_id, value.text);
    Object.values(value).forEach(visit);
  };
  visit(copy);
  return result;
};
const sectionFor = (topicId) => topicId.startsWith('SOURCE-') ? 1
  : topicId.startsWith('CONCEPTION-') ? 2
    : topicId.startsWith('WORKFLOW-') ? 3 : 4;
const template = (copy, copyId, values) => {
  const record = copy.participant_projection_templates.find((item) => item.copy_id === copyId);
  if (!record) fail();
  let rendered = record.template;
  for (const placeholder of record.placeholders) {
    if (!Object.hasOwn(values, placeholder.name)) fail();
    rendered = rendered.replace(`{${placeholder.name}}`, String(values[placeholder.name]));
  }
  if (/\{[a-z0-9_]+\}/u.test(rendered)) fail();
  return rendered;
};

export const projectPortablePrompt = (promptBank, sourceTranscript) => {
  if (!promptBank || promptBank.artifact_id !== 'RA-PROMPT-BANK-V3' || promptBank.schema_version !== '3'
    || !Array.isArray(promptBank.topics) || promptBank.topics.length !== 51
    || !Array.isArray(promptBank.coverage_items) || promptBank.coverage_items.length !== 218
    || !sourceTranscript || !Array.isArray(sourceTranscript.spans) || sourceTranscript.spans.length !== 8) fail();
  const copy = promptBank.participant_copy;
  const literals = literalIndex(copy);
  const questions = promptBank.topics.map((topic, index) => {
    const copyTopic = copy.topics.find((item) => item.id === topic.id);
    if (!copyTopic?.opening?.text) fail();
    const followups = copy.coverage_items.filter((item) => item.topic_id === topic.id).map((item) => item.probe.text);
    return {
      id: topic.id, number: index + 1, section: sectionFor(topic.id),
      section_label: template(copy, 'RUNTIME_TEMPLATE:CAI-048', { section_index_plus_one: String(sectionFor(topic.id)) }),
      progress_label: template(copy, 'TOPIC_PROGRESS_V2', { completed_count: String(index + 1), total_count: '51' }),
      opening: copyTopic.opening.text, followups,
    };
  });
  if (questions.flatMap((item) => item.followups).length !== 218) fail();
  const uiIds = {
    title: 'RUNTIME:CAI-066', consent_heading: 'RUNTIME:CAI-065', participant_summary: 'RUNTIME:CAI-062',
    start_recording: 'UI:START_RECORDING', stop_recording: 'UI:STOP_RECORDING', playback: 'RUNTIME:CAI-006',
    rerecord: 'RUNTIME:CAI-008', accept_recording: 'RUNTIME:CAI-009', save_exit: 'UI:SAVE_EXIT',
    export_files: 'UI:EXPORT_CREATE', delete_local: 'UI:DELETE_LOCAL_CONFIRM', finish: 'UI:FINISH',
    consent_decline: 'UI:CONSENT_DECLINE', consent_continue: 'UI:CONSENT_CONTINUE',
    saved_locally: 'UI:SAVED_LOCALLY',
    draft_saved: 'UI:DRAFT_SAVED', recording_status: 'UI:RECORDING_STATUS',
    recording_stopped: 'UI:RECORDING_STOPPED', retry_recording: 'UI:RETRY_RECORDING',
    keep_recording: 'UI:KEEP_RECORDING', delete_draft: 'UI:DELETE_DRAFT',
    draft_deleted: 'UI:DRAFT_DELETED', resume: 'UI:RESUME',
    download_bundle: 'UI:DOWNLOAD_BUNDLE', download_receipt: 'UI:DOWNLOAD_RECEIPT',
    return_code_warning: 'UI:RETURN_CODE_WARNING',
    generic_failure: 'RUNTIME:CAI-110', microphone_denied: 'UI:MICROPHONE_DENIED',
    no_medical_advice: 'UI:NO_MEDICAL_ADVICE', not_evidence: 'UI:NOT_EVIDENCE',
  };
  const ui = Object.fromEntries(Object.entries(uiIds).map(([name, copyId]) => [name, literals.get(copyId)]));
  if (Object.values(ui).some((value) => typeof value !== 'string')) fail();
  const prompt = {
    portable_prompt_schema_version: 1,
    source_prompt_bank_id: promptBank.artifact_id,
    source_prompt_bank_sha256: promptBank.sha256,
    source_transcript_id: sourceTranscript.artifact_id,
    source_transcript_sha256: sourceTranscript.sha256,
    public_shell_copy: clone(copy.public_shell_copy),
    consent: copy.consent.map((item) => ({ id: item.copy_id, text: item.text })),
    affirmations: copy.affirmations.map((item) => ({ id: item.copy_id, text: item.text })),
    comprehension_cards: copy.comprehension_cards.map((card) => ({
      id: card.copy_id, text: card.text, correct_choice_id: card.correct_choice_id,
      incorrect_explanation: card.incorrect_explanation.text,
      choices: card.choices.map((choice) => ({ id: choice.choice_id, text: choice.text })),
    })),
    nonresponse_controls: copy.nonresponse_controls.map((item) => ({ id: item.copy_id, text: item.text })),
    ui, questions, source_spans: sourceTranscript.spans.map(({ id, time_range }) => ({ id, time_range })),
  };
  return validatePortablePrompt(prompt);
};

export const validatePortablePrompt = (prompt) => {
  const keys = ['portable_prompt_schema_version','source_prompt_bank_id','source_prompt_bank_sha256','source_transcript_id','source_transcript_sha256','public_shell_copy','consent','affirmations','comprehension_cards','nonresponse_controls','ui','questions','source_spans'];
  if (!exactKeys(prompt, keys) || prompt.portable_prompt_schema_version !== 1
    || prompt.source_prompt_bank_id !== 'RA-PROMPT-BANK-V3'
    || !/^[a-f0-9]{64}$/u.test(prompt.source_prompt_bank_sha256)
    || prompt.source_transcript_id !== 'RA-SRC-VAN-TRANSCRIPT-001'
    || !/^[a-f0-9]{64}$/u.test(prompt.source_transcript_sha256)
    || !Array.isArray(prompt.consent) || prompt.consent.length !== 8
    || !Array.isArray(prompt.affirmations) || prompt.affirmations.length !== 7
    || !Array.isArray(prompt.comprehension_cards) || prompt.comprehension_cards.length !== 6
    || prompt.comprehension_cards.some((card) => !Array.isArray(card.choices) || card.choices.length !== 3 || !card.choices.some((choice) => choice.id === card.correct_choice_id))
    || !Array.isArray(prompt.nonresponse_controls) || prompt.nonresponse_controls.length !== 5
    || !Array.isArray(prompt.questions) || prompt.questions.length !== 51
    || new Set(prompt.questions.map((item) => item.id)).size !== 51
    || prompt.questions.flatMap((item) => item.followups).length !== 218
    || !Array.isArray(prompt.source_spans) || prompt.source_spans.length !== 8) fail();
  return prompt;
};

export const createPortableSession = ({ releaseId, prompt }) => {
  validatePortablePrompt(prompt);
  if (!UUID.test(releaseId)) fail();
  return {
    portable_session_schema_version: 2, release_id: releaseId, phase: 'CONSENT', question_index: 0,
    affirmations: Object.fromEntries(prompt.affirmations.map((item) => [item.id, false])),
    comprehension: Object.fromEntries(prompt.comprehension_cards.map((item) => [item.id, null])),
    responses: [], draft_recording: null, updated_at: null,
  };
};

export const isCorrectComprehensionChoice = (prompt, cardId, choiceId) => {
  validatePortablePrompt(prompt);
  const card = prompt.comprehension_cards.find((item) => item.id === cardId);
  if (!card || !card.choices.some((choice) => choice.id === choiceId)) fail();
  return choiceId === card.correct_choice_id;
};

export const validatePortableSession = (state, prompt) => {
  validatePortablePrompt(prompt);
  const keys = ['portable_session_schema_version','release_id','phase','question_index','affirmations','comprehension','responses','draft_recording','updated_at'];
  if (!exactKeys(state, keys) || state.portable_session_schema_version !== 2 || !UUID.test(state.release_id)
    || !['CONSENT','CONSENT_READY','INTERVIEW','COMPLETE'].includes(state.phase)
    || !Number.isSafeInteger(state.question_index) || state.question_index < 0 || state.question_index > 51
    || !exactKeys(state.affirmations, prompt.affirmations.map((item) => item.id))
    || Object.values(state.affirmations).some((value) => typeof value !== 'boolean')
    || !exactKeys(state.comprehension, prompt.comprehension_cards.map((item) => item.id))
    || (state.updated_at !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(state.updated_at))
    || !Array.isArray(state.responses) || state.responses.length !== state.question_index) fail();
  state.responses.forEach((response, index) => {
    if (!exactKeys(response, ['question_id','disposition','audio_object_id'])
      || response.question_id !== prompt.questions[index].id || !DISPOSITIONS.has(response.disposition)
      || (response.disposition === 'RECORDED' ? !UUID.test(response.audio_object_id) : response.audio_object_id !== null)) fail();
  });
  if (state.draft_recording !== null) {
    const draft = state.draft_recording;
    if (state.phase !== 'INTERVIEW'
      || !exactKeys(draft, ['question_id','mime_type','chunk_object_ids','total_bytes','status','partial'])
      || draft.question_id !== prompt.questions[state.question_index]?.id
      || typeof draft.mime_type !== 'string' || !/^audio\/[A-Za-z0-9.+-]+(?:;codecs=[A-Za-z0-9.+-]+)?$/u.test(draft.mime_type)
      || draft.mime_type.length > 128
      || !Array.isArray(draft.chunk_object_ids) || draft.chunk_object_ids.length > 480
      || new Set(draft.chunk_object_ids).size !== draft.chunk_object_ids.length
      || draft.chunk_object_ids.some((value) => !UUID.test(value))
      || !Number.isSafeInteger(draft.total_bytes) || draft.total_bytes < 0 || draft.total_bytes > 2_000_000
      || !['RECORDING','STOPPED'].includes(draft.status) || typeof draft.partial !== 'boolean'
      || (draft.status === 'RECORDING' && draft.partial)
      || (draft.status === 'STOPPED' && draft.chunk_object_ids.length === 0)) fail();
  }
  return state;
};

export const reducePortableSession = (input, event, prompt) => {
  const state = clone(validatePortableSession(input, prompt));
  if (!event || typeof event.type !== 'string') fail();
  if (event.type === 'AFFIRM') {
    if (state.phase !== 'CONSENT' || !Object.hasOwn(state.affirmations, event.affirmationId)) fail();
    state.affirmations[event.affirmationId] = true;
    return validatePortableSession(state, prompt);
  }
  if (event.type === 'COMPREHENSION_ANSWER') {
    if (state.phase !== 'CONSENT' || !Object.values(state.affirmations).every(Boolean)
      || !Object.hasOwn(state.comprehension, event.cardId)) fail();
    const cardIndex = prompt.comprehension_cards.findIndex((item) => item.id === event.cardId);
    const firstUnpassed = prompt.comprehension_cards.findIndex((item) => state.comprehension[item.id] === null);
    if (cardIndex !== firstUnpassed) fail();
    if (!isCorrectComprehensionChoice(prompt, event.cardId, event.choiceId)) return validatePortableSession(state, prompt);
    state.comprehension[event.cardId] = event.choiceId;
    if (Object.values(state.comprehension).every((value) => value !== null)) state.phase = 'CONSENT_READY';
    return validatePortableSession(state, prompt);
  }
  if (event.type === 'CONSENT_COMMIT') {
    if (state.phase !== 'CONSENT_READY' || !Object.values(state.affirmations).every(Boolean)
      || prompt.comprehension_cards.some((card) => state.comprehension[card.id] !== card.correct_choice_id)) fail();
    state.phase = 'INTERVIEW';
    return validatePortableSession(state, prompt);
  }
  if (event.type === 'DRAFT_BEGIN') {
    if (state.phase !== 'INTERVIEW' || state.draft_recording !== null
      || prompt.questions[state.question_index]?.id !== event.questionId
      || typeof event.mimeType !== 'string' || !/^audio\/[A-Za-z0-9.+-]+(?:;codecs=[A-Za-z0-9.+-]+)?$/u.test(event.mimeType)
      || event.mimeType.length > 128) fail();
    state.draft_recording = {
      question_id: event.questionId, mime_type: event.mimeType, chunk_object_ids: [],
      total_bytes: 0, status: 'RECORDING', partial: false,
    };
    return validatePortableSession(state, prompt);
  }
  if (event.type === 'DRAFT_APPEND') {
    const draft = state.draft_recording;
    if (state.phase !== 'INTERVIEW' || draft?.status !== 'RECORDING' || !UUID.test(event.objectId)
      || draft.chunk_object_ids.includes(event.objectId) || draft.chunk_object_ids.length >= 480
      || !Number.isSafeInteger(event.byteLength) || event.byteLength < 1
      || draft.total_bytes + event.byteLength > 2_000_000) fail();
    draft.chunk_object_ids.push(event.objectId);
    draft.total_bytes += event.byteLength;
    return validatePortableSession(state, prompt);
  }
  if (event.type === 'DRAFT_STOP') {
    const draft = state.draft_recording;
    if (state.phase !== 'INTERVIEW' || draft?.status !== 'RECORDING' || draft.chunk_object_ids.length === 0
      || typeof event.partial !== 'boolean') fail();
    draft.status = 'STOPPED'; draft.partial = event.partial;
    return validatePortableSession(state, prompt);
  }
  if (event.type === 'DRAFT_CLEAR') {
    if (state.phase !== 'INTERVIEW' || state.draft_recording === null) fail();
    state.draft_recording = null;
    return validatePortableSession(state, prompt);
  }
  if (event.type === 'RESPONSE_COMMIT') {
    if (state.phase !== 'INTERVIEW' || state.draft_recording !== null || prompt.questions[state.question_index]?.id !== event.questionId
      || !DISPOSITIONS.has(event.disposition)
      || (event.disposition === 'RECORDED' ? !UUID.test(event.audioObjectId) : event.audioObjectId !== null)) fail();
    state.responses.push({ question_id: event.questionId, disposition: event.disposition, audio_object_id: event.audioObjectId });
    state.question_index += 1;
    if (state.question_index === prompt.questions.length) state.phase = 'COMPLETE';
    return validatePortableSession(state, prompt);
  }
  fail();
};
