const GAP = '_____';
const DAY_MS = 24 * 60 * 60 * 1000;

function shuffled(items, rng = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

export function shuffledDifferent(items, rng = Math.random) {
  const result = shuffled(items, rng);
  if (result.length > 1 && result.every((item, index) => item === items[index])) {
    result.push(result.shift());
  }
  return result;
}

export function validateExerciseBank(exercises) {
  const errors = [];
  const ids = new Set();
  const required = [
    'id',
    'lemmaId',
    'sourceExampleId',
    'level',
    'sentenceRu',
    'sentenceGap',
    'translationPl',
    'answer',
    'lemma',
    'lemmaTranslation',
  ];

  exercises.forEach((exercise, index) => {
    const label = exercise.id || `index ${index}`;
    if (ids.has(exercise.id)) errors.push(`duplicate id: ${exercise.id}`);
    ids.add(exercise.id);

    required.forEach((field) => {
      if (!exercise[field]) errors.push(`${label}: missing ${field}`);
    });

    const gapCount = String(exercise.sentenceGap || '').split(GAP).length - 1;
    if (gapCount !== 1) errors.push(`${label}: expected exactly one gap`);
    if (gapCount === 1 && exercise.answer) {
      const restored = exercise.sentenceGap.replace(GAP, exercise.answer);
      if (restored !== exercise.sentenceRu) errors.push(`${label}: answer does not restore sentence`);
    }
  });

  exercises.forEach((exercise) => {
    if (!Array.isArray(exercise.choiceDistractorIds) || exercise.choiceDistractorIds.length !== 3) {
      errors.push(`${exercise.id}: expected exactly three choice distractors`);
      return;
    }
    if (new Set(exercise.choiceDistractorIds).size !== 3) {
      errors.push(`${exercise.id}: choice distractors must be unique`);
    }
    exercise.choiceDistractorIds.forEach((id) => {
      if (id === exercise.id || !ids.has(id)) errors.push(`${exercise.id}: invalid choice distractor ${id}`);
    });
  });

  return errors;
}

export function buildFlashcards(dictionary, examples) {
  const wordCards = dictionary.map((word) => ({
    id: `flash-word-${word.id}`,
    sourceType: 'word',
    promptPl: word.tlumaczenia.join('; '),
    answerRu: word.akcent,
  }));
  const exampleCards = examples.map((example) => ({
    id: `flash-example-${example.id}`,
    sourceType: 'example',
    promptPl: example.pl,
    answerRu: example.ru,
  }));
  return [...wordCards, ...exampleCards];
}

export function selectSeriesFlashcards(exercises, flashcards) {
  const byId = new Map(flashcards.map((flashcard) => [flashcard.id, flashcard]));
  const selected = exercises.map((exercise) => {
    const flashcard = byId.get(`flash-example-${exercise.sourceExampleId}`);
    return flashcard ? { ...flashcard, exerciseId: exercise.id } : null;
  });
  return selected.some((flashcard) => !flashcard) ? [] : selected;
}

export function buildChoiceTask(exercise, pool, optionCount = 4, rng = Math.random) {
  if (!exercise?.id) throw new Error('Exercise is required');
  if (optionCount < 2) throw new Error('At least two options are required');

  const byId = new Map(pool.map((candidate) => [candidate.id, candidate]));
  const distractors = exercise.choiceDistractorIds?.map((id) => byId.get(id));
  if (!distractors || distractors.length !== optionCount - 1 || distractors.some((item) => !item)) {
    throw new Error('Exercise does not have enough approved distractors');
  }

  const options = shuffled([exercise, ...distractors], rng).map((item) => ({
    id: item.id,
    text: item.answer,
  }));

  return {
    ...exercise,
    options,
    correctId: exercise.id,
  };
}

export function gradeChoice(task, selectedId) {
  if (!task.options.some((option) => option.id === selectedId)) {
    throw new Error('Selected option does not belong to this task');
  }
  return {
    correct: selectedId === task.correctId,
    selectedId,
    correctId: task.correctId,
    correctAnswer: task.answer,
  };
}

export function assignTile(assignments, sentenceId, tileId) {
  const owner = Object.entries(assignments).find(
    ([assignedSentenceId, assignedTileId]) => assignedTileId === tileId && assignedSentenceId !== sentenceId,
  );
  if (owner) throw new Error('Tile is already assigned');
  return { ...assignments, [sentenceId]: tileId };
}

export function unassignTile(assignments, sentenceId) {
  const next = { ...assignments };
  delete next[sentenceId];
  return next;
}

export function gradeMatching(exercises, assignments) {
  if (exercises.some((exercise) => !assignments[exercise.id])) {
    throw new Error('Answer all sentences before checking');
  }

  const items = exercises.map((exercise) => ({
    exercise,
    selectedId: assignments[exercise.id],
    correct: assignments[exercise.id] === exercise.id,
  }));

  return {
    score: items.filter((item) => item.correct).length,
    total: exercises.length,
    items,
  };
}

export function recordResult(progress, exerciseId, wasCorrect, now = new Date()) {
  const previous = progress[exerciseId] || {
    attempts: 0,
    correct: 0,
    streak: 0,
  };
  const streak = wasCorrect ? previous.streak + 1 : 0;
  const correctIntervals = [1, 3, 7, 14, 30, 60];
  const intervalDays = wasCorrect
    ? correctIntervals[Math.min(streak - 1, correctIntervals.length - 1)]
    : 0.5;

  return {
    ...progress,
    [exerciseId]: {
      attempts: previous.attempts + 1,
      correct: previous.correct + (wasCorrect ? 1 : 0),
      streak,
      lastCorrect: wasCorrect,
      lastAnsweredAt: now.toISOString(),
      dueAt: new Date(now.getTime() + intervalDays * DAY_MS).toISOString(),
    },
  };
}

export function recordRecentMistake(recentMistakeIds, exerciseId, wasCorrect, limit = 10) {
  if (wasCorrect) return [...recentMistakeIds];
  return [...recentMistakeIds.filter((id) => id !== exerciseId), exerciseId].slice(-limit);
}

export function selectSession(
  exercises,
  progress,
  mode,
  count = 10,
  rng = Math.random,
  now = new Date(),
  recentMistakeIds = [],
) {
  if (mode === 'mistakes' && recentMistakeIds.length) {
    const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]));
    const recent = [...recentMistakeIds].reverse().map((id) => byId.get(id)).filter(Boolean);
    const recentIds = new Set(recent.map((exercise) => exercise.id));
    const remainder = shuffled(exercises.filter((exercise) => !recentIds.has(exercise.id)), rng);
    return [...recent, ...remainder].slice(0, count);
  }

  const due = (exercise) => {
    const entry = progress[exercise.id];
    return entry && entry.dueAt <= now.toISOString();
  };
  const preferred = exercises.filter((exercise) => {
    if (mode === 'new') return !progress[exercise.id];
    if (mode === 'reviews') return due(exercise);
    if (mode === 'mistakes') return progress[exercise.id]?.lastCorrect === false;
    return progress[exercise.id]?.lastCorrect === false || due(exercise);
  });
  const preferredIds = new Set(preferred.map((exercise) => exercise.id));
  const remainder = exercises.filter((exercise) => !preferredIds.has(exercise.id));
  return [...shuffled(preferred, rng), ...shuffled(remainder, rng)].slice(0, count);
}

