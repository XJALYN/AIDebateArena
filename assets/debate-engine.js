/**
 * Debate flow orchestration
 */

export const DEBATERS = {
  pro: { id: 'pro', name: '正方·逻格斯', side: 'affirmative', stance: '支持辩题' },
  con: { id: 'con', name: '反方·锐思', side: 'negative', stance: '反对辩题' },
};

export const SPEED_CONFIG = {
  fast: { label: '快', multiplier: 0.4, charDelay: 18, transitionMs: 1200 },
  medium: { label: '中', multiplier: 1, charDelay: 32, transitionMs: 2000 },
  slow: { label: '慢', multiplier: 1.8, charDelay: 50, transitionMs: 2800 },
};

function scaled(seconds, multiplier) {
  return Math.max(15, Math.round(seconds * multiplier));
}

export function buildDebatePlan(speed = 'medium') {
  const m = SPEED_CONFIG[speed]?.multiplier ?? 1;
  return [
    {
      phaseId: 'opening',
      phaseName: '立论陈词',
      steps: [
        { side: 'pro', type: 'opening', label: '正方立论', duration: scaled(180, m) },
        { side: 'con', type: 'opening', label: '反方立论', duration: scaled(180, m) },
      ],
    },
    {
      phaseId: 'cross',
      phaseName: '攻辩环节',
      steps: [
        { side: 'pro', type: 'question', label: '正方质询', duration: scaled(120, m) },
        { side: 'con', type: 'answer', label: '反方回应', duration: scaled(120, m) },
        { side: 'con', type: 'question', label: '反方质询', duration: scaled(120, m) },
        { side: 'pro', type: 'answer', label: '正方回应', duration: scaled(120, m) },
      ],
    },
    {
      phaseId: 'free',
      phaseName: '自由辩论',
      totalDuration: scaled(240, m),
      minTurn: scaled(12, m),
      maxTurn: scaled(28, m),
    },
    {
      phaseId: 'closing',
      phaseName: '总结陈词',
      steps: [
        { side: 'con', type: 'closing', label: '反方总结', duration: scaled(120, m) },
        { side: 'pro', type: 'closing', label: '正方总结', duration: scaled(120, m) },
      ],
    },
  ];
}

export function flattenPlan(plan) {
  const turns = [];
  for (const phase of plan) {
    if (phase.phaseId === 'free') {
      turns.push({ ...phase, isFreePhase: true });
    } else {
      for (const step of phase.steps) {
        turns.push({ ...phase, ...step, isFreePhase: false });
      }
    }
  }
  return turns;
}

function systemPrompt(side, topic) {
  const d = DEBATERS[side];
  const role =
    side === 'pro'
      ? '正方辩手，论证辩题成立'
      : '反方辩手，论证辩题不成立';
  return `你是${d.name}，${role}。
辩题：「${topic}」
要求：使用中文，逻辑清晰，有论据和反驳；口语化辩论风格；不要自称 AI；不要输出 markdown 标题；控制在指定字数内。`;
}

function buildMessages(side, topic, turnType, history, opponentLast) {
  const limits = {
    opening: '200-350字',
    question: '80-150字，以提问为主',
    answer: '150-250字，回应并反驳',
    free: '60-120字，短促交锋',
    closing: '180-280字，总结全场',
  };

  const typeDesc = {
    opening: '立论陈词',
    question: '攻辩质询（向对方提问并指出漏洞）',
    answer: '攻辩回应（回答对方质询并反击）',
    free: '自由辩论发言',
    closing: '总结陈词',
  };

  let user = `请发表${typeDesc[turnType] || '辩论发言'}，${limits[turnType] || '150字左右'}。`;

  if (opponentLast) {
    user += `\n\n对方刚才说：\n「${opponentLast.slice(0, 600)}」\n请针对性回应。`;
  }

  if (history.length > 0) {
    const summary = history
      .slice(-6)
      .map((h) => `[${h.side === 'pro' ? '正方' : '反方'}·${h.label}] ${h.text.slice(0, 120)}...`)
      .join('\n');
    user += `\n\n此前要点：\n${summary}`;
  }

  return [
    { role: 'system', content: systemPrompt(side, topic) },
    { role: 'user', content: user },
  ];
}

export function getTurnMessages(side, topic, turn, history) {
  const opponent = history.filter((h) => h.side !== side).pop();
  return buildMessages(side, topic, turn.type, history, opponent?.text);
}

export function getJudgeMessages(topic, history) {
  const transcript = history
    .map((h, i) => `${i + 1}. [${h.side === 'pro' ? '正方' : '反方'}·${h.label}]\n${h.text}`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: `你是 AI 裁判·墨丘利，公正评判辩论赛。只输出 JSON，无其他文字。格式：
{"winner":"pro"|"con"|"tie","commentary":"150字以内点评","pro":{"logic":0-10,"rhetoric":0-10,"rebuttal":0-10},"con":{"logic":0-10,"rhetoric":0-10,"rebuttal":0-10},"margin":数字}`,
    },
    {
      role: 'user',
      content: `辩题：「${topic}」\n\n完整记录：\n${transcript}\n\n请评判胜负并打分。`,
    },
  ];
}

export function parseJudgeResponse(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('裁判返回格式无效');
  const data = JSON.parse(match[0]);
  const score = (s) => ((s.logic + s.rhetoric + s.rebuttal) / 3) * 10;
  return {
    winner: data.winner || 'tie',
    commentary: data.commentary || '双方表现旗鼓相当。',
    pro: data.pro || { logic: 7, rhetoric: 7, rebuttal: 7 },
    con: data.con || { logic: 7, rhetoric: 7, rebuttal: 7 },
    proTotal: score(data.pro || { logic: 7, rhetoric: 7, rebuttal: 7 }),
    conTotal: score(data.con || { logic: 7, rhetoric: 7, rebuttal: 7 }),
    margin: data.margin ?? Math.abs(score(data.pro || {}) - score(data.con || {})),
  };
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export const PRESET_TOPICS = [
  '人工智能是否威胁人类生存',
  '远程办公利大于弊',
  '社交媒体应该被监管为公共事业',
  '全民基本收入是经济解药还是系统崩溃',
  '太空殖民是必要之举还是昂贵幻想',
  '人工意识在伦理上是否可被允许',
];
