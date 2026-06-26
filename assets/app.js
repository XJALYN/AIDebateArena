import { AIClient, PROVIDERS } from './ai-client.js';
import {
  DEBATERS,
  SPEED_CONFIG,
  buildDebatePlan,
  flattenPlan,
  getTurnMessages,
  getJudgeMessages,
  parseJudgeResponse,
  formatTime,
  PRESET_TOPICS,
} from './debate-engine.js';

const STORAGE_KEY = 'debate-arena-config';

const state = {
  view: 'setup',
  topic: '',
  speed: 'medium',
  provider: 'bailian',
  apiKey: '',
  model: 'qwen-plus',
  baseUrl: '',
  rememberKey: true,
  running: false,
  history: [],
  currentTurnIndex: 0,
  freeTimeLeft: 0,
  freeSide: 'pro',
  phaseTimeLeft: 0,
  phaseTimeTotal: 0,
  elapsed: 0,
  transcript: [],
  verdict: null,
  abortController: null,
  timers: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const c = JSON.parse(raw);
    if (c.provider) state.provider = c.provider;
    if (c.model) state.model = c.model;
    if (c.baseUrl) state.baseUrl = c.baseUrl;
    if (c.rememberKey !== undefined) state.rememberKey = c.rememberKey;
    if (c.rememberKey && c.apiKey) state.apiKey = c.apiKey;
    if (c.speed) state.speed = c.speed;
  } catch {
    /* ignore */
  }
}

function saveConfig() {
  const payload = {
    provider: state.provider,
    model: state.model,
    baseUrl: state.baseUrl,
    speed: state.speed,
    rememberKey: state.rememberKey,
    apiKey: state.rememberKey ? state.apiKey : '',
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function showToast(msg, type = 'info') {
  let host = $('#toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast';
    document.body.appendChild(host);
  }
  host.className = `toast toast-${type}`;
  host.textContent = msg;
  host.classList.add('show');
  clearTimeout(host._t);
  host._t = setTimeout(() => host.classList.remove('show'), 3200);
}

function updateNav() {
  $$('[data-nav]').forEach((btn) => {
    const nav = btn.dataset.nav;
    btn.classList.toggle('nav-active', nav === state.view);
    if (nav === 'setup') btn.disabled = state.running;
    else if (nav === 'arena') btn.disabled = !state.running && !state.verdict && state.transcript.length === 0;
    else if (nav === 'verdict') btn.disabled = !state.verdict;
  });
}

function setView(view) {
  state.view = view;
  $$('[data-view]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.view !== view);
  });
  updateNav();
}

function getClient() {
  const p = PROVIDERS[state.provider];
  return new AIClient({
    provider: state.provider,
    apiKey: state.apiKey.trim(),
    model: state.model,
    baseUrl: state.baseUrl.trim() || p.baseUrl,
  });
}

function clearTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

function abortDebate() {
  state.running = false;
  clearTimers();
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
}

function updateTopicCount() {
  const el = $('#topic-count');
  const input = $('#topic-input');
  if (el && input) el.textContent = `${input.value.length} / 180`;
}

function renderModelOptions() {
  const sel = $('#model-select');
  const p = PROVIDERS[state.provider];
  if (!sel || !p) return;
  sel.innerHTML = p.models
    .map((m) => `<option value="${m.id}" ${m.id === state.model ? 'selected' : ''}>${m.name}</option>`)
    .join('');
  if (!p.models.find((m) => m.id === state.model)) {
    state.model = p.models[0].id;
    sel.value = state.model;
  }
}

function bindSetup() {
  const topicInput = $('#topic-input');
  topicInput?.addEventListener('input', () => {
    state.topic = topicInput.value;
    updateTopicCount();
  });

  $$('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      topicInput.value = btn.dataset.preset;
      state.topic = btn.dataset.preset;
      updateTopicCount();
    });
  });

  $$('[data-speed]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.speed = btn.dataset.speed;
      $$('[data-speed]').forEach((b) => b.classList.toggle('speed-active', b === btn));
    });
  });

  $('#provider-select')?.addEventListener('change', (e) => {
    state.provider = e.target.value;
    renderModelOptions();
    const p = PROVIDERS[state.provider];
    $('#api-key-input').placeholder = p.keyPlaceholder;
    $('#key-link').href = p.keyLink;
    $('#base-url-wrap').classList.toggle('hidden', state.provider === 'bailian');
  });

  $('#model-select')?.addEventListener('change', (e) => {
    state.model = e.target.value;
  });

  $('#api-key-input')?.addEventListener('input', (e) => {
    state.apiKey = e.target.value;
  });

  $('#base-url-input')?.addEventListener('input', (e) => {
    state.baseUrl = e.target.value;
  });

  $('#remember-key')?.addEventListener('change', (e) => {
    state.rememberKey = e.target.checked;
  });

  $('#start-btn')?.addEventListener('click', startDebate);
}

