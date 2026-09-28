// 逆算エンジン（参考書の総量 → 残り日数で日割り）。わりカレ（study-plan-maker）と編入版（henyu-plan-maker）で共通。
// 正本は study-plan-maker/engine.js。編集したら ../sync-engine.sh で編入版にコピーすること（直接編入版側を直さない）

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 周回前提の教材を「1周目」「2周目」…に展開する（2周目以降は所要時間6割で見積もる）
function expandCycles(books) {
  const out = [];
  books.forEach((b) => {
    const cycles = b.cycles || 1;
    for (let c = 1; c <= cycles; c++) {
      out.push({
        ...b,
        min: c === 1 ? b.min : Math.max(1, Math.round(b.min * 0.6)),
        cycleLabel: cycles > 1 ? `（${c}周目）` : '',
      });
    }
  });
  return out;
}

// toISOString はUTCに変換されるため日本時間だと1日ずれる。ローカル日付で組み立てる
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function todayStr() {
  return toDateStr(new Date());
}

function computeDaysFromDate(dateStr) {
  if (!dateStr) return null;
  const exam = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.max(1, Math.ceil((exam - now) / (1000 * 60 * 60 * 24)));
}

function daysBetween(fromStr, toStr) {
  const a = new Date(fromStr + 'T00:00:00');
  const b = new Date(toStr + 'T00:00:00');
  return Math.max(1, Math.ceil((b - a) / (1000 * 60 * 60 * 24)));
}

