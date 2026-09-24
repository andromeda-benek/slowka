import {
  assignTile,
  buildFlashcards,
  buildChoiceTask,
  completeSeriesKind,
  ensureDailySeries,
  ensureSeries,
  gradeChoice,
  gradeMatching,
  recordRecentMistake,
  recordResult,
  restoreSeries,
  selectSeriesFlashcards,
  serializeSeries,
  shuffledDifferent,
  unassignTile,
  validateExerciseBank,
  validateImportedState,
} from './logic.mjs?v=1.2.1';

const STORAGE_KEY = 'slowka-progress-v1';
const MAX_HISTORY = 100;
const MAX_IMPORT_BYTES = 1024 * 1024;

const elements = {
  home: document.querySelector('#home-screen'),
  practice: document.querySelector('#practice-screen'),
  result: document.querySelector('#result-screen'),
  homeButton: document.querySelector('#home-button'),
  error: document.querySelector('#error-message'),
  sessionMode: document.querySelector('#session-mode'),
  practiceContent: document.querySelector('#practice-content'),
  sessionKind: document.querySelector('#session-kind'),
  sessionTitle: document.querySelector('#session-title'),
  sessionProgress: document.querySelector('#session-progress'),
  resultScore: document.querySelector('#result-score'),
  resultMessage: document.querySelector('#result-message'),
  reviewList: document.querySelector('#review-list'),
  onlineStatus: document.querySelector('#online-status'),
};

let content;
let state = loadState();
let activeSession = null;
let currentSeries = null;
let flashcards = [];
let deferredInstallPrompt = null;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {},
      history: Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY) : [],
      recentMistakeIds: Array.isArray(parsed.recentMistakeIds) ? parsed.recentMistakeIds.slice(-10) : [],
      currentSeries: parsed.currentSeries || null,
      dailyReviews: parsed.dailyReviews || null,
    };
  } catch {
    return {
      progress: {}, history: [], recentMistakeIds: [], currentSeries: null, dailyReviews: null,
    };
  }
}

function saveState(candidate = state, throwOnError = false) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate));
    return true;
  } catch {
    const message = 'Nie udało się zapisać postępów w tej przeglądarce. Możesz kontynuować, ale wynik nie będzie trwały.';
    if (throwOnError) throw new Error(message);
    showError(message);
    return false;
  }
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.classList.remove('hidden');
}

function clearError() {
  elements.error.textContent = '';
  elements.error.classList.add('hidden');
}

function showScreen(name) {
  elements.home.classList.toggle('hidden', name !== 'home');
  elements.practice.classList.toggle('hidden', name !== 'practice');
  elements.result.classList.toggle('hidden', name !== 'result');
  elements.homeButton.classList.toggle('hidden', name === 'home');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const heading = name === 'home'
    ? document.querySelector('#home-title')
    : name === 'practice' ? elements.sessionTitle : document.querySelector('#result-title');
  requestAnimationFrame(() => heading.focus());
}

function updateOnlineStatus() {
  const online = navigator.onLine;
  elements.onlineStatus.textContent = online ? 'online' : 'offline';
  elements.onlineStatus.classList.toggle('offline', !online);
}

function updateHomeStats() {
  const entries = Object.values(state.progress);
  const attempts = entries.reduce((sum, entry) => sum + entry.attempts, 0);
  const correct = entries.reduce((sum, entry) => sum + entry.correct, 0);
  const now = new Date().toISOString();
  const due = entries.filter((entry) => entry.dueAt <= now).length;
  const mistakes = state.recentMistakeIds.length;

  document.querySelector('#learned-count').textContent = String(entries.length);
  document.querySelector('#accuracy-value').textContent = attempts ? `${Math.round((correct / attempts) * 100)}%` : '—';
  document.querySelector('#due-count').textContent = String(due);
  document.querySelector('#mistake-count').textContent = String(mistakes);
  document.querySelector('#source-stats').textContent =
    `${content.stats.words} haseł · ${content.stats.examples} przykładów · ${content.stats.exercises} ćwiczeń B1`;
}