function bindNav() {
  $$('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const v = btn.dataset.nav;
      if (v === 'setup') resetToSetup();
      else if (v === 'verdict' && state.verdict) setView('verdict');
      else if (v === 'arena' && (state.running || state.transcript.length > 0)) setView('arena');
    });
  });
  $('#arena-reset')?.addEventListener('click', () => {
    if (confirm('确定重置比赛？')) resetToSetup();
  });
  $('#new-debate-btn')?.addEventListener('click', resetToSetup);
  $('#review-btn')?.addEventListener('click', () => setView('arena'));
}

function validateSetup() {
  state.topic = $('#topic-input')?.value.trim() || '';
  state.apiKey = $('#api-key-input')?.value.trim() || '';
  if (!state.topic) {
    showToast('请输入辩题', 'error');
    return false;
  }
  if (state.topic.length > 180) {
    showToast('辩题不超过 180 字', 'error');
    return false;
  }
  if (!state.apiKey) {
    showToast('请输入 API Key', 'error');
    return false;
  }
  saveConfig();
  return true;
}

async function startDebate() {
  if (!validateSetup()) return;
  abortDebate();
  state.running = true;
  state.history = [];
  state.transcript = [];
  state.verdict = null;
  state.elapsed = 0;
  state.currentTurnIndex = 0;
  state.abortController = new AbortController();

  setView('arena');
  updateNav();
  renderArenaShell();
  showTransition('⚔️ 辩论开始 ⚔️');

  const plan = buildDebatePlan(state.speed);
  const flat = flattenPlan(plan);
  let freePhase = null;
  let freeTimeLeft = 0;
  let freeSide = 'pro';

  const globalStart = Date.now();
  const tickElapsed = setInterval(() => {
    state.elapsed = Math.floor((Date.now() - globalStart) / 1000);
    updateElapsedUI();
  }, 500);
  state.timers.push(tickElapsed);

  try {
    for (let i = 0; i < flat.length; i++) {
      if (!state.running) break;
      const item = flat[i];

      if (item.isFreePhase) {
        freePhase = item;
        freeTimeLeft = item.totalDuration;
        freeSide = 'pro';
        updatePhaseUI('free', '自由辩论', state.topic);
        updateStepper('free');

        while (freeTimeLeft > 0 && state.running) {
          const turnDur = Math.min(
            freeTimeLeft,
            item.minTurn + Math.floor(Math.random() * (item.maxTurn - item.minTurn))
          );
          state.phaseTimeLeft = turnDur;
          state.phaseTimeTotal = turnDur;

          await runTurn({
            side: freeSide,
            type: 'free',
            label: '自由辩论',
            duration: turnDur,
            phaseId: 'free',
          });

          freeTimeLeft -= turnDur;
          freeSide = freeSide === 'pro' ? 'con' : 'pro';
        }
        continue;
      }

      updatePhaseUI(item.phaseId, item.phaseName, state.topic);
      updateStepper(item.phaseId);
      if (i === 0 || flat[i - 1]?.phaseId !== item.phaseId) {
        await showTransition(`⚔️ ${item.phaseName} ⚔️`);
      }

      state.phaseTimeLeft = item.duration;
      state.phaseTimeTotal = item.duration;

      await runTurn({
        side: item.side,
        type: item.type,
        label: item.label,
        duration: item.duration,
        phaseId: item.phaseId,
      });
    }

    if (state.running) {
      await runJudge();
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(err.message || '辩论出错', 'error');
      console.error(err);
    }
  } finally {
    state.running = false;
    clearTimers();
    state.abortController = null;
  }
}

