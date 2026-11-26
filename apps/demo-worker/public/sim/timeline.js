import { syncBubblePositions as placeBubbles } from "./timeline-layout.js";

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function animateProgress(durationMs, onFrame) {
  return new Promise((resolve) => {
    const start = performance.now();
    function step(now) {
      const t = durationMs <= 0 ? 1 : Math.min(1, (now - start) / durationMs);
      onFrame(t);
      if (t < 1) window.requestAnimationFrame(step);
      else resolve();
    }
    window.requestAnimationFrame(step);
  });
}

export function createTimeline({ bubbleLayer, resultPanel, scene3d, fallback2d, is2DMode }) {
  let agentBubbleEl = null;
  let clerkBubbleEl = null;
  let bigStampEl = null;
  let currentCamMode = "base";

  function clearOverlay() {
    bubbleLayer.replaceChildren();
    agentBubbleEl = null;
    clerkBubbleEl = null;
    bigStampEl = null;
  }

  function setPhase(phase) {
    document.body.dataset.phase = phase;
  }

  function syncBubblePositions() {
    placeBubbles({ bubbleLayer, resultPanel, scene3d, is2DMode, agentBubbleEl, clerkBubbleEl });
  }

  function showAgentBubble(text) {
    if (fallback2d) fallback2d.setDialogue(text, null);
    if (!scene3d || is2DMode()) return;
    if (!agentBubbleEl) {
      agentBubbleEl = document.createElement("div");
      agentBubbleEl.className = "bubble agent-bubble";
      bubbleLayer.append(agentBubbleEl);
    }
    agentBubbleEl.hidden = false;
    agentBubbleEl.textContent = text;
    syncBubblePositions();
  }

  function showClerkBubble(text) {
    if (fallback2d) fallback2d.setDialogue(null, text);
    if (!scene3d || is2DMode()) return;
    if (!clerkBubbleEl) {
      clerkBubbleEl = document.createElement("div");
      clerkBubbleEl.className = "bubble clerk-bubble";
      bubbleLayer.append(clerkBubbleEl);
    }
    clerkBubbleEl.hidden = false;
    clerkBubbleEl.textContent = text;
    syncBubblePositions();
  }

  // Pressing delegate pops a white mandate up into the agent's hand.
  async function runMandateAppear() {
    setPhase("mandate-pop");
    if (!scene3d || is2DMode()) return;
    scene3d.setAgentPose(scene3d.WAIT_T, 0, true, false);
    await animateProgress(420, (t) => scene3d.setMandatePop(t));
    setPhase("mandate-ready");
    await sleep(380);
  }

  async function runWalkToCounter({ hasMandate, isRetry }) {
    setPhase("walk");
    clearOverlay();
    if (fallback2d) {
      fallback2d.setVerdict(null);
      fallback2d.setDialogue(hasMandate ? "위임장을 들고 2번 창구로 이동합니다." : "위임장 없이 2번 창구로 이동합니다.", "창구 앞 에이전트를 맞이합니다.");
    }
    if (!scene3d || is2DMode()) {
      await sleep(50);
      return;
    }
    const fromCam = currentCamMode;
    currentCamMode = "base";
    const startT = scene3d.WAIT_T;
    const durationMs = isRetry ? 1500 : 2100;
    const stepsCount = isRetry ? 6 : 8;
    scene3d.setClerkHeadMotion(0, 0);
    scene3d.setMandateExtend(0, hasMandate);
    await animateProgress(durationMs, (progress) => {
      if (fromCam !== "base") scene3d.setCameraTransition(fromCam, "base", Math.min(1, progress * 2));
      const eased = 1 - (1 - progress) ** 2;
      const pathT = startT + (1 - startT) * eased;
      const bobY = progress < 0.98 ? Math.abs(Math.sin(progress * Math.PI * stepsCount)) * 0.13 : 0;
      scene3d.setAgentPose(pathT, bobY, hasMandate, progress >= 0.95);
    });
    scene3d.setCameraMode("base");
    scene3d.setAgentPose(1, 0, hasMandate, true);
  }

  // The camera eases toward counter 2 for about 1.2s while the agent offers the mandate. No mandate means an empty hand.
  async function runCounterDialogue({ serviceTitle, hasMandate, requestPromise }) {
    setPhase("dialogue");
    const agentLine = hasMandate ? serviceTitle + "하러 왔습니다.\n위임장 여기 있습니다" : serviceTitle + "하러 왔습니다.\n위임장 없이 왔습니다";
    const clerkLine = "위임장과 서명을 확인하겠습니다";

    showAgentBubble(agentLine);

    if (!scene3d || is2DMode()) {
      showClerkBubble(clerkLine);
      const [res2d] = await Promise.all([requestPromise, sleep(40)]);
      return res2d;
    }

    const fromCam = currentCamMode;
    currentCamMode = "zoom";
    let clerkShown = false;

    const zoomPromise = animateProgress(1200, (t) => {
      const eased = 1 - (1 - t) ** 2.2;
      scene3d.setCameraTransition(fromCam, "zoom", eased);
      scene3d.setMandateExtend(eased, hasMandate);
      if (t >= 0.35 && !clerkShown) {
        clerkShown = true;
        showClerkBubble(clerkLine);
      }
      syncBubblePositions();
    });

    const [result] = await Promise.all([requestPromise, zoomPromise]);
    if (!clerkShown) showClerkBubble(clerkLine);
    setPhase("dialogue-ready");
    await sleep(450);
    return result;
  }

  // Order: head motion and mandate return, hand press first (400ms), big stamp in the lower-third center (600ms), then FLIP (600ms).
  async function runStampCeremony(result, hasMandate, onPrepareSlip) {
    if (fallback2d) fallback2d.setVerdict(result);
    if (!scene3d || is2DMode()) {
      if (onPrepareSlip) onPrepareSlip(false);
      await sleep(50);
      return;
    }

    setPhase(result.ok ? "head-nod" : "head-shake");
    await animateProgress(520, (t) => {
      if (result.ok) {
        scene3d.setClerkHeadMotion(Math.sin(t * Math.PI * 2), 0);
      } else {
        scene3d.setClerkHeadMotion(0, Math.sin(t * Math.PI * 2));
        if (hasMandate) scene3d.setMandateExtend(1 - t, true);
      }
    });
    scene3d.setClerkHeadMotion(0, 0);

    // Show the clerk hand pressing for 400ms before the big stamp appears.
    if (clerkBubbleEl) clerkBubbleEl.hidden = true;
    if (agentBubbleEl) agentBubbleEl.hidden = true;
    setPhase("hand-stamp");
    await animateProgress(400, (t) => scene3d.setClerkStampPress(t * t));
    setPhase("hand-stamped");
    await sleep(120);

    if (bigStampEl) bigStampEl.remove();
    bigStampEl = document.createElement("div");
    bigStampEl.className = "big-stamp " + (result.ok ? "is-pass" : "is-deny");
    bigStampEl.textContent = result.ok ? "접수" : "반려";
    bubbleLayer.append(bigStampEl);
    setPhase("big-stamp");

    // Hold the big stamp in the lower-third center for 600ms. The clerk hand stays briefly, then rises.
    await Promise.all([sleep(600), sleep(220).then(() => animateProgress(240, (t) => scene3d.setClerkStampPress(1 - t)))]);

    const targetStampEl = onPrepareSlip ? onPrepareSlip(true) : null;
    const fromCam = currentCamMode;
    currentCamMode = "result";
    setPhase("stamp-fly");

    if (bigStampEl && targetStampEl) {
      const srcRect = bigStampEl.getBoundingClientRect();
      const dstRect = targetStampEl.getBoundingClientRect();
      if (srcRect.width > 0 && dstRect.width > 0) {
        const dx = dstRect.left + dstRect.width / 2 - (srcRect.left + srcRect.width / 2);
        const dy = dstRect.top + dstRect.height / 2 - (srcRect.top + srcRect.height / 2);
        const scale = Math.max(0.12, dstRect.width / srcRect.width);
        bigStampEl.classList.add("is-flying");
        bigStampEl.getBoundingClientRect();
        bigStampEl.style.transform = "translate(calc(-50% + " + dx.toFixed(1) + "px), calc(-50% + " + dy.toFixed(1) + "px)) rotate(-6deg) scale(" + scale.toFixed(4) + ")";
      }
    }

    await animateProgress(600, (t) => scene3d.setCameraTransition(fromCam, "result", 1 - (1 - t) ** 2));
    if (targetStampEl) targetStampEl.classList.remove("is-awaiting");
    if (bigStampEl) {
      bigStampEl.remove();
      bigStampEl = null;
    }
  }

  async function runEnterResultStage(result) {
    if (agentBubbleEl) agentBubbleEl.hidden = false;
    const clerkVerdictLine = result.ok ? "접수되었습니다 (" + (result.receiptNo || "모의 접수") + ")" : "반려합니다. " + result.reason;
    showClerkBubble(clerkVerdictLine);
    syncBubblePositions();
    setPhase("result");
  }

  function resetStage(hasMandate = false) {
    clearOverlay();
    currentCamMode = "base";
    setPhase("idle");
    if (scene3d) {
      scene3d.setCameraMode("base");
      scene3d.setClerkStampPress(0);
      scene3d.setClerkHeadMotion(0, 0);
      scene3d.setMandateExtend(0, hasMandate);
      scene3d.setAgentPose(scene3d.WAIT_T, 0, hasMandate, false);
    }
    if (fallback2d) fallback2d.reset();
  }

  return { clearOverlay, syncBubblePositions, runMandateAppear, runWalkToCounter, runCounterDialogue, runStampCeremony, runEnterResultStage, resetStage };
}
