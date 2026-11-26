# task-mandate
[English](README.md) | 한국어

사람(본인)이 AI 에이전트 하나에게 웹사이트 한 곳에서 과업 하나를 처리할 권한을 준다. 권한을 쓸 수 있는 기간과 행동 횟수를 제한한다. 웹사이트는 다른 곳에 문의할 필요 없이 이 권한을 직접 확인한다.

task-mandate는 기존 표준을 묶은 프로파일이다. 위임장은 SD-JWT VC로 만들고, 요청마다 IETF Web Bot Auth 태그를 붙인 RFC 9421 HTTP 메시지 서명을 단다. 키는 Ed25519다. 여기에 헤더 하나와 클레임 몇 개를 더했고, 그 목록은 명세에 있다.

상태: 실험용 연구 코드, 버전 0.1이다. 실제 서비스용이 아니다. 코드는 자동 검토만 거쳤다.

- 명세: [docs/SPEC.ko.md](docs/SPEC.ko.md) (영어 원문: [docs/SPEC.md](docs/SPEC.md))
- 데모: https://task-mandate-demo.repairer5812.workers.dev/sim (모의 민원 창구에 음성으로 위임한다. 실제 민원은 접수하지 않는다)
- [AI 에이전트로 테스트하기](examples/agent-sandbox/README.ko.md). npm 패키지로 공개 모의 API에 요청을 보냅니다.

## 작동 방식

1. 본인은 자기 키로 위임장에 서명한다. 위임장에는 에이전트의 공개 키, 웹사이트, 과업, 만료 시각을 적고, 필요하면 최대 행동 횟수도 적는다.
2. 에이전트는 위임장을 `Agent-Mandate` 헤더에 담아 보내고 요청마다 자기 키로 서명한다.
3. 웹사이트는 두 서명, 만료 시각, 과업, 행동 횟수를 검증한다. 그 뒤 요청을 허용하거나 사유 코드를 반환한다.

오래 걸리는 과업에는 유효기간이 짧은 위임장을 쓰고 계속 갱신한다. 갱신을 멈춘 뒤에도 마지막 위임장은 최대 조각 하나의 길이에 검증기의 시계 오차를 더한 시간 동안 쓸 수 있다(CLI의 600초 조각과 기본 시계 오차 30초로 630초). 웹사이트는 신뢰하는 발급자의 사람 보증서를 요구할 수 있고, 한 사람이 동시에 진행하는 과업을 하나로 제한할 수도 있다.

## 설치

```bash
npm i @task-mandate/core @task-mandate/agent
npm i @task-mandate/hono   # Hono 서버용
```

## 빠른 시작

아래 코드 블록 네 개를 한 파일에 넣어 실행한다.

### 1. 위임장 발급

```ts
import { issueMandate } from "@task-mandate/core";

async function newKeyPair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

const principal = await newKeyPair();
const agent = await newKeyPair();

const mandate = await issueMandate({
  principalKey: principal.priv,
  agentPublicKey: agent.pub,
  audience: "https://court.example",
  task: { type: "reserve", resource: "court-3" },
  limits: { maxActions: 1 },
  durationSec: 1800,
});
```

### 2. 에이전트로 요청 서명

```ts
import { signRequest } from "@task-mandate/agent";

const reserve = () =>
  new Request("https://court.example/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facility: "court-3" }),
  });

const signed = await signRequest(reserve(), { mandate, agentKey: agent.priv });
```

실제 서버에 요청할 때는 `mandatedFetch(url, init, { mandate, agentKey })`를 쓴다. 이 함수는 위임장의 서명, 대상 웹사이트, 만료 시각을 확인한 뒤 요청에 서명해 보낸다. `signRequest`는 서명만 한다.

### 3. 웹사이트에서 검증

```ts
import { memoryStore, verifyRequest } from "@task-mandate/core";

const decision = await verifyRequest(
  signed,
  { origin: "https://court.example" },
  { requireTask: { type: "reserve", resource: "court-3" } },
  memoryStore(),
);
if (decision.decision !== "allow") throw new Error(decision.code);
```

그 뒤 행동이 실패하면 `decision.refund()`를 호출해 행동 횟수를 되돌린다.

### 4. 또는 Hono 미들웨어 사용

```ts
import { Hono } from "hono";
import { type MandateEnv, taskMandate } from "@task-mandate/hono";

const guard = taskMandate({ origin: "https://court.example", store: memoryStore() });
const app = new Hono<MandateEnv>();
app.post("/reserve", guard({ requireTask: { type: "reserve", resource: "court-3" } }), (c) =>
  c.json({ ok: true, principal: c.get("mandate").principal }),
);

const first = await app.request(await signRequest(reserve(), { mandate, agentKey: agent.priv }));
const second = await app.request(await signRequest(reserve(), { mandate, agentKey: agent.priv }));
console.log(first.status, second.status); // 200 403 (LIMIT_EXCEEDED)
```