async function runTurn(turn) {
  const client = getClient();
  const messages = getTurnMessages(turn.side, state.topic, turn, state.transcript);
  const sideEl = turn.side === 'pro' ? 'pro' : 'con';
  setActiveSpeaker(sideEl);
  setGenerating(sideEl, true);
  clearSpeech(sideEl);

  let text = '';
  const start = Date.now();
  const countdown = setInterval(() => {
    state.phaseTimeLeft = Math.max(0, turn.duration - Math.floor((Date.now() - start) / 1000));
    updateTimerUI();
  }, 200);
  state.timers.push(countdown);

  const charDelay = SPEED_CONFIG[state.speed]?.charDelay ?? 32;
  let displayIndex = 0;
  let typewriterDone = false;

  const typewriter = setInterval(() => {
    if (displayIndex < text.length) {
      displayIndex += 1;
      setSpeech(sideEl, text.slice(0, displayIndex), true);
    } else if (typewriterDone && displayIndex >= text.length) {
      clearInterval(typewriter);
    }
  }, charDelay);
  state.timers.push(typewriter);

  try {
    for await (const chunk of client.streamChat(messages, {
      maxTokens: turn.type === 'free' ? 300 : 600,
      signal: state.abortController.signal,
    })) {
      text += chunk;
    }
  } catch (err) {
    clearInterval(countdown);
    clearInterval(typewriter);
    throw err;
  }

  typewriterDone = true;
  setSpeech(sideEl, text, false);
  setGenerating(sideEl, false);

  const entry = {
    side: turn.side,
    type: turn.type,
    label: turn.label,
    text: text.trim(),
    phaseId: turn.phaseId,
  };
  state.transcript.push(entry);

  await waitUntil(() => displayIndex >= text.length, 100);
  clearInterval(countdown);

  const minDisplay = Math.min(turn.duration * 1000, 3000);
  await sleep(minDisplay);
}

async function runJudge() {
  showTransition('⚖️ 裁判评判中 ⚖️');
  setView('arena');
  const overlay = $('#judge-overlay');
  overlay?.classList.remove('hidden');

  try {
    const client = getClient();
    const raw = await client.chat(getJudgeMessages(state.topic, state.transcript), {
      maxTokens: 600,
      temperature: 0.3,
      signal: state.abortController?.signal,
    });
    state.verdict = parseJudgeResponse(raw);
    state.verdict.duration = formatTime(state.elapsed);
    renderVerdict();
    setView('verdict');
    updateNav();
  } catch (err) {
    showToast('裁判评判失败: ' + (err.message || ''), 'error');
    state.verdict = {
      winner: 'tie',
      commentary: '裁判暂时无法给出评判，请查看完整辩论记录。',
      pro: { logic: 7, rhetoric: 7, rebuttal: 7 },
      con: { logic: 7, rhetoric: 7, rebuttal: 7 },
      proTotal: 70,
      conTotal: 70,
      margin: 0,
      duration: formatTime(state.elapsed),
    };
    renderVerdict();
    setView('verdict');
    updateNav();
  } finally {
    overlay?.classList.add('hidden');
  }
}

function renderArenaShell() {
  $('#arena-topic').textContent = `辩题：${state.topic}`;
  $('#pro-name').textContent = DEBATERS.pro.name;
  $('#con-name').textContent = DEBATERS.con.name;
  $('#pro-model').textContent = PROVIDERS[state.provider].name + ' · ' + state.model;
  $('#con-model').textContent = PROVIDERS[state.provider].name + ' · ' + state.model;
  clearSpeech('pro');
  clearSpeech('con');
  setActiveSpeaker(null);
}

