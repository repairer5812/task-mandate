# AI 에이전트로 Task Mandate 테스트하기

[English](README.md) | 한국어

AI 에이전트나 Node.js 프로그램으로 공개 모의 API에 서명 요청을 보낼 수 있습니다. 이 예제는 npm의 `@task-mandate/core`와 `@task-mandate/agent` 0.1.0을 사용합니다. Node.js 22 이상과 GitHub·npm·테스트 서버에 접속할 네트워크가 필요합니다. 계정이나 API 키 없이 실행할 수 있습니다.

```sh
git clone https://github.com/repairer5812/task-mandate.git
cd task-mandate/examples/agent-sandbox
npm ci --ignore-scripts
npm test
```

AI에게 맡길 때는 이 폴더의 GitHub 주소를 주고, 위 명령을 한 번 실행한 뒤 HTTP 결과 두 개를 알려 달라고 하면 됩니다.

- 임시 Ed25519 키 쌍 두 개를 생성하고, 위임자 공개키를 [공개 테스트 서버](https://task-mandate-demo.repairer5812.workers.dev)의 `POST /sim/attest`에 보내 모의 신원 증명서를 받습니다.
- 120초 동안 모의 신청을 한 번 허용하는 위임장을 발급해 `POST /civil/apply`에 요청을 두 번 보냅니다. 같은 위임장을 사용하고, 매 요청에 새 서명과 일회용 값(nonce)을 붙입니다.
- 첫 요청은 HTTP `200`과 `MO-`로 시작하는 모의 접수번호를 반환합니다. 두 번째는 HTTP `403`과 `LIMIT_EXCEEDED`를 반환합니다.

요청에는 모의 데이터만 사용하세요. 서버는 요청 결과를 공개 데모 로그에 기록합니다. 서버의 [API 문서](../../docs/DEMO.md)에서 서비스 목록과 IP별 요청 제한을 확인할 수 있습니다. HTTP `429`가 나오면 문서에 적힌 제한 시간이 지난 뒤 다시 실행하세요.
