// 2D fallback when WebGL is missing or prefers-reduced-motion is set.

import { formatActionsKo, formatDurationKo, formatSourceKo, previewIssuedDurationSec, STEP_LIST } from "./constants.js";

export function createFallback2D(container) {
  const wrap = document.createElement("div");
  wrap.className = "f2d-board";

  const head = document.createElement("div");
  head.className = "f2d-head";
  const headTitle = document.createElement("h2");
  headTitle.className = "f2d-title";
  headTitle.textContent = "모의 민원실 창구 (2D 단계 안내)";
  const headDesc = document.createElement("p");
  headDesc.className = "f2d-desc";
  headDesc.textContent = "움직임 줄이기 설정 또는 3D 미지원 환경에서는 7단계 여정을 큰 글자 목록으로 보여 줍니다.";
  head.append(headTitle, headDesc);

  const bodyGrid = document.createElement("div");
  bodyGrid.className = "f2d-grid";

  const stepListEl = document.createElement("ol");
  stepListEl.className = "f2d-steps";
  const stepItems = [];

  for (let i = 0; i < STEP_LIST.length; i++) {
    const item = STEP_LIST[i];
    const li = document.createElement("li");
    li.className = "f2d-step";

    const badge = document.createElement("span");
    badge.className = "f2d-step-no";
    badge.textContent = String(item.step) + "단계";

    const name = document.createElement("strong");
    name.className = "f2d-step-name";
    name.textContent = item.title;

    const state = document.createElement("span");
    state.className = "f2d-step-state";
    state.textContent = "대기";

    li.append(badge, name, state);
    stepListEl.append(li);
    stepItems.push({ li, state });
  }

  const dialogBox = document.createElement("div");
  dialogBox.className = "f2d-dialog";

  const mandateLine = document.createElement("p");
  mandateLine.className = "f2d-mandate";
  mandateLine.textContent = "위임장 상태: 아직 발급 전입니다.";

  const agentLine = document.createElement("p");
  agentLine.className = "f2d-line";
  agentLine.textContent = "에이전트: 대기석에서 명령을 기다리고 있습니다.";

  const clerkLine = document.createElement("p");
  clerkLine.className = "f2d-line";
  clerkLine.textContent = "2번 창구 직원: 위임장과 서명이 들어오면 검증합니다.";

  const stampRow = document.createElement("div");
  stampRow.className = "f2d-stamp-row";
  stampRow.hidden = true;

  const stampBadge = document.createElement("span");
  stampBadge.className = "stamp";
  const stampReason = document.createElement("span");
  stampReason.className = "f2d-stamp-reason";
  stampRow.append(stampBadge, stampReason);

  dialogBox.append(mandateLine, agentLine, clerkLine, stampRow);
  bodyGrid.append(stepListEl, dialogBox);
  wrap.append(head, bodyGrid);
  container.replaceChildren(wrap);

  function setStep(activeStep) {
    for (let i = 0; i < stepItems.length; i++) {
      const s = i + 1;
      const entry = stepItems[i];
      entry.li.classList.remove("is-done", "is-active");
      if (s < activeStep) {
        entry.li.classList.add("is-done");
        entry.state.textContent = "완료";
      } else if (s === activeStep) {
        entry.li.classList.add("is-active");
        entry.state.textContent = "진행 중";
      } else {
        entry.state.textContent = "대기";
      }
    }
  }

  function setInterpretation(interpreted) {
    if (!interpreted?.service) {
      mandateLine.textContent = "위임장 상태: 할 수 없는 일입니다. 다시 말씀해 주세요.";
      return;
    }
    mandateLine.textContent = "해석 결과: " + (interpreted.title || interpreted.service) + " / 기간 " + formatDurationKo(previewIssuedDurationSec(interpreted.durationSec)) + " / 횟수 " + formatActionsKo(interpreted.maxActions) + " (" + formatSourceKo(interpreted.source) + ")";
  }

  function setDialogue(agentText, clerkText) {
    if (agentText) {
      agentLine.textContent = "에이전트: " + agentText;
    }
    if (clerkText) {
      clerkLine.textContent = "2번 창구 직원: " + clerkText;
    }
  }

  function setVerdict(result) {
    if (!result) {
      stampRow.hidden = true;
      return;
    }
    stampRow.hidden = false;
    stampRow.className = "f2d-stamp-row " + (result.ok ? "is-pass" : "is-deny");
    stampBadge.textContent = result.ok ? "접수" : "반려";
    stampReason.textContent = result.title + " - " + result.reason;
  }

  function reset() {
    setStep(1);
    mandateLine.textContent = "위임장 상태: 아직 발급 전입니다.";
    agentLine.textContent = "에이전트: 대기석에서 명령을 기다리고 있습니다.";
    clerkLine.textContent = "2번 창구 직원: 위임장과 서명이 들어오면 검증합니다.";
    stampRow.hidden = true;
  }

  return { setStep, setInterpretation, setDialogue, setVerdict, reset };
}