function beginSession(kind) {
  clearError();
  const mode = elements.sessionMode.value;
  if (mode === 'reviews') {
    const daily = ensureDailySeries(
      state.dailyReviews,
      content.exercises,
      state.progress,
      10,
      Math.random,
      new Date(),
      state.recentMistakeIds,
    );
    currentSeries = daily.series;
    state.dailyReviews = daily.snapshot;
  } else {
    currentSeries = ensureSeries(
      currentSeries,
      content.exercises,
      state.progress,
      mode,
      10,
      Math.random,
      new Date(),
      state.recentMistakeIds,
    );
  }
  let exercises = currentSeries.exercises;
  if (kind === 'flashcards') {
    exercises = selectSeriesFlashcards(currentSeries.exercises, flashcards);
  }
  if (exercises.length < 10) {
    showError(`Ten tryb wymaga 10 zadań, a dostępnych jest ${exercises.length}.`);
    return;
  }
  state.currentSeries = serializeSeries(currentSeries);
  saveState();

  activeSession = {
    kind,
    mode,
    exercises,
    index: 0,
    score: 0,
    results: [],
    assignments: {},
    selectedSentenceId: null,
  };
  showScreen('practice');
  if (kind === 'choice') renderChoice();
  else if (kind === 'matching') renderMatching();
  else renderFlashcard();
}

function appendFeedback(container, exercise, correct) {
  const feedback = document.createElement('div');
  feedback.className = 'feedback';

  const verdict = document.createElement('strong');
  verdict.textContent = correct ? '✓ Poprawnie' : `✕ Poprawna odpowiedź: ${exercise.answer}`;
  feedback.append(verdict);

  const sentence = document.createElement('span');
  sentence.lang = 'ru';
  sentence.textContent = exercise.sentenceRu;
  feedback.append(sentence);

  const translation = document.createElement('span');
  translation.className = 'feedback-translation';
  translation.textContent = exercise.translationPl;
  feedback.append(translation);
  container.append(feedback);
}

function renderChoice() {
  const exercise = activeSession.exercises[activeSession.index];
  const task = buildChoiceTask(exercise, content.exercises, 4);
  elements.sessionKind.textContent = 'Wybierz odpowiedź';
  elements.sessionTitle.textContent = 'Uzupełnij zdanie';
  elements.sessionProgress.textContent = `${activeSession.index + 1}/${activeSession.exercises.length}`;
  elements.practiceContent.replaceChildren();

  const card = document.createElement('article');
  card.className = 'question-card';
  const question = document.createElement('p');
  question.className = 'question';
  question.lang = 'ru';
  question.textContent = task.sentenceGap;
  card.append(question);

  const options = document.createElement('div');
  options.className = 'option-grid';
  task.options.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    button.lang = 'ru';
    button.textContent = option.text;
    button.addEventListener('click', () => {
      if (card.dataset.answered === 'true') return;
      card.dataset.answered = 'true';
      const result = gradeChoice(task, option.id);
      activeSession.score += result.correct ? 1 : 0;
      activeSession.results.push({ exercise, correct: result.correct });
      state.progress = recordResult(state.progress, exercise.id, result.correct);
      state.recentMistakeIds = recordRecentMistake(
        state.recentMistakeIds,
        exercise.id,
        result.correct,
      );
      saveState();

      options.querySelectorAll('button').forEach((candidate) => {
        candidate.disabled = true;
        if (candidate.textContent === exercise.answer) candidate.classList.add('correct');
        if (candidate === button && !result.correct) candidate.classList.add('wrong');
      });
      appendFeedback(card, exercise, result.correct);

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'primary next-button';
      next.textContent = activeSession.index + 1 === activeSession.exercises.length ? 'Zobacz wynik' : 'Następne zdanie';
      next.addEventListener('click', () => {
        activeSession.index += 1;
        if (activeSession.index >= activeSession.exercises.length) finishSession();
        else renderChoice();
      });
      card.append(next);
      next.focus();
    });
    options.append(button);
  });
  card.append(options);
  elements.practiceContent.append(card);
  elements.sessionTitle.focus();
}