function formatDate(d) {
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${w}）`;
}

// ═══════════════════════════════════════════════════════════
// 逆算スケジューリング：本の総量から日割りを出す
// ═══════════════════════════════════════════════════════════
function allocateDays(books, totalDays) {
  const weights = books.map((b) => b.units * b.min);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const days = books.map((_, i) => Math.max(1, Math.round((weights[i] / sum) * totalDays)));
  let diff = days.reduce((a, b) => a + b, 0) - totalDays;
  let guard = 0;
  while (diff > 0 && guard++ < 10000) {
    const maxIdx = days.indexOf(Math.max(...days));
    if (days[maxIdx] <= 1) break;
    days[maxIdx] -= 1; diff -= 1;
  }
  while (diff < 0 && guard++ < 10000) {
    const maxIdx = weights.indexOf(Math.max(...weights));
    days[maxIdx] += 1; diff += 1;
  }
  return days;
}

// 1本のトラック（教材の並び）を、与えられた「進む日」のリストに順番に敷き詰める
function layTrackOnDays(books, dayIndices, plan, spans) {
  if (!books.length || dayIndices.length === 0) return;
  const n = dayIndices.length;
  const days = allocateDays(books, n);
  let cursor = 0;
  books.forEach((b, i) => {
    const span = days[i];
    const startPos = cursor;
    for (let k = 0; k < span && cursor < n; k++, cursor++) {
      const off = b.doneOffset || 0; // リスケジュール後は消化済みの続きから番号を振る
      const from = Math.floor((k * b.units) / span) + 1 + off;
      const to = Math.floor(((k + 1) * b.units) / span) + off;
      // 1日1単元未満のペースの本では「その日に進む分がない日」が出る。同じ番号を連日出さない
      if (to >= from) plan[dayIndices[cursor]].push({ book: b, from, to });
    }
    const endPos = Math.min(cursor, n) - 1;
    if (endPos >= startPos) {
      spans.push({ book: b, startDay: dayIndices[startPos], endDay: dayIndices[endPos], days: span });
    }
  });
}

// 週のうち「進む日」「復習日」の曜日オフセットを返す（週の前半に進み、後半に復習、残りは予備日）
function weekPattern(pace) {
  const advance = clamp(pace.advance, 1, 7);
  const review = clamp(pace.review, 0, 7 - advance);
  return { advance, review };
}

function advanceDayIndices(pace, dayFrom, dayCount) {
  const { advance } = weekPattern(pace);
  const out = [];
  for (let d = dayFrom; d < dayFrom + dayCount; d++) {
    if (d % 7 < advance) out.push(d);
  }
  // 進む日が1日も取れない極端に短い期間では全日を進む日として扱う
  if (out.length === 0) for (let d = dayFrom; d < dayFrom + dayCount; d++) out.push(d);
  return out;
}

// その週の「進む日」でやった範囲を集約し、復習日に割り当てる（復習の所要時間は初回の5割で見積もる）
function addReviewDays(plan, totalDays, pace) {
  const { advance, review } = weekPattern(pace);
  if (review === 0) return;
  const weeks = Math.ceil(totalDays / 7);
  for (let w = 0; w < weeks; w++) {
    const base = w * 7;
    const agg = new Map();
    for (let o = 0; o < advance; o++) {
      const d = base + o;
      if (d >= totalDays) break;
      plan[d].forEach((t) => {
        if (t.isReview) return;
        const key = t.book.title + t.book.cycleLabel;
        if (!agg.has(key)) agg.set(key, { book: t.book, from: t.from, to: t.to });
        else {
          const a = agg.get(key);
          a.from = Math.min(a.from, t.from);
          a.to = Math.max(a.to, t.to);
        }
      });
    }
    if (agg.size === 0) continue;
    const items = [...agg.values()];
    const totalMin = items.reduce((s, i) => s + (i.to - i.from + 1) * i.book.min, 0);
    for (let o = advance; o < advance + review; o++) {
      const d = base + o;
      if (d >= totalDays) break;
      plan[d].push({ isReview: true, items, minutes: (totalMin * 0.5) / review });
    }
  }
}

// 科目ごとのスケジュール。
//   暗記系（単語帳・用語集）＝全期間にわたって毎日並行
//   メインライン（文法→解釈→長文、講義→演習）＝順番に1冊ずつ
//   直前期は全科目まとめて志望校の過去問演習
// すでに消化した分を差し引く（リスケジュール時に使う）。終わった教材は計画から外れる
function applyDone(books, subjectKey, doneMap) {
  return books.map((b) => {
    const done = doneMap[`${subjectKey}::${b.title}${b.cycleLabel || ''}`] || 0;
    if (done <= 0) return b;
    const remaining = b.units - done;
    return remaining > 0 ? { ...b, units: remaining, doneOffset: done } : null;
  }).filter(Boolean);
}

// pastExamBooks：直前期に積む教材（空配列なら直前期を作らず、本番直前まで通常の教材を進める。小論文・面接の練習など）
function buildSubjectSchedule({ picked, pace, studyDays, pastExamDays, totalDays, pastExamBooks, subjectKey, doneMap }) {
  const memorize = applyDone(expandCycles(picked.filter((b) => b.track === 'memorize')), subjectKey, doneMap);
  const main = applyDone(expandCycles(picked.filter((b) => b.track !== 'memorize')), subjectKey, doneMap);
  const pastExam = applyDone(expandCycles(pastExamBooks), subjectKey, doneMap);

  const plan = Array.from({ length: totalDays }, () => []);
  const spans = [];
  // 暗記系とメインラインは同じ期間（0〜studyDays）を並行で走る。進むのは「進む日」だけ
  const studyAdvanceDays = advanceDayIndices(pace, 0, pastExamBooks.length ? studyDays : totalDays);
  const examAdvanceDays = advanceDayIndices(pace, studyDays, pastExamDays);
  layTrackOnDays(memorize, studyAdvanceDays, plan, spans);
  layTrackOnDays(main, studyAdvanceDays, plan, spans);
  layTrackOnDays(pastExam, examAdvanceDays, plan, spans);
  addReviewDays(plan, totalDays, pace);

  const allBooks = [...memorize, ...main, ...pastExam];
  const bookMinutes = allBooks.reduce((a, b) => a + b.units * b.min, 0);
  let reviewMinutes = 0;
  plan.forEach((items) => items.forEach((t) => { if (t.isReview) reviewMinutes += t.minutes; }));
  return { plan, spans, books: allBooks, totalMinutes: bookMinutes + reviewMinutes };
}

// 直前期（過去問演習）に充てる日数
function pastExamDaysFor(totalDays) {
  if (totalDays <= 14) return Math.max(1, Math.floor(totalDays * 0.2));
  return clamp(Math.round(totalDays * 0.15), 7, 45);
}