export function selectMatchingSession(
  exercises,
  progress,
  mode,
  count = 10,
  rng = Math.random,
  now = new Date(),
  recentMistakeIds = [],
) {
  const ordered = selectSession(exercises, progress, mode, exercises.length, rng, now, recentMistakeIds);
  const selected = [];
  const usedAnswers = new Set();
  for (const exercise of ordered) {
    if (usedAnswers.has(exercise.answer)) continue;
    selected.push(exercise);
    usedAnswers.add(exercise.answer);
    if (selected.length === count) break;
  }
  return selected.length === count ? selected : [];
}

export function ensureSeries(
  currentSeries,
  exercises,
  progress,
  mode,
  count = 10,
  rng = Math.random,
  now = new Date(),
  recentMistakeIds = [],
) {
  if (currentSeries?.mode === mode) {
    return currentSeries;
  }
  return {
    mode,
    exercises: selectMatchingSession(exercises, progress, mode, count, rng, now, recentMistakeIds),
    completedKinds: [],
  };
}

export function completeSeriesKind(series, kind) {
  if (!series) return series;
  return {
    ...series,
    completedKinds: [...new Set([...series.completedKinds, kind])],
  };
}

export function serializeSeries(series) {
  if (!series) return null;
  return {
    mode: series.mode,
    exerciseIds: series.exercises.map((exercise) => exercise.id),
    completedKinds: [...series.completedKinds],
  };
}