function renderFlashcard() {
  const flashcard = activeSession.exercises[activeSession.index];
  elements.sessionKind.textContent = flashcard.sourceType === 'word' ? 'Fiszka · słowo' : 'Fiszka · zwrot';
  elements.sessionTitle.textContent = 'Przypomnij sobie po rosyjsku';
  elements.sessionProgress.textContent = `${activeSession.index + 1}/${activeSession.exercises.length}`;
  elements.practiceContent.replaceChildren();

  const card = document.createElement('article');
  card.className = 'question-card flashcard';
  const promptLabel = document.createElement('span');
  promptLabel.className = 'flashcard-label';
  promptLabel.textContent = 'Po polsku';
  const prompt = document.createElement('p');
  prompt.className = 'flashcard-prompt';
  prompt.textContent = flashcard.promptPl;
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'primary flashcard-check';
  check.textContent = 'Sprawdź';
  check.addEventListener('click', () => {
    check.remove();
    const answerLabel = document.createElement('span');
    answerLabel.className = 'flashcard-label';
    answerLabel.textContent = 'Po rosyjsku';
    const answer = document.createElement('p');
    answer.className = 'flashcard-answer';
    answer.lang = 'ru';
    answer.textContent = flashcard.answerRu;

    const rating = document.createElement('div');
    rating.className = 'self-rating';
    const rate = (correct) => {
      activeSession.score += correct ? 1 : 0;
      activeSession.results.push({ exercise: flashcard, correct });
      state.progress = recordResult(state.progress, flashcard.id, correct);
      state.recentMistakeIds = recordRecentMistake(
        state.recentMistakeIds,
        flashcard.exerciseId,
        correct,
      );
      saveState();
      activeSession.index += 1;
      if (activeSession.index >= activeSession.exercises.length) finishSession();
      else renderFlashcard();
    };
    const good = document.createElement('button');
    good.type = 'button';
    good.className = 'primary rating-good';
    good.textContent = 'Dobre';
    good.addEventListener('click', () => rate(true));
    const bad = document.createElement('button');
    bad.type = 'button';
    bad.className = 'secondary rating-bad';
    bad.textContent = 'Złe';
    bad.addEventListener('click', () => rate(false));
    rating.append(bad, good);
    card.append(answerLabel, answer, rating);
    good.focus();
  });
  card.append(promptLabel, prompt, check);
  elements.practiceContent.append(card);
  elements.sessionTitle.focus();
}

