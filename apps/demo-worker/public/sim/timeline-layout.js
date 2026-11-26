function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function signsFloorAt(left, width, signRects) {
  let floorY = 12;
  const rRight = left + width;
  for (let i = 0; i < signRects.length; i++) {
    const s = signRects[i];
    if (s.name === "main" || s.name === "counter-2" || (rRight > s.left - 10 && left < s.right + 10)) {
      floorY = Math.max(floorY, Math.ceil(s.bottom + 10));
    }
  }
  return floorY;
}

export function syncBubblePositions({ bubbleLayer, resultPanel, scene3d, is2DMode, agentBubbleEl, clerkBubbleEl }) {
  if (!scene3d || is2DMode()) return;
  const anchors = scene3d.getOverlayAnchors();
  const stageW = bubbleLayer.clientWidth || 1824;
  const stageH = bubbleLayer.clientHeight || 780;
  const isDesktop = (window.innerWidth || stageW) > 1100;
  const panelVisible = Boolean(resultPanel && !resultPanel.hidden);
  const minX = isDesktop ? 396 : 6;
  const maxX = isDesktop ? (panelVisible ? stageW - 494 : stageW - 18) : stageW - 6;
  const tailPad = isDesktop ? 16 : 8;

  let aRect = null;
  let cRect = null;
  if (clerkBubbleEl && !clerkBubbleEl.hidden) {
    clerkBubbleEl.style.left = "0px";
    clerkBubbleEl.style.top = "0px";
  }
  if (agentBubbleEl && !agentBubbleEl.hidden) {
    agentBubbleEl.style.left = "0px";
    agentBubbleEl.style.top = "0px";
  }

  if (!isDesktop) {
    // At 1100px and below, pin the clerk bubble to the top edge of the stage so it does not cover the clerk's head.
    if (clerkBubbleEl && !clerkBubbleEl.hidden) {
      const cw = clerkBubbleEl.offsetWidth || 200;
      const ch = clerkBubbleEl.offsetHeight || 28;
      const cLeft = clamp(Math.round(Math.max(anchors.clerkHead.x - cw * 0.35, maxX - cw)), minX, Math.max(minX, maxX - cw));
      const maxClerkTop = Math.max(3, Math.floor(anchors.clerkCrown.y - ch - 4));
      const cTop = clamp(4, 3, maxClerkTop);
      const cTail = clamp(Math.round(anchors.clerkHead.x - cLeft - 5), 14, Math.max(14, cw - 18));
      clerkBubbleEl.style.setProperty("--tail-left", cTail + "px");
      cRect = { left: cLeft, top: cTop, w: cw, h: ch };
    }
    // On a narrow screen, place the agent bubble above the agent without covering the agent body or the clerk's face, and keep the tail inside the stage.
    if (agentBubbleEl && !agentBubbleEl.hidden) {
      const aw = agentBubbleEl.offsetWidth || 180;
      const ah = agentBubbleEl.offsetHeight || 42;
      const aLeft = clamp(Math.round(anchors.agentHead.x - aw + 22), minX, Math.max(minX, maxX - aw));
      const maxAgentTop = Math.max(4, Math.min(stageH - ah - tailPad, Math.floor(anchors.agentBodyTop.y - ah - 7)));
      const minAgentTop = cRect ? Math.min(maxAgentTop, cRect.top + cRect.h + 4) : 4;
      const aTop = clamp(Math.round(anchors.agentHead.y - ah - 4), minAgentTop, maxAgentTop);
      const aTail = clamp(Math.round(aLeft + aw - anchors.agentHead.x - 5), 12, Math.max(12, aw - 16));
      agentBubbleEl.style.setProperty("--tail-right", aTail + "px");
      aRect = { left: aLeft, top: aTop, w: aw, h: ah };
    }
  } else {
    if (clerkBubbleEl && !clerkBubbleEl.hidden) {
      const cw = clerkBubbleEl.offsetWidth || 260;
      const ch = clerkBubbleEl.offsetHeight || 50;
      const desiredLeft = Math.max(anchors.clerkHead.x + 18, anchors.clerkRight.x - cw * 0.35);
      const cLeft = clamp(Math.round(desiredLeft), minX, Math.max(minX, maxX - cw));
      const cFloor = signsFloorAt(cLeft, cw, anchors.signRects);
      const cTop = clamp(Math.round(Math.max(anchors.clerkHead.y - 2, cFloor)), cFloor, Math.max(cFloor, stageH - ch - tailPad));
      cRect = { left: cLeft, top: cTop, w: cw, h: ch };
    }

    if (agentBubbleEl && !agentBubbleEl.hidden) {
      const aw = agentBubbleEl.offsetWidth || 300;
      const ah = agentBubbleEl.offsetHeight || 54;
      const desiredLeft = anchors.agentHead.x - aw - 16;
      const aLeft = clamp(Math.round(desiredLeft), minX, Math.max(minX, maxX - aw));
      const aFloor = signsFloorAt(aLeft, aw, anchors.signRects);
      const desiredTop = anchors.agentHead.y - ah - 6;
      const aTop = clamp(Math.round(Math.max(desiredTop, aFloor)), aFloor, Math.max(aFloor, stageH - ah - tailPad));
      aRect = { left: aLeft, top: aTop, w: aw, h: ah };
    }

    // On desktop, if the two screen-space rects overlap, push the bubbles apart horizontally and vertically and keep them below the signs.
    if (aRect && cRect) {
      const gap = 14;
      const overlapX = Math.min(aRect.left + aRect.w, cRect.left + cRect.w) - Math.max(aRect.left, cRect.left) + gap;
      const overlapY = Math.min(aRect.top + aRect.h, cRect.top + cRect.h) - Math.max(aRect.top, cRect.top) + gap;
      if (overlapX > 0 && overlapY > 0) {
        const shiftLeft = Math.min(aRect.left - minX, Math.ceil(overlapX / 2));
        const shiftRight = Math.min(Math.max(0, maxX - cRect.w - cRect.left), overlapX - shiftLeft);
        aRect.left = clamp(aRect.left - shiftLeft, minX, Math.max(minX, maxX - aRect.w));
        cRect.left = clamp(cRect.left + shiftRight, minX, Math.max(minX, maxX - cRect.w));
        aRect.top = Math.max(aRect.top, signsFloorAt(aRect.left, aRect.w, anchors.signRects));
        cRect.top = Math.max(cRect.top, signsFloorAt(cRect.left, cRect.w, anchors.signRects));

        const remX = Math.min(aRect.left + aRect.w, cRect.left + cRect.w) - Math.max(aRect.left, cRect.left) + gap;
        const remY = Math.min(aRect.top + aRect.h, cRect.top + cRect.h) - Math.max(aRect.top, cRect.top) + gap;
        if (remX > 0 && remY > 0) {
          const cFloor = signsFloorAt(cRect.left, cRect.w, anchors.signRects);
          cRect.top = cFloor;
          const aFloor = Math.max(signsFloorAt(aRect.left, aRect.w, anchors.signRects), cRect.top + cRect.h + gap);
          aRect.top = clamp(aFloor, cFloor, Math.max(cFloor, stageH - aRect.h - tailPad));
        }
      }
    }
  }

  if (agentBubbleEl && aRect) {
    agentBubbleEl.style.left = Math.round(aRect.left) + "px";
    agentBubbleEl.style.top = Math.round(aRect.top) + "px";
  }
  if (clerkBubbleEl && cRect) {
    clerkBubbleEl.style.left = Math.round(cRect.left) + "px";
    clerkBubbleEl.style.top = Math.round(cRect.top) + "px";
  }
}