미들웨어는 challenge(기본값은 `NO_MANDATE`)이면 401, deny이면 403을 반환한다. 핸들러가 2xx가 아닌 상태 코드를 반환하거나 예외를 던지면 행동 횟수를 되돌린다.

## 패키지

| 패키지 | 내용 |
| --- | --- |
| `@task-mandate/core` | 위임장 발급과 검증, 사람 보증서, 갱신 계획, `Store` 인터페이스, `memoryStore`를 제공한다. 입출력 없이 WebCrypto만 쓴다. |
| `@task-mandate/agent` | `signRequest`, `mandatedFetch`, `Renewer`를 제공한다. 브라우저, Cloudflare Workers, Node.js에서 실행된다. |
| `@task-mandate/hono` | `taskMandate` 미들웨어를 제공한다. `hono`는 피어 의존성이다. |
| `@task-mandate/cli` | 키, 위임 발급, 조회, 갱신을 다루는 `tm` 명령을 제공한다. |
| `@task-mandate/store-conformance` | 직접 만든 `Store` 구현을 검사하는 Vitest 테스트 모음이다. |

## 사유 코드

검사에 실패하면 사유 코드 하나를 반환한다. `NO_MANDATE`는 기본적으로 `challenge`를 반환하고 나머지 코드는 모두 `deny`를 반환한다. 정확한 검사 조건과 순서는 [명세 6절](docs/SPEC.ko.md#6-검증)에 있다.

| 코드 | 의미 |
| --- | --- |
| `NO_MANDATE` | `Agent-Mandate` 헤더가 없다. |
| `BODY_TOO_LARGE` | 본문이 `maxBodyBytes`보다 크다. |
| `MANDATE_MALFORMED` | 위임장을 해석할 수 없거나 클레임이 유효하지 않다. |
| `MANDATE_SIG_INVALID` | 위임장 서명이 검증을 통과하지 못했다. |
| `ISSUER_NOT_TRUSTED` | 본인이 `trustedIssuers`에 없다. |
| `PERSON_REQUIRED`, `PERSON_INVALID` | 사람 보증서가 없거나 검증을 통과하지 못했다. |
| `AUD_MISMATCH` | 위임장이나 요청의 대상이 다른 웹사이트다. |
| `NOT_YET_VALID`, `EXPIRED`, `LIFETIME_TOO_LONG` | 유효 시간 범위가 맞지 않는다. |
| `SIG_MISSING`, `SIG_INVALID`, `KEY_MISMATCH` | 요청 서명이 없거나, 유효하지 않거나, 다른 키로 만든 서명이다. |
| `REPLAY` | 서명의 nonce가 이미 쓰였다. |
| `TASK_NOT_ALLOWED` | 과업이 경로와 맞지 않는다. |
| `LIMIT_EXCEEDED` | 남은 행동 횟수가 없다. |
| `SUPERSEDED` | 진행 중인 다른 과업이 이 사람의 사람 칸을 차지하고 있다([명세 7절](docs/SPEC.ko.md#7-행동-횟수-집계와-사람별-제한) 참고). |

## 배포 전 확인 사항

- 행동 횟수 제한과 과업 검사는 `requireTask`를 설정한 경로에만 적용된다. 이 설정이 없는 경로는 어떤 과업이든 받아들이고 행동 횟수도 세지 않는다.
- `trustedIssuers`는 기본적으로 비어 있다. 이때는 유효한 위임장이면 어느 키로 발급했든 받아들인다. 이 검증으로는 요청을 보낸 에이전트가 위임장에 적힌 에이전트인지만 확인할 수 있다. 위임장을 확인된 사람과 연결하려면 `trustedIssuers`나 `requirePerson`을 설정한다.
- `memoryStore()`는 한 프로세스 안에만 존재한다. 인스턴스를 여러 개 실행하려면 `@task-mandate/store-conformance`를 통과한 `Store`를 공유해야 한다.
- 웹사이트는 본인 키와 에이전트 키의 썸프린트를 볼 수 있다. 여러 웹사이트에 걸친 요청이 서로 연결되지 않게 하려면 웹사이트마다 다른 키를 쓴다.
- 온라인 철회 기능은 없다. 위임을 중단해도 현재 위임장은 만료될 때까지 쓸 수 있다.

취약점 제보 방법은 [SECURITY.md](SECURITY.md), 기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있다.

## 라이선스

[Apache-2.0](LICENSE) 라이선스를 쓴다. 데모의 외부 소프트웨어 고지는 [NOTICE](NOTICE)에 있다.