function renderMatching({ preserveViewport = false } = {}) {
  const viewport = preserveViewport
    ? { left: window.scrollX, top: window.scrollY }
    : null;
  elements.sessionKind.textContent = 'Połącz 10 × 10';
  elements.sessionTitle.textContent = 'Dobierz frazy';
  elements.sessionProgress.textContent = `${Object.keys(activeSession.assignments).length}/10`;
  elements.practiceContent.replaceChildren();

  const intro = document.createElement('p');
  intro.className = 'matching-intro';
  intro.textContent = 'Dotknij zdania, a potem kafelka. Dotknięcie wstawionej frazy cofa wybór.';
  elements.practiceContent.append(intro);

  const list = document.createElement('div');
  list.className = 'sentence-list';
  activeSession.exercises.forEach((exercise, index) => {
    const card = document.createElement('article');
    card.className = 'matching-card-item';
    if (activeSession.selectedSentenceId === exercise.id) card.classList.add('selected');

    const sentenceButton = document.createElement('button');
    sentenceButton.type = 'button';
    sentenceButton.className = 'sentence-select';
    sentenceButton.dataset.exerciseId = exercise.id;
    sentenceButton.lang = 'ru';
    sentenceButton.setAttribute('aria-pressed', String(activeSession.selectedSentenceId === exercise.id));
    sentenceButton.textContent = `${index + 1}. ${exercise.sentenceGap}`;
    sentenceButton.addEventListener('click', () => {
      activeSession.selectedSentenceId = exercise.id;
      renderMatching();
    });
    card.append(sentenceButton);

    const assignedId = activeSession.assignments[exercise.id];
    if (assignedId) {
      const assigned = content.exercises.find((item) => item.id === assignedId);
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'assigned-answer';
      undo.lang = 'ru';
      undo.textContent = `${assigned.answer} ×`;
      undo.setAttribute('aria-label', `Cofnij odpowiedź ${assigned.answer}`);
      undo.addEventListener('click', () => {
        activeSession.assignments = unassignTile(activeSession.assignments, exercise.id);
        activeSession.selectedSentenceId = exercise.id;
        renderMatching();
      });
      card.append(undo);
    }
    list.append(card);
  });
  elements.practiceContent.append(list);

  const tray = document.createElement('div');
  tray.className = 'tile-tray';
  const inner = document.createElement('div');
  inner.className = 'tile-tray-inner';
  const trayHead = document.createElement('div');
  trayHead.className = 'tile-tray-head';
  trayHead.textContent = activeSession.selectedSentenceId ? 'Wybierz frazę dla zaznaczonego zdania' : 'Najpierw wybierz zdanie';
  inner.append(trayHead);

  const bank = document.createElement('div');
  bank.className = 'tile-bank';
  const bankOrder = activeSession.tileOrder || shuffledDifferent(activeSession.exercises.map((item) => item.id));
  activeSession.tileOrder = bankOrder;
  const used = new Set(Object.values(activeSession.assignments));
  bankOrder.forEach((id) => {
    if (used.has(id)) return;
    const exercise = content.exercises.find((item) => item.id === id);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'phrase-tile';
    tile.lang = 'ru';
    tile.textContent = exercise.answer;
    tile.disabled = !activeSession.selectedSentenceId;
    tile.addEventListener('click', () => {
      activeSession.assignments = assignTile(activeSession.assignments, activeSession.selectedSentenceId, id);
      activeSession.selectedSentenceId = null;
      renderMatching({ preserveViewport: true });
    });
    bank.append(tile);
  });
  inner.append(bank);

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'primary check-matching';
  check.textContent = 'Sprawdź odpowiedzi';
  check.disabled = Object.keys(activeSession.assignments).length !== activeSession.exercises.length;
  check.addEventListener('click', () => {
    const result = gradeMatching(activeSession.exercises, activeSession.assignments);
    activeSession.score = result.score;
    activeSession.results = result.items.map((item) => ({ exercise: item.exercise, correct: item.correct }));
    result.items.forEach((item) => {
      state.progress = recordResult(state.progress, item.exercise.id, item.correct);
      state.recentMistakeIds = recordRecentMistake(
        state.recentMistakeIds,
        item.exercise.id,
        item.correct,
      );
    });
    saveState();
    finishSession();
  });
  inner.append(check);
  tray.append(inner);
  elements.practiceContent.append(tray);
  const focusId = activeSession.selectedSentenceId
    || activeSession.exercises.find((exercise) => !activeSession.assignments[exercise.id])?.id;
  const focusTarget = focusId
    ? [...list.querySelectorAll('.sentence-select')]
      .find((button) => button.dataset.exerciseId === focusId)
    : null;
  requestAnimationFrame(() => {
    focusTarget?.focus({ preventScroll: true });
    if (viewport) window.scrollTo({ left: viewport.left, top: viewport.top, behavior: 'auto' });
  });
}

function finishSession() {
  currentSeries = completeSeriesKind(currentSeries, activeSession.kind);
  state.currentSeries = serializeSeries(currentSeries);
  const historyEntry = {
    finishedAt: new Date().toISOString(),
    kind: activeSession.kind,
    score: activeSession.score,
    total: activeSession.results.length,
  };
  state.history = [...state.history, historyEntry].slice(-MAX_HISTORY);
  saveState();

  elements.resultScore.textContent = `${activeSession.score}/${activeSession.results.length}`;
  elements.resultMessage.textContent = activeSession.score === activeSession.results.length
    ? 'Świetnie — cały zestaw rozwiązany poprawnie.'
    : activeSession.kind === 'flashcards'
      ? 'Fiszki oznaczone jako złe wrócą wcześniej w kolejnych powtórkach.'
      : 'Błędne odpowiedzi wrócą wcześniej w kolejnych powtórkach.';
  elements.reviewList.replaceChildren();

  [...activeSession.results]
    .sort((a, b) => Number(a.correct) - Number(b.correct))
    .forEach(({ exercise, correct }) => {
      const item = document.createElement('article');
      item.className = `review-item${correct ? '' : ' wrong'}`;
      const verdict = document.createElement('strong');
      verdict.textContent = activeSession.kind === 'flashcards'
        ? (correct ? '✓ Dobre' : '✕ Złe')
        : `${correct ? '✓' : '✕'} ${exercise.answer}`;
      const sentence = document.createElement('span');
      sentence.lang = 'ru';
      sentence.textContent = activeSession.kind === 'flashcards' ? exercise.answerRu : exercise.sentenceRu;
      const translation = document.createElement('span');
      translation.className = 'translation';
      translation.textContent = activeSession.kind === 'flashcards' ? exercise.promptPl : exercise.translationPl;
      if (activeSession.kind === 'flashcards') {
        item.append(verdict, sentence, translation);
        elements.reviewList.append(item);
        return;
      }
      const sourceExample = content.examples.find((example) => example.id === exercise.sourceExampleId);
      const meaning = document.createElement('span');
      meaning.className = 'translation';
      meaning.textContent = `Znaczenie: ${sourceExample?.pl || exercise.lemmaTranslation}`;
      item.append(verdict, sentence, translation, meaning);
      elements.reviewList.append(item);
    });

  showScreen('result');
}

