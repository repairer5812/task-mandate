// No I/O. Formatters stay pure.

export const REASON_MAP = new Map([
  ["NO_MANDATE", "위임장이 없습니다"],
  ["TASK_NOT_ALLOWED", "맡긴 일이 아닙니다"],
  ["LIMIT_EXCEEDED", "맡긴 횟수를 다 썼습니다"],
  ["KEY_MISMATCH", "위임받은 에이전트가 아닙니다"],
  ["EXPIRED", "위임 기간이 끝났습니다"],
  ["SUPERSEDED", "같은 사람이 다른 에이전트에게 다시 맡겼습니다"],
  ["PERSON_REQUIRED", "본인 확인이 없습니다"],
  ["PERSON_INVALID", "본인 확인이 올바르지 않습니다"],
  ["too-large", "요청이 너무 큽니다"],
  ["bad-request", "요청 형식이 잘못되었습니다"],
  ["not-found", "신청할 수 있는 민원이 아닙니다"],
  ["rate-limited", "요청이 너무 잦습니다"],
]);

export const SERVICE_TITLES = new Map([
  ["basic-pension", "기초연금 신청(모의)"],
  ["resident-copy", "주민등록표 등본 발급(모의)"],
  ["disability-taxi", "장애인 콜택시 이용 등록(모의)"],
]);

export const STEP_LIST = [
  { step: 1, title: "말하기", subtitle: "1단계: 마이크로 말하거나 예문 단추를 눌러 에이전트에게 할 일을 시킵니다" },
  { step: 2, title: "알아듣기", subtitle: "2단계: 해석된 민원 종류와 기간, 횟수를 확인합니다" },
  { step: 3, title: "맡기기", subtitle: "3단계: 브라우저에서 키를 만들고 모의 본인 확인 뒤 위임장을 발급합니다" },
  { step: 4, title: "창구로", subtitle: "4단계: 에이전트가 위임장을 들고 점선을 따라 2번 창구로 걸어갑니다" },
  { step: 5, title: "창구 대화", subtitle: "5단계: 창구 직원이 위임장과 서명을 확인하는 중" },
  { step: 6, title: "도장", subtitle: "6단계: 검증 결과에 따라 직원이 접수 또는 반려 도장을 찍습니다" },
  { step: 7, title: "결과", subtitle: "7단계: 접수증이 발급되었습니다. 거절 시험 단추로 다섯 가지 반려를 확인해 보세요" },
];

export const EXAMPLE_UTTERANCES = ["기초연금 신청해 줘", "등본 두 번 떼 줘, 오늘까지", "콜택시 등록 10분 안에 세 번"];

export const REJECTION_TESTS = [
  { id: "other-service", label: "다른 민원 신청", expectedCode: "TASK_NOT_ALLOWED" },
  { id: "once-more", label: "한 번 더", expectedCode: "LIMIT_EXCEEDED" },
  { id: "other-agent", label: "다른 에이전트", expectedCode: "KEY_MISMATCH" },
  { id: "expired", label: "기간 끝난 위임장", expectedCode: "EXPIRED" },
  { id: "no-mandate", label: "위임장 없이", expectedCode: "NO_MANDATE" },
];

const seoulTimeFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export function formatSeoulTime(iso) {
  if (typeof iso !== "string") return "00:00:00";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = seoulTimeFormatter.formatToParts(date);
  let h = "00";
  let m = "00";
  let s = "00";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type === "hour") h = p.value;
    else if (p.type === "minute") m = p.value;
    else if (p.type === "second") s = p.value;
  }
  return h + ":" + m + ":" + s;
}

// The mock identity attestation lasts 10 minutes. The card shows the duration actually issued inside that window.
export const ATTEST_CHUNK_SEC = 600;

export function previewIssuedDurationSec(durationSec) {
  const value = typeof durationSec === "number" && Number.isFinite(durationSec) ? durationSec : ATTEST_CHUNK_SEC;
  return Math.max(1, Math.min(value, ATTEST_CHUNK_SEC));
}

export function formatDurationKo(durationSec) {
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec)) return "1시간";
  if (durationSec === 86400) return "오늘까지 (24시간)";
  if (durationSec === 3600) return "1시간";
  if (durationSec === 600) return "10분";
  if (durationSec % 3600 === 0) return String(durationSec / 3600) + "시간";
  if (durationSec % 60 === 0) return String(durationSec / 60) + "분";
  return String(durationSec) + "초";
}

export function formatActionsKo(maxActions) {
  const n = typeof maxActions === "number" && Number.isFinite(maxActions) ? maxActions : 1;
  return String(n) + "번";
}

export function formatSourceKo(source) {
  return source === "llm" ? "LLM이 알아들었습니다" : "규칙으로 알아들었습니다";
}

export function resolveServiceTitle(serviceId) {
  if (typeof serviceId !== "string" || serviceId.length === 0) return "알 수 없음";
  return SERVICE_TITLES.get(serviceId) || "목록에 없는 민원";
}

export function resolveReason(status, code) {
  if (status === 200) return "접수되었습니다";
  const safeCode = typeof code === "string" ? code : "";
  if (!safeCode) return "요청이 거절되었습니다";
  return REASON_MAP.get(safeCode) || safeCode;
}

export function pickOtherService(serviceId) {
  return serviceId === "basic-pension" ? "resident-copy" : "basic-pension";
}
