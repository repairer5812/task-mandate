import { consumePresenterCodeFromUrl, createDelegationSession, requestInterpret, runApplyScenario } from "./api.js";
import { EXAMPLE_UTTERANCES, formatActionsKo, formatDurationKo, formatSeoulTime, formatSourceKo, previewIssuedDurationSec, REJECTION_TESTS, STEP_LIST } from "./constants.js";
import { createFallback2D } from "./fallback-2d.js";
import { canUseWebGL, createOfficeScene } from "./scene.js";
import { initSpeechControl, renderSlipList } from "./speech.js";
import { createTimeline } from "./timeline.js";

async function initSimulationApp() {
  consumePresenterCodeFromUrl();

  const clockEl = document.getElementById("clock");
  const stageWrapEl = document.getElementById("stage-wrap");
  const stageCanvasEl = document.getElementById("stage-canvas");
  const stage2dEl = document.getElementById("stage-2d");
  const bubbleLayerEl = document.getElementById("bubble-layer");
  const stepsBarEl = document.getElementById("steps-bar");
  const subtitleEl = document.getElementById("subtitle");

  const spokenTextEl = document.getElementById("spoken-text");
  const micBtn = document.getElementById("mic-btn");
  const micStatusEl = document.getElementById("mic-status");
  const exampleListEl = document.getElementById("example-list");
  const textForm = document.getElementById("text-form");
  const textInput = document.getElementById("text-input");

  const interpretCardEl = document.getElementById("interpret-card");
  const cardTitleEl = document.getElementById("card-title");
  const cardMetaEl = document.getElementById("card-meta");
  const cardSourceEl = document.getElementById("card-source");
  const retrySayBtn = document.getElementById("retry-say-btn");

  const delegateBoxEl = document.getElementById("delegate-box");
  const delegateBtn = document.getElementById("delegate-btn");

  const resultPanelEl = document.getElementById("result-panel");
  const rejectBtnsEl = document.getElementById("reject-buttons");
  const restartBtn = document.getElementById("restart-btn");
  const slipListEl = document.getElementById("slip-list");

  function tickClock() {
    clockEl.textContent = formatSeoulTime(new Date().toISOString());
  }
  tickClock();
  window.setInterval(tickClock, 1000);

  const stepNodes = [];
  for (let i = 0; i < STEP_LIST.length; i++) {
    const item = STEP_LIST[i];
    const li = document.createElement("li");
    li.className = "step";
    li.dataset.step = String(item.step);
    li.textContent = String(item.step) + " " + item.title;
    stepsBarEl.append(li);
    stepNodes.push(li);
  }

  const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let use2D = reduceMotionQuery.matches || !canUseWebGL();
  let scene3d = null;
  const fallback2d = createFallback2D(stage2dEl);

  if (!use2D) {
    try {
      scene3d = createOfficeScene(stageCanvasEl);
    } catch {
      use2D = true;
      scene3d = null;
    }
  }

  stage2dEl.hidden = !use2D;
  stageCanvasEl.hidden = use2D;
  bubbleLayerEl.hidden = use2D;
  if (!use2D && scene3d) scene3d.resize();

  const timeline = createTimeline({ bubbleLayer: bubbleLayerEl, resultPanel: resultPanelEl, scene3d, fallback2d, is2DMode: () => use2D });

  window.addEventListener("resize", () => {
    if (scene3d && !use2D) {
      scene3d.resize();
      timeline.syncBubblePositions();
    }
  });

  let busy = false;
  let currentInterpreted = null;
  let currentSession = null;
  const slipHistory = [];

  function setStep(stepNumber, customSubtitle) {
    document.body.dataset.step = String(stepNumber);
    for (let i = 0; i < stepNodes.length; i++) {
      const idx = i + 1;
      const node = stepNodes[i];
      node.classList.remove("done", "on");
      if (idx < stepNumber) node.classList.add("done");
      else if (idx === stepNumber) node.classList.add("on");
    }
    const found = STEP_LIST[stepNumber - 1];
    subtitleEl.textContent = customSubtitle || (found ? found.subtitle : "");
    fallback2d.setStep(stepNumber);
  }

  function scrollStageToTopOnMobile() {
    if (window.innerWidth <= 1100 && stageWrapEl && typeof stageWrapEl.scrollIntoView === "function") {
      stageWrapEl.scrollIntoView({ block: "start", behavior: reduceMotionQuery.matches ? "auto" : "smooth" });
    }
  }

  function setControlsDisabled(disabled) {
    busy = disabled;
    micBtn.disabled = disabled;
    delegateBtn.disabled = disabled;
    textInput.disabled = disabled;
    const buttons = document.querySelectorAll(".example-btn, .reject-btn, .text-submit-btn");
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].disabled = disabled;
    }
  }

  async function handleUtterance(rawText) {
    const text = String(rawText || "").trim();
    if (!text || busy) return;
    spokenTextEl.textContent = '"' + text + '"';
    textInput.value = text;
    setControlsDisabled(true);
    setStep(2, "2단계: 말을 해석하여 어떤 민원인지 확인하고 있습니다");

    try {
      const interpreted = await requestInterpret(text);
      currentInterpreted = interpreted;
      fallback2d.setInterpretation(interpreted);
      interpretCardEl.hidden = false;

      if (!interpreted.service) {
        cardTitleEl.textContent = "할 수 없는 일입니다";
        cardMetaEl.textContent = "기초연금 신청, 등본 발급, 장애인 콜택시 등록 중에서 말씀해 주세요.";
        cardSourceEl.textContent = formatSourceKo(interpreted.source);
        retrySayBtn.hidden = false;
        delegateBoxEl.hidden = true;
        setStep(2, "2단계: 할 수 없는 일입니다. 다시 말하기를 눌러 주세요");
      } else {
        cardTitleEl.textContent = interpreted.title || interpreted.service;
        cardMetaEl.textContent = "기간 " + formatDurationKo(previewIssuedDurationSec(interpreted.durationSec)) + ", 횟수 " + formatActionsKo(interpreted.maxActions);
        cardSourceEl.textContent = formatSourceKo(interpreted.source);
        retrySayBtn.hidden = true;
        delegateBoxEl.hidden = false;
        setStep(3, "3단계: 내용을 확인한 뒤 맡기기 단추를 눌러 위임장을 발급하세요");
      }
    } catch (err) {
      interpretCardEl.hidden = false;
      cardTitleEl.textContent = "말 해석에 실패했습니다";
      cardMetaEl.textContent = err instanceof Error ? err.message : "잠시 뒤 다시 시도해 주세요";
      cardSourceEl.textContent = "";
      retrySayBtn.hidden = false;
      delegateBoxEl.hidden = true;
    } finally {
      setControlsDisabled(false);
    }
  }

  async function runStageJourney(scenarioId, isRetry) {
    if (!currentSession || busy) return;
    setControlsDisabled(true);
    const hasMandate = scenarioId !== "no-mandate";
    resultPanelEl.hidden = true;
    scrollStageToTopOnMobile();

    try {
      setStep(4, hasMandate ? "4단계: 에이전트가 위임장을 들고 점선을 따라 2번 창구로 걸어갑니다" : "4단계: 에이전트가 위임장 없이 점선을 따라 2번 창구로 걸어갑니다");
      await timeline.runWalkToCounter({ hasMandate, isRetry });

      setStep(5, "5단계: 창구 직원이 위임장과 서명을 확인하는 중");
      const targetTitle = scenarioId === "other-service" ? (currentSession.service === "basic-pension" ? "주민등록표 등본 발급(모의)" : "기초연금 신청(모의)") : currentSession.title;

      const applyPromise = runApplyScenario(scenarioId, currentSession);
      const result = await timeline.runCounterDialogue({ serviceTitle: targetTitle, hasMandate, requestPromise: applyPromise });

      setStep(6, result.ok ? "6단계: 위임장과 서명이 통과되어 직원이 접수 도장을 찍습니다" : "6단계: 검증에서 거절되어 직원이 반려 도장을 찍습니다 (" + result.reason + ")");
      await timeline.runStampCeremony(result, hasMandate, (awaitingStamp) => {
        slipHistory.unshift(result);
        resultPanelEl.hidden = false;
        return renderSlipList(slipListEl, slipHistory, awaitingStamp);
      });

      setStep(7, result.ok ? "7단계: 접수되었습니다. 오른쪽 단추로 다섯 가지 반려 사례를 시험해 보세요" : "7단계: 반려 접수증이 추가되었습니다 (" + result.reason + ")");
      await timeline.runEnterResultStage(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "요청 처리 중 오류가 났습니다";
      setStep(7, "오류: " + msg);
    } finally {
      setControlsDisabled(false);
    }
  }

  delegateBtn.addEventListener("click", async () => {
    if (!currentInterpreted?.service || busy) return;
    setControlsDisabled(true);
    setStep(3, "3단계: 브라우저에서 Ed25519 키와 모의 본인 확인 보증서로 위임장을 발급하는 중");
    try {
      currentSession = await createDelegationSession(currentInterpreted);
      cardMetaEl.textContent = "기간 " + formatDurationKo(currentSession.durationSec) + ", 횟수 " + formatActionsKo(currentSession.maxActions);
      scrollStageToTopOnMobile();
      await timeline.runMandateAppear();
    } catch (err) {
      setControlsDisabled(false);
      const msg = err instanceof Error ? err.message : "위임장 발급에 실패했습니다";
      setStep(3, "오류: " + msg);
      return;
    }
    setControlsDisabled(false);
    await runStageJourney("normal", false);
  });

  for (let i = 0; i < EXAMPLE_UTTERANCES.length; i++) {
    const phrase = EXAMPLE_UTTERANCES[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "example-btn";
    btn.dataset.utterance = phrase;
    btn.textContent = phrase;
    btn.addEventListener("click", () => handleUtterance(phrase));
    exampleListEl.append(btn);
  }

  textForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleUtterance(textInput.value);
  });

  retrySayBtn.addEventListener("click", () => {
    if (busy) return;
    currentInterpreted = null;
    interpretCardEl.hidden = true;
    delegateBoxEl.hidden = true;
    spokenTextEl.textContent = '"무엇을 맡기시겠습니까?"';
    setStep(1);
    textInput.focus();
  });

  for (let i = 0; i < REJECTION_TESTS.length; i++) {
    const item = REJECTION_TESTS[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reject-btn";
    btn.dataset.scenario = item.id;
    btn.dataset.expectedCode = item.expectedCode;
    btn.textContent = item.label;
    btn.addEventListener("click", () => runStageJourney(item.id, true));
    rejectBtnsEl.append(btn);
  }

  restartBtn.addEventListener("click", () => {
    if (busy) return;
    currentInterpreted = null;
    currentSession = null;
    interpretCardEl.hidden = true;
    delegateBoxEl.hidden = true;
    resultPanelEl.hidden = true;
    spokenTextEl.textContent = '"기초연금 신청해 줘"';
    textInput.value = "";
    timeline.resetStage(false);
    setStep(1);
  });

  initSpeechControl({ micBtn, micStatusEl, spokenTextEl, textInput, onStartStep: () => setStep(1), onFinalUtterance: (text) => handleUtterance(text), isBusy: () => busy });

  setStep(1);
  if (scene3d?.ready) {
    await scene3d.ready;
  }
  document.body.dataset.ready = "1";
}

initSimulationApp();