function setActiveSpeaker(side) {
  $('#pro-card')?.classList.toggle('speaker-active', side === 'pro');
  $('#con-card')?.classList.toggle('speaker-active', side === 'con');
  $('#pro-card')?.classList.toggle('speaker-waiting', side === 'con');
  $('#con-card')?.classList.toggle('speaker-waiting', side === 'pro');

  $('#pro-status').textContent = side === 'pro' ? '发言中' : side === 'con' ? '等待' : '—';
  $('#con-status').textContent = side === 'con' ? '发言中' : side === 'pro' ? '等待' : '—';
}

function setGenerating(side, on) {
  const el = side === 'pro' ? $('#pro-gen') : $('#con-gen');
  if (el) el.classList.toggle('hidden', !on);
}

function clearSpeech(side) {
  const el = side === 'pro' ? $('#pro-speech') : $('#con-speech');
  if (el) el.innerHTML = '<span class="text-white/30">等待发言...</span>';
}

function setSpeech(side, text, cursor) {
  const el = side === 'pro' ? $('#pro-speech') : $('#con-speech');
  if (!el) return;
  const paras = text.split(/\n+/).filter(Boolean);
  el.innerHTML =
    paras.map((p) => `<p class="mb-2">${escapeHtml(p)}</p>`).join('') +
    (cursor ? '<span class="cursor-blink"></span>' : '');
  el.scrollTop = el.scrollHeight;
}

function updatePhaseUI(phaseId, phaseName, topic) {
  $('#phase-title').textContent = phaseName;
  $('#arena-topic').textContent = `辩题：${topic}`;
}

function updateStepper(activePhase) {
  const phases = ['opening', 'cross', 'free', 'closing'];
  const idx = phases.indexOf(activePhase);
  $$('[data-phase-step]').forEach((el, i) => {
    el.classList.remove('step-done', 'step-active', 'step-pending');
    if (i < idx) el.classList.add('step-done');
    else if (i === idx) el.classList.add('step-active');
    else el.classList.add('step-pending');
  });
}

function updateTimerUI() {
  const el = $('#phase-timer');
  const total = $('#phase-total');
  if (el) {
    el.textContent = formatTime(state.phaseTimeLeft);
    el.classList.toggle('timer-urgent', state.phaseTimeLeft <= 10 && state.phaseTimeLeft > 0);
  }
  if (total) total.textContent = `/ ${formatTime(state.phaseTimeTotal)}`;
}

function updateElapsedUI() {
  const el = $('#elapsed-timer');
  if (el) el.textContent = formatTime(state.elapsed);
}

function renderVerdict() {
  const v = state.verdict;
  if (!v) return;

  const proWins = v.winner === 'pro';
  const conWins = v.winner === 'con';
  const tie = v.winner === 'tie';

  $('#verdict-topic').textContent = `辩题：「${state.topic}」`;
  $('#judge-commentary').innerHTML = escapeHtml(v.commentary);

  const winnerName = proWins ? DEBATERS.pro.name : conWins ? DEBATERS.con.name : '平局';
  $('#verdict-headline').textContent = tie ? '平局' : `${winnerName} 获胜`;

  renderSideVerdict('pro', v.pro, v.proTotal, proWins, !conWins && !tie);
  renderSideVerdict('con', v.con, v.conTotal, conWins, !proWins && !tie);
  $('#match-duration').textContent = v.duration || formatTime(state.elapsed);

  renderScoreTable(v);
  renderTranscript();
}

