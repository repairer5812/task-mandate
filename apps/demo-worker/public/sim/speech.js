import { formatSeoulTime } from "./constants.js";

const MAX_VISIBLE_SLIPS = 4;

export function createReceiptSlipElement(entry, indexFromTop, totalCount) {
  const isPass = Boolean(entry.ok);
  const li = document.createElement("li");
  li.className = "slip " + (isPass ? "is-pass" : "is-deny") + (indexFromTop === 0 ? " is-latest is-new" : "");
  li.dataset.code = entry.code ? entry.code : "ALLOW";

  const noEl = document.createElement("span");
  noEl.className = "slip-no";
  const noLabel = document.createElement("small");
  noLabel.textContent = "접수번호";
  noEl.append(noLabel, String(totalCount - indexFromTop).padStart(4, "0"));

  const timeEl = document.createElement("span");
  timeEl.className = "slip-time";
  timeEl.textContent = formatSeoulTime(entry.at);

  const body = document.createElement("div");
  body.className = "slip-body";
  const serviceEl = document.createElement("span");
  serviceEl.className = "slip-service";
  serviceEl.textContent = entry.title;
  const reasonEl = document.createElement("span");
  reasonEl.className = "slip-reason";
  reasonEl.textContent = entry.reason;
  body.append(serviceEl, reasonEl);

  const stampEl = document.createElement("span");
  stampEl.className = "stamp";
  stampEl.textContent = isPass ? "접수" : "반려";

  li.append(noEl, timeEl, body, stampEl);
  return li;
}

export function renderSlipList(slipListEl, slipHistory, awaitingLatestStamp = false) {
  const nodes = [];
  let latestStampEl = null;
  for (let i = 0; i < slipHistory.length; i++) {
    const li = createReceiptSlipElement(slipHistory[i], i, slipHistory.length);
    if (i >= MAX_VISIBLE_SLIPS) {
      li.hidden = true;
    }
    if (i === 0) {
      latestStampEl = li.querySelector(".stamp");
      if (awaitingLatestStamp && latestStampEl) {
        latestStampEl.classList.add("is-awaiting");
      }
    }
    nodes.push(li);
  }
  if (slipHistory.length > MAX_VISIBLE_SLIPS) {
    const foldedLi = document.createElement("li");
    foldedLi.className = "slip-folded";
    foldedLi.textContent = "이전 접수증 " + String(slipHistory.length - MAX_VISIBLE_SLIPS) + "장";
    nodes.push(foldedLi);
  }
  slipListEl.replaceChildren.apply(slipListEl, nodes);
  return latestStampEl;
}

export function initSpeechControl({ micBtn, micStatusEl, spokenTextEl, textInput, onStartStep, onFinalUtterance, isBusy }) {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recognizing = false;

  if (typeof SpeechRec === "function") {
    try {
      recognition = new SpeechRec();
      recognition.lang = "ko-KR";
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.addEventListener("start", () => {
        recognizing = true;
        micBtn.classList.add("is-listening");
        micStatusEl.textContent = "듣고 있습니다. 말씀해 주세요...";
      });

      recognition.addEventListener("result", (event) => {
        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const transcript = res[0] ? res[0].transcript : "";
          if (res.isFinal) finalText += transcript;
          else interim += transcript;
        }
        const shown = (finalText || interim).trim();
        if (shown) {
          spokenTextEl.textContent = '"' + shown + '"';
          textInput.value = shown;
        }
        if (finalText.trim()) {
          onFinalUtterance(finalText.trim());
        }
      });

      recognition.addEventListener("error", () => {
        recognizing = false;
        micBtn.classList.remove("is-listening");
        micStatusEl.textContent = "음성 인식을 쓸 수 없습니다. 아래 예문 단추나 입력칸을 써 주세요.";
      });

      recognition.addEventListener("end", () => {
        recognizing = false;
        micBtn.classList.remove("is-listening");
      });
    } catch {
      recognition = null;
    }
  } else {
    micStatusEl.textContent = "이 브라우저는 음성 인식을 지원하지 않습니다. 예문 단추나 입력칸을 써 주세요.";
  }

  micBtn.addEventListener("click", () => {
    if (isBusy()) return;
    if (!recognition) {
      micStatusEl.textContent = "음성 인식을 지원하지 않아 예문 단추나 글 입력칸으로 진행합니다.";
      textInput.focus();
      return;
    }
    try {
      if (recognizing) {
        recognition.stop();
      } else {
        onStartStep();
        recognition.start();
      }
    } catch {
      micStatusEl.textContent = "마이크를 시작할 수 없습니다. 아래 예문 단추를 눌러 주세요.";
    }
  });
}