function goHome() {
  activeSession = null;
  elements.practiceContent.replaceChildren();
  updateHomeStats();
  showScreen('home');
}

function exportProgress() {
  const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'slowka-postepy.json';
  link.click();
  URL.revokeObjectURL(url);
}

async function importProgress(file) {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('Plik kopii jest zbyt duży (maksymalnie 1 MB).');
  const parsed = JSON.parse(await file.text());
  const validIds = new Set([...content.exercises, ...flashcards].map((item) => item.id));
  const validSeriesIds = new Set(content.exercises.map((exercise) => exercise.id));
  const candidate = validateImportedState(parsed, validIds, MAX_HISTORY, validSeriesIds);
  saveState(candidate, true);
  state = candidate;
  currentSeries = restoreSeries(state.currentSeries, content.exercises);
  if (currentSeries) elements.sessionMode.value = currentSeries.mode;
  updateHomeStats();
}

async function init() {
  try {
    const response = await fetch('./data/content.json');
    if (!response.ok) throw new Error(`Nie udało się wczytać danych (${response.status}).`);
    content = await response.json();
    const errors = validateExerciseBank(content.exercises);
    if (errors.length) throw new Error(`Błąd banku ćwiczeń: ${errors[0]}`);
    flashcards = buildFlashcards(content.dictionary, content.examples);
    const validIds = new Set([...content.exercises, ...flashcards].map((item) => item.id));
    const validSeriesIds = new Set(content.exercises.map((exercise) => exercise.id));
    try {
      state = validateImportedState(
        { version: 1, ...state },
        validIds,
        MAX_HISTORY,
        validSeriesIds,
      );
      currentSeries = restoreSeries(state.currentSeries, content.exercises);
      if (currentSeries) elements.sessionMode.value = currentSeries.mode;
    } catch {
      state = {
        progress: {},
        history: [],
        recentMistakeIds: [],
        currentSeries: null,
        dailyReviews: null,
      };
      if (saveState()) {
        showError('Uszkodzone dane lokalne zostały zresetowane. Możesz rozpocząć nową sesję.');
      }
    }
    updateHomeStats();
  } catch (error) {
    showError(error.message);
    document.querySelector('#start-choice').disabled = true;
    document.querySelector('#start-matching').disabled = true;
    document.querySelector('#start-flashcards').disabled = true;
  }
}

document.querySelector('#start-choice').addEventListener('click', () => beginSession('choice'));
document.querySelector('#start-matching').addEventListener('click', () => beginSession('matching'));
document.querySelector('#start-flashcards').addEventListener('click', () => beginSession('flashcards'));
document.querySelector('#finish-session').addEventListener('click', goHome);
elements.homeButton.addEventListener('click', goHome);
document.querySelector('#export-progress').addEventListener('click', exportProgress);
document.querySelector('#import-progress').addEventListener('click', () => document.querySelector('#import-file').click());
document.querySelector('#import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    await importProgress(file);
    clearError();
  } catch (error) {
    showError(error.message);
  } finally {
    event.target.value = '';
  }
});

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.querySelector('#install-app').classList.remove('hidden');
});
document.querySelector('#install-app').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  await deferredInstallPrompt.prompt();
  deferredInstallPrompt = null;
  document.querySelector('#install-app').classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    document.querySelector('#offline-ready').textContent = 'online';
  });
}

updateOnlineStatus();
init();