function renderSideVerdict(side, scores, total, isWinner, isLoser) {
  const card = $(`#${side}-verdict-card`);
  const d = DEBATERS[side];
  card?.classList.toggle('winner-card', isWinner);
  card?.classList.toggle('loser-card', isLoser);
  $(`#${side}-verdict-name`).textContent = d.name;
  $(`#${side}-verdict-score`).textContent = total.toFixed(1);
  $(`#${side}-verdict-status`).textContent = isWinner ? '胜方' : isLoser ? '负方' : '平局';
  ['logic', 'rhetoric', 'rebuttal'].forEach((k) => {
    const pct = (scores[k] / 10) * 100;
    const bar = $(`#${side}-bar-${k}`);
    const lbl = $(`#${side}-pct-${k}`);
    if (bar) bar.style.width = `${pct}%`;
    if (lbl) lbl.textContent = `${Math.round(pct)}%`;
  });
}

function renderScoreTable(v) {
  const tbody = $('#score-table-body');
  if (!tbody) return;
  const rows = [
    ['逻辑严密', v.pro.logic, v.con.logic],
    ['修辞感染力', v.pro.rhetoric, v.con.rhetoric],
    ['反驳效力', v.pro.rebuttal, v.con.rebuttal],
  ];
  tbody.innerHTML = rows
    .map(([name, p, c]) => {
      const diff = (p - c).toFixed(1);
      const diffCls = p > c ? 'text-emerald-400' : p < c ? 'text-rose-400' : 'text-white/50';
      const sign = p > c ? '+' : '';
      return `<tr>
        <td class="px-4 py-3 text-white/80">${name}</td>
        <td class="px-4 py-3 text-center text-cyan-300">${p}/10</td>
        <td class="px-4 py-3 text-center text-amber-300">${c}/10</td>
        <td class="px-4 py-3 text-center ${diffCls}">${sign}${diff}</td>
      </tr>`;
    })
    .join('');
}

function renderTranscript() {
  const el = $('#transcript-list');
  if (!el) return;
  el.innerHTML = state.transcript
    .map(
      (t, i) => `<div class="transcript-item ${t.side}">
        <div class="text-xs text-white/40 mb-1">${i + 1}. ${t.side === 'pro' ? '正方' : '反方'} · ${t.label}</div>
        <div class="text-sm text-white/80 leading-relaxed">${escapeHtml(t.text)}</div>
      </div>`
    )
    .join('');
}

function resetToSetup() {
  abortDebate();
  state.verdict = null;
  state.transcript = [];
  setView('setup');
}

function showTransition(text) {
  return new Promise((resolve) => {
    const el = $('#transition-overlay');
    const txt = $('#transition-text');
    if (!el || !txt) return resolve();
    txt.textContent = text;
    el.classList.remove('hidden');
    const ms = SPEED_CONFIG[state.speed]?.transitionMs ?? 2000;
    setTimeout(() => {
      el.classList.add('hidden');
      resolve();
    }, ms);
  });
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitUntil(fn, interval) {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (fn()) {
        clearInterval(t);
        resolve();
      }
    }, interval);
  });
}

function init() {
  loadConfig();
  setView('setup');

  const topicInput = $('#topic-input');
  if (topicInput && state.topic) topicInput.value = state.topic;

  $('#provider-select').value = state.provider;
  renderModelOptions();
  $('#api-key-input').value = state.apiKey;
  $('#remember-key').checked = state.rememberKey;
  $('#base-url-input').value = state.baseUrl;
  $('#base-url-wrap').classList.toggle('hidden', state.provider === 'bailian');

  const p = PROVIDERS[state.provider];
  $('#api-key-input').placeholder = p.keyPlaceholder;
  $('#key-link').href = p.keyLink;

  $$('[data-speed]').forEach((b) => {
    b.classList.toggle('speed-active', b.dataset.speed === state.speed);
  });

  const presets = $('#preset-topics');
  if (presets) {
    presets.innerHTML = PRESET_TOPICS.map(
      (t) =>
        `<button type="button" data-preset="${escapeHtml(t)}" class="preset-chip">${escapeHtml(t.slice(0, 14))}${t.length > 14 ? '…' : ''}</button>`
    ).join('');
  }

  bindSetup();
  bindNav();
  updateTopicCount();
}

document.addEventListener('DOMContentLoaded', init);