export function restoreSeries(snapshot, exercises) {
  if (!snapshot || !Array.isArray(snapshot.exerciseIds)) return null;
  const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const selected = snapshot.exerciseIds.map((id) => byId.get(id));
  if (selected.length !== 10 || selected.some((exercise) => !exercise)) return null;
  return {
    mode: snapshot.mode,
    exercises: selected,
    completedKinds: Array.isArray(snapshot.completedKinds) ? [...snapshot.completedKinds] : [],
  };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function ensureDailySeries(
  snapshot,
  exercises,
  progress,
  count = 10,
  rng = Math.random,
  now = new Date(),
  recentMistakeIds = [],
) {
  const date = localDateKey(now);
  if (snapshot?.date === date) {
    const restored = restoreSeries({
      mode: 'reviews',
      exerciseIds: snapshot.exerciseIds,
      completedKinds: [],
    }, exercises);
    if (restored) return { series: restored, snapshot };
  }
  const series = ensureSeries(null, exercises, progress, 'reviews', count, rng, now, recentMistakeIds);
  return {
    series,
    snapshot: { date, exerciseIds: series.exercises.map((exercise) => exercise.id) },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function validateImportedState(
  payload,
  validExerciseIds,
  maxHistory = 100,
  validSeriesExerciseIds = validExerciseIds,
) {
  const fail = (section) => {
    throw new Error(`Plik zawiera nieprawidłowe dane ${section}.`);
  };
  if (!isPlainObject(payload) || payload.version !== 1 || !isPlainObject(payload.progress)) fail('postępów');
  if (!Array.isArray(payload.history) || payload.history.length > maxHistory) fail('historii');

  const progress = {};
  Object.entries(payload.progress).forEach(([exerciseId, entry]) => {
    if (!validExerciseIds.has(exerciseId)) throw new Error(`Plik zawiera nieznany identyfikator ćwiczenia: ${exerciseId}.`);
    if (!isPlainObject(entry)
      || !isNonNegativeInteger(entry.attempts)
      || !isNonNegativeInteger(entry.correct)
      || !isNonNegativeInteger(entry.streak)
      || entry.correct > entry.attempts
      || entry.streak > entry.correct
      || typeof entry.lastCorrect !== 'boolean'
      || !isIsoDate(entry.lastAnsweredAt)
      || !isIsoDate(entry.dueAt)) fail('postępów');
    progress[exerciseId] = { ...entry };
  });

  const history = payload.history.map((entry) => {
    if (!isPlainObject(entry)
      || !isIsoDate(entry.finishedAt)
      || !['choice', 'matching', 'flashcards'].includes(entry.kind)
      || !isNonNegativeInteger(entry.score)
      || !Number.isInteger(entry.total)
      || entry.total <= 0
      || entry.score > entry.total) fail('historii');
    return { ...entry };
  });

  const recentMistakeIds = payload.recentMistakeIds ?? [];
  if (!Array.isArray(recentMistakeIds)
    || recentMistakeIds.length > 10
    || new Set(recentMistakeIds).size !== recentMistakeIds.length
    || recentMistakeIds.some((id) => !validSeriesExerciseIds.has(id))) fail('ostatnich błędów');

  const validateExerciseIds = (ids, section) => {
    if (!Array.isArray(ids)
      || ids.length !== 10
      || new Set(ids).size !== ids.length
      || ids.some((id) => !validSeriesExerciseIds.has(id))) fail(section);
    return [...ids];
  };

  let currentSeries = null;
  if (payload.currentSeries != null) {
    const snapshot = payload.currentSeries;
    if (!isPlainObject(snapshot)
      || !['mixed', 'reviews', 'new', 'mistakes'].includes(snapshot.mode)
      || !Array.isArray(snapshot.completedKinds)
      || snapshot.completedKinds.some((kind) => !['choice', 'matching', 'flashcards'].includes(kind))) fail('serii');
    currentSeries = {
      mode: snapshot.mode,
      exerciseIds: validateExerciseIds(snapshot.exerciseIds, 'serii'),
      completedKinds: [...new Set(snapshot.completedKinds)],
    };
  }

  let dailyReviews = null;
  if (payload.dailyReviews != null) {
    const snapshot = payload.dailyReviews;
    if (!isPlainObject(snapshot) || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date)) fail('zadań na dziś');
    dailyReviews = {
      date: snapshot.date,
      exerciseIds: validateExerciseIds(snapshot.exerciseIds, 'zadań na dziś'),
    };
  }

  return {
    progress,
    history,
    recentMistakeIds: [...recentMistakeIds],
    currentSeries,
    dailyReviews,
  };
}

export { shuffled };
